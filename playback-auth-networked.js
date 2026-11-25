'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  JsonRpcProvider,
  Contract,
  getAddress,
  isHexString
} = require('ethers');
const { createWatermarkedMp3 } = require('./playback-watermark.cjs');

// Local is the default. Sepolia is enabled only when MUSIC_CHAIN=sepolia.
// The RPC endpoint and contract address come from network-profile.cjs.
const networkProfile = require('./network-profile.cjs');
if (!networkProfile.rpcUrl) {
  throw new Error(`Missing RPC URL for ${networkProfile.network}.`);
}
const provider = new JsonRpcProvider(networkProfile.rpcUrl);

// Legacy MongoDB tracks without chainId belong ONLY to Hardhat Local.
// Sepolia cannot access an encrypted file unless it has a Sepolia-specific record.
function trackQuery(trackId) {
  if (networkProfile.chainId === 31337) {
    return {
      trackId,
      $or: [{ chainId: 31337 }, { chainId: { $exists: false } }]
    };
  }
  return { trackId, chainId: networkProfile.chainId };
}

const PLAYBACK_LIFETIME_MS = 10 * 60 * 1000;
const MAX_WORK_SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_RANGE_BYTES = 256 * 1024;

// Prototype-only storage: restarting Node.js invalidates these sessions.
const playbackSessions = new Map();

const CONTRACT_ABI = [
  'function tracks(bytes32) view returns (address,bytes32,bool)',
  'function checkAccess(bytes32,address) view returns (bool)'
];

function sha256(data) {
  return '0x' + crypto.createHash('sha256').update(data).digest('hex');
}

