
'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const networkProfile = require("./network-profile.cjs");

const {
  Contract,
  JsonRpcProvider,
  isHexString,
  getAddress
} = require('ethers');

const storageDirectory = path.join(
  __dirname,
  'private-audio'
);

const provider = new JsonRpcProvider(
  networkProfile.rpcUrl
);

// Encrypt bytes using AES-256-GCM
function encryptGcm(key, plaintext) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag()
  };
}

// Basic file signature validation for this prototype
function looksLikeAudio(bytes) {
  if (bytes.length < 128) return false;

  const prefix = bytes.toString('ascii', 0, 4);

  return (
    (
      prefix === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
    ) ||
    prefix === 'fLaC' ||
    prefix === 'OggS' ||
    bytes.toString('ascii', 0, 3) === 'ID3' ||
    (
      bytes[0] === 0xff &&
      (bytes[1] & 0xe0) === 0xe0
    )
  );
}

module.exports = function createMusicUploadRouter({
  currentSession,
  getDatabase
}) {

  const router = express.Router();

  router.post(
    '/upload',

    // Check authentication and origin before receiving audio
    (req, res, next) => {
      if (!currentSession(req)) {
        return res.status(401).json({
          error: 'Sign in securely first.'
        });
      }

      if (req.get('origin') !== 'http://127.0.0.1:3000') {
        return res.status(403).json({
          error: 'Invalid request origin.'
        });
      }

      next();
    },

    express.raw({
      type: 'application/octet-stream',
      limit: '20mb',
      inflate: false
    }),

    async (req, res) => {
      let savedFile;

      try {
        const session = currentSession(req);
        const trackId = req.get('x-track-id')?.trim();

        if (!session) {
          return res.status(401).json({
            error: 'Session expired.'
          });
        }

        if (!isHexString(trackId, 32)) {
          return res.status(400).json({
            error: 'Invalid Track ID.'
          });
        }

        if (
          !Buffer.isBuffer(req.body) ||
          !looksLikeAudio(req.body)
        ) {
          return res.status(415).json({
            error: 'Expected an MP3, WAV, FLAC or OGG audio file.'
          });
        }

        // Confirm the expected blockchain
        const network = await provider.getNetwork();

        if (network.chainId !== BigInt(networkProfile.chainId)) {
          throw new Error('Wrong blockchain network for the selected configuration.');
        }

        
    // Get the contract deployed on the selected blockchain.
    // Local and Sepolia each have their own contract address.
    const contractAddress = networkProfile.contractAddress;

    if (
      !contractAddress ||
      (await provider.getCode(contractAddress)) === '0x'
    ) {
      throw new Error(
        'No deployed contract found on the selected blockchain.'
      );
    }


        const contract = new Contract(
          contractAddress,
          [
            'function tracks(bytes32) view returns (address,bytes32,bool)'
          ],
          provider
        );

        // Read registered track data from the blockchain
        const track = await contract.tracks(trackId);

        if (!track[2]) {
          return res.status(404).json({
            error: 'Register this track first.'
          });
        }

        // Only the registering artist may upload
        if (
          getAddress(track[0]) !==
          getAddress(session.address)
        ) {
          return res.status(403).json({
            error: 'Only the registering artist can upload.'
          });
        }

        // Verify original file against registered SHA-256
        const originalHash = '0x' +
          crypto.createHash('sha256')
            .update(req.body)
            .digest('hex');

        if (
          track[1].toLowerCase() !==
          originalHash.toLowerCase()
        ) {
          return res.status(409).json({
            error: 'Audio differs from the blockchain-registered file.'
          });
        }

        const db = getDatabase();

        
    if (
      await db.collection('tracks').findOne({
        chainId: networkProfile.chainId,
        trackId
      })
    ) {
      return res.status(409).json({
        error: 'Encrypted audio already exists for this track on this blockchain.'
      });
    }


        // Read the private master encryption key
        const keyHex = process.env.MUSIC_MASTER_KEY;

        if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) {
          throw new Error(
            'MUSIC_MASTER_KEY is missing or invalid.'
          );
        }

        const masterKey = Buffer.from(keyHex, 'hex');

        // Generate a unique key for this track
        const fileKey = crypto.randomBytes(32);

        // Encrypt the actual music
        const encrypted = encryptGcm(
          fileKey,
          req.body
        );

        // Encrypt the file key using our master key
        const wrapped = encryptGcm(
          masterKey,
          fileKey
        );

        fileKey.fill(0);

        // Save encrypted audio outside public web routes
        const fileName = crypto.randomUUID() + '.enc';

        await fs.mkdir(storageDirectory, {
          recursive: true,
          mode: 0o700
        });

        savedFile = path.join(
          storageDirectory,
          fileName
        );

        await fs.writeFile(
          savedFile,
          encrypted.ciphertext,
          {
            flag: 'wx',
            mode: 0o600
          }
        );

        // Hash encrypted bytes for storage integrity
        const ciphertextSha256 = '0x' +
          crypto.createHash('sha256')
            .update(encrypted.ciphertext)
            .digest('hex');

        // Save metadata to MongoDB
        await db.collection('tracks').insertOne({
          trackId,
          chainId: networkProfile.chainId,
contractAddress: networkProfile.contractAddress,
          artistWallet: session.address,
          originalSha256: originalHash,
          ciphertextSha256,
          storageFile: fileName,
          originalSizeBytes: req.body.length,
          encryption: 'AES-256-GCM',
          iv: encrypted.iv.toString('hex'),
          authTag: encrypted.tag.toString('hex'),
          wrappedFileKey: wrapped.ciphertext.toString('hex'),
          wrapIv: wrapped.iv.toString('hex'),
          wrapTag: wrapped.tag.toString('hex'),
          status: 'ENCRYPTED',
          createdAt: new Date()
        });

        return res.status(201).json({
          message: 'Audio encrypted and stored successfully.',
          trackId,
          ciphertextSha256
        });

      } catch (error) {
        // Remove any file left behind by a failed database write
        if (savedFile) {
          await fs.unlink(savedFile).catch(() => {});
        }

        if (error.code === 11000) {
  console.error('MongoDB duplicate key diagnostic:', {
    index: error.index,
    keyPattern: error.keyPattern,
    keyValue: error.keyValue,
    message: error.message
  });

  return res.status(409).json({
    error: 'Track already stored.'
  });
}

        console.error(
          'Audio upload failed:',
          error.message
        );

        return res.status(500).json({
          error: 'Upload failed. Check server terminal.'
        });
      }
    }
  );

  return router;
};
