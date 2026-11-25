'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(PROJECT_ROOT, 'watermarking', 'evidence', 'reports');
const MAX_EVIDENCE_BYTES = 150 * 1024 * 1024;

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function main() {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/investigate-audible-leak.cjs "path/to/phone-recording.m4a" CODE');
    process.exitCode = 1;
    return;
  }

  const evidencePath = path.resolve(process.argv[2]);
  const watermarkCode = process.argv[3].trim().toUpperCase();

  if (!/^[A-F0-9]{12}$/.test(watermarkCode)) {
    throw new Error('The watermark code must be exactly 12 hexadecimal characters (0–9, A–F).');
  }

  const stat = await fsp.stat(evidencePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error('Evidence must be a nonempty file of at most 150 MB.');
  }

  const evidenceSha256 = await hashFile(evidencePath);
  const client = new MongoClient(
    process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    { serverSelectionTimeoutMS: 5000 }
  );

  let audit;
  try {
    await client.connect();
    audit = await client.db('secure_music_dapp')
      .collection('playback_audit')
      .findOne(
        { watermarkCode },
        { projection: {
          _id: 0, watermarkCode: 1, wallet: 1, trackId: 1,
          createdAt: 1, sessionIdHash: 1
        }}
      );
  } finally {
    await client.close();
  }

  const report = {
    reportId: crypto.randomUUID(),
    investigatedAt: new Date().toISOString(),
    evidence: {
      filename: path.basename(evidencePath),
      fullPath: evidencePath,
      sizeBytes: stat.size,
      sha256: evidenceSha256
    },
    audibleWatermark: {
      suppliedCode: watermarkCode,
      extractionMethod: 'Manually transcribed from the evidence audio by the investigator',
      independentlyVerifiedBySoftware: false
    },
    outcome: audit ? 'AUDIT_RECORD_FOUND' : 'NO_AUDIT_RECORD',
    matchingPlaybackSession: audit ? {
      watermarkCode: audit.watermarkCode,
      trackId: audit.trackId,
      wallet: audit.wallet,
      createdAt: audit.createdAt,
      sessionIdHash: audit.sessionIdHash
    } : null,
    limitations: [
      'The supplied spoken code was not independently verified by this program.',
      'An audit match links a code to a session issuance, not to the person who made or distributed the recording.',
      'A recording may be edited, copied or replayed; preserve the original evidence file.'
    ]
  };

  await fsp.mkdir(REPORT_DIR, { recursive: true, mode: 0o700 });
  const reportPath = path.join(REPORT_DIR, `${report.reportId}.json`);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx', mode: 0o600
  });

  console.log('\nAUDIBLE WATERMARK INVESTIGATION');
  console.log('Evidence file:', report.evidence.filename);
  console.log('Evidence SHA-256:', evidenceSha256);
  console.log('Transcribed session code:', watermarkCode);
  if (audit) {
    console.log('Result: POSSIBLE PLAYBACK SESSION MATCH');
    console.log('Track ID:', audit.trackId);
    console.log('Authenticated wallet:', audit.wallet);
    console.log('Session created:', audit.createdAt);
  } else {
    console.log('Result: NO MATCHING PLAYBACK AUDIT RECORD');
  }
  console.log('Report saved:', reportPath);
  console.log('Note: an audit match does not prove who recorded or leaked the audio.');
}

main().catch(error => {
  console.error('INVESTIGATION FAILED:', error.message);
  process.exitCode = 1;
});