function readHex(value, size, label) {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^[a-fA-F0-9]{${size * 2}}$`).test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return Buffer.from(value, 'hex');
}

function decryptAesGcm(key, ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function decryptStoredTrack(record) {
  if (
    !record ||
    record.status !== 'ENCRYPTED' ||
    record.encryption !== 'AES-256-GCM'
  ) {
    throw new Error('Encrypted track unavailable.');
  }

  // The encrypted filename must be a UUID, not a client-supplied path.
  if (
    typeof record.storageFile !== 'string' ||
    !/^[a-f0-9-]{36}\.enc$/i.test(record.storageFile) ||
    path.basename(record.storageFile) !== record.storageFile
  ) {
    throw new Error('Invalid encrypted storage filename.');
  }

  const masterKey = readHex(process.env.MUSIC_MASTER_KEY, 32, 'master key');
  let fileKey;

  try {
    const ciphertext = await fs.readFile(
      path.join(__dirname, 'private-audio', record.storageFile)
    );

    if (sha256(ciphertext).toLowerCase() !==
        String(record.ciphertextSha256).toLowerCase()) {
      throw new Error('Encrypted file hash mismatch.');
    }

    fileKey = decryptAesGcm(
      masterKey,
      readHex(record.wrappedFileKey, 32, 'wrapped file key'),
      readHex(record.wrapIv, 12, 'key wrapping IV'),
      readHex(record.wrapTag, 16, 'key wrapping tag')
    );

    if (fileKey.length !== 32) {
      throw new Error('Invalid recovered file key length.');
    }

    const plaintext = decryptAesGcm(
      fileKey,
      ciphertext,
      readHex(record.iv, 12, 'file IV'),
      readHex(record.authTag, 16, 'file authentication tag')
    );

    if (sha256(plaintext).toLowerCase() !==
        String(record.originalSha256).toLowerCase()) {
      plaintext.fill(0);
      throw new Error('Original audio hash mismatch.');
    }

    return plaintext;
  } finally {
    if (fileKey) fileKey.fill(0);
    masterKey.fill(0);
  }
}

function expired(playback, now = Date.now()) {
  return (
    now >= playback.expiresAt ||
    now >= playback.createdAt + MAX_WORK_SESSION_MS
  );
}

// Remove expired entries during new requests to avoid an unbounded session map.
function purgeExpiredSessions() {
  const now = Date.now();
  for (const [id, playback] of playbackSessions) {
    if (expired(playback, now)) playbackSessions.delete(id);
  }
}

module.exports = function createPlaybackRouter({ currentSession, getDatabase }) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  async function authorizePlayback(trackId, wallet) {
    const record = await getDatabase()
      .collection('tracks')
      .findOne(trackQuery(trackId));

    if (!record || record.status !== 'ENCRYPTED') {
      return { allowed: false, status: 404, error: 'Encrypted track not found.' };
    }

    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(networkProfile.chainId)) {
      throw new Error('RPC returned a different blockchain than configured.');
    }

    const contractAddress = networkProfile.contractAddress;
    if (await provider.getCode(contractAddress) === '0x') {
      return { allowed: false, status: 503, error: 'Smart contract is not deployed.' };
    }

    const contract = new Contract(contractAddress, CONTRACT_ABI, provider);
    const [onChainArtist, onChainHash, exists] = await contract.tracks(trackId);

    // The Mongo record must belong to the current on-chain track.
    if (
      !exists ||
      !record.artistWallet ||
      !record.originalSha256 ||
      getAddress(onChainArtist) !== getAddress(record.artistWallet) ||
      onChainHash.toLowerCase() !== String(record.originalSha256).toLowerCase()
    ) {
      return {
        allowed: false,
        status: 409,
        error: 'Blockchain and database track records do not match.'
      };
    }

    const hasAccess = await contract.checkAccess(trackId, wallet);
    if (!hasAccess) {
      return { allowed: false, status: 403, error: 'Blockchain permission denied.' };
    }

    return { allowed: true };
  }

  // POST /api/playback/start
  router.post('/start', async (req, res) => {
    const authSession = currentSession(req);
    if (!authSession) {
      return res.status(401).json({ error: 'Please sign in securely.' });
    }

    if (req.get('origin') !== 'http://127.0.0.1:3000') {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }

    const trackId = req.body?.trackId;
    if (!isHexString(trackId, 32)) {
      return res.status(400).json({ error: 'Invalid Track ID.' });
    }

    try {
      const decision = await authorizePlayback(trackId, authSession.address);
      if (!decision.allowed) {
        return res.status(decision.status).json({ error: decision.error });
      }

      purgeExpiredSessions();

      const sessionId = crypto.randomBytes(24).toString('hex');
      const createdAt = Date.now();
      const expiresAt = createdAt + PLAYBACK_LIFETIME_MS;

      // Audit codes are different from secret playback session IDs.
      const auditCollection = getDatabase().collection('playback_audit');
      await auditCollection.createIndex({ watermarkCode: 1 }, { unique: true });

      let watermarkCode;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = crypto.randomBytes(6).toString('hex').toUpperCase();
        try {
          await auditCollection.insertOne({
            watermarkCode: candidate,
            sessionIdHash: crypto.createHash('sha256')
              .update(sessionId).digest('hex'),
            trackId,
            wallet: authSession.address,
            chainId: networkProfile.chainId,
            contractAddress: networkProfile.contractAddress,
            createdAt: new Date(createdAt)
          });
          watermarkCode = candidate;
          break;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }

      if (!watermarkCode) throw new Error('Unable to allocate watermark code.');

      playbackSessions.set(sessionId, {
        trackId,
        wallet: authSession.address,
        authSession,
        createdAt,
        expiresAt,
        watermarkCode,
        personalizedAudio: null,
        audioPromise: null
      });

      return res.status(201).json({
        message: 'Playback session authorized.',
        sessionId,
        trackId,
        watermarkCode,
        expiresAt: new Date(expiresAt).toISOString()
      });
    } catch (error) {
      console.error('Playback start:', error);
      return res.status(503).json({
        error: 'Playback authorization service unavailable.'
      });
    }
  });

  // GET /api/playback/status/:sessionId
  // Successful status checks renew a lease, but never beyond eight hours.
  router.get('/status/:sessionId', async (req, res) => {
    const authSession = currentSession(req);
    if (!authSession) {
      return res.status(401).json({ error: 'Please sign in securely.' });
    }

    const sessionId = req.params.sessionId;
    if (!/^[a-f0-9]{48}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid playback session ID.' });
    }

    const playback = playbackSessions.get(sessionId);
    if (!playback) {
      return res.status(404).json({ error: 'Playback session not found.' });
    }

    if (expired(playback)) {
      playbackSessions.delete(sessionId);
      return res.status(410).json({ error: 'Playback session expired.' });
    }

    if (playback.authSession !== authSession) {
      return res.status(403).json({ error: 'Playback belongs to another login session.' });
    }

    try {
      const decision = await authorizePlayback(playback.trackId, authSession.address);
      if (!decision.allowed) {
        playbackSessions.delete(sessionId);
        return res.status(decision.status).json({ error: decision.error });
      }

      // The account could be revoked while RPC was pending. The contract
      // query reports the state when processed, not an atomic playback lock.
      if (expired(playback) || playbackSessions.get(sessionId) !== playback) {
        playbackSessions.delete(sessionId);
        return res.status(410).json({ error: 'Playback session expired.' });
      }

      playback.expiresAt = Math.min(
        Date.now() + PLAYBACK_LIFETIME_MS,
        playback.createdAt + MAX_WORK_SESSION_MS
      );

      return res.json({
        authorized: true,
        trackId: playback.trackId,
        expiresAt: new Date(playback.expiresAt).toISOString()
      });
    } catch (error) {
      console.error('Playback status:', error);
      return res.status(503).json({ error: 'Unable to verify current permissions.' });
    }
  });

  // GET /api/playback/audio/:sessionId
  // This is the ONLY route that should deliver decrypted playback audio.
  router.get('/audio/:sessionId', async (req, res) => {
    const authSession = currentSession(req);
    if (!authSession) {
      return res.status(401).json({ error: 'Sign in first.' });
    }

    const sessionId = req.params.sessionId;
    if (!/^[a-f0-9]{48}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid playback session ID.' });
    }

    const playback = playbackSessions.get(sessionId);
    if (!playback) {
      return res.status(404).json({ error: 'Playback session not found.' });
    }

    if (expired(playback)) {
      playbackSessions.delete(sessionId);
      return res.status(410).json({ error: 'Playback session expired.' });
    }

    if (
      playback.authSession !== authSession ||
      playback.wallet !== authSession.address
    ) {
      return res.status(403).json({ error: 'Wrong login session.' });
    }

    try {
      const decision = await authorizePlayback(playback.trackId, authSession.address);
      if (!decision.allowed) {
        playbackSessions.delete(sessionId);
        return res.status(decision.status).json({ error: decision.error });
      }

      if (!/^[A-F0-9]{12}$/.test(playback.watermarkCode || '')) {
        throw new Error('Playback session has no valid watermark code.');
      }

      // Generate once per session, then reuse the exact same marked audio
      // for all subsequent byte-range requests and seeks.
      if (!playback.personalizedAudio) {
        if (!playback.audioPromise) {
          playback.audioPromise = (async () => {
            const record = await getDatabase()
              .collection('tracks')
              .findOne(trackQuery(playback.trackId));

            const cleanAudio = await decryptStoredTrack(record);
            try {
              return await createWatermarkedMp3(
                cleanAudio,
                playback.watermarkCode
              );
            } finally {
              cleanAudio.fill(0);
            }
          })();
        }

        try {
          playback.personalizedAudio = await playback.audioPromise;
        } finally {
          playback.audioPromise = null;
        }
      }

      if (expired(playback) || playbackSessions.get(sessionId) !== playback) {
        playbackSessions.delete(sessionId);
        return res.status(410).json({ error: 'Playback session expired.' });
      }

      // Re-check permission after the time-consuming watermark processing.
      const finalDecision = await authorizePlayback(playback.trackId, authSession.address);
      if (!finalDecision.allowed) {
        playbackSessions.delete(sessionId);
        return res.status(finalDecision.status).json({ error: finalDecision.error });
      }

      const audio = playback.personalizedAudio;
      if (!audio || !audio.length) throw new Error('Empty watermarked audio.');
      const size = audio.length;

      res.set({
        'Cache-Control': 'private, no-store',
        'Pragma': 'no-cache',
        'Vary': 'Cookie',
        'Referrer-Policy': 'no-referrer',
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/mpeg'
      });

      const requestedRange = req.headers.range;
      if (!requestedRange) {
        // HTML5 media players can send either ordinary or range requests.
        // Both routes send ONLY watermarked MP3 data.
        return res.status(200).send(audio);
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
      if (!match || (!match[1] && !match[2])) {
        res.set('Content-Range', `bytes */${size}`);
        return res.sendStatus(416);
      }

      let start;
      let end;

      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.set('Content-Range', `bytes */${size}`);
          return res.sendStatus(416);
        }
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 || start >= size || end < start
      ) {
        res.set('Content-Range', `bytes */${size}`);
        return res.sendStatus(416);
      }

      end = Math.min(end, start + MAX_RANGE_BYTES - 1, size - 1);
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
      return res.send(audio.subarray(start, end + 1));
    } catch (error) {
      console.error('Protected audio delivery:', error);
      if (res.headersSent) return;
      return res.status(503).json({ error: 'Audio unavailable.' });
    }
  });

  return router;
};
