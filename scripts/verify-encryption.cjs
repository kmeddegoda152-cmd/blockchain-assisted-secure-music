
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');

const client = new MongoClient(
  'mongodb://127.0.0.1:27017'
);

function sha256(data) {
  return '0x' + crypto.createHash('sha256')
    .update(data)
    .digest('hex');
}

function decrypt(key, data, ivHex, tagHex) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(
    Buffer.from(tagHex, 'hex')
  );

  return Buffer.concat([
    decipher.update(data),
    decipher.final()
  ]);
}

async function main() {
  const trackId = process.argv[2];

  if (!/^0x[0-9a-fA-F]{64}$/.test(trackId || '')) {
    throw new Error('Provide a valid Track ID.');
  }

  const masterKeyHex = process.env.MUSIC_MASTER_KEY;

  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex || '')) {
    throw new Error('Master key missing or invalid.');
  }

  const masterKey = Buffer.from(masterKeyHex, 'hex');
  let fileKey;
  let original;

  try {
    await client.connect();

    const db = client.db('secure_music_dapp');

    const record = await db.collection('tracks')
      .findOne({ trackId });

    if (!record) {
      throw new Error('Track not found in MongoDB.');
    }

    if (
      typeof record.storageFile !== 'string' ||
      path.basename(record.storageFile) !== record.storageFile
    ) {
      throw new Error('Invalid storage filename.');
    }

    const filePath = path.join(
      __dirname,
      '..',
      'private-audio',
      record.storageFile
    );

    const encrypted = await fs.readFile(filePath);

    // Test 1: Encrypted file integrity
    if (
      sha256(encrypted).toLowerCase() !==
      record.ciphertextSha256.toLowerCase()
    ) {
      throw new Error('Encrypted hash mismatch.');
    }

    console.log('PASS: Encrypted file hash verified');

    // Test 2: Unwrap file encryption key
    fileKey = decrypt(
      masterKey,
      Buffer.from(record.wrappedFileKey, 'hex'),
      record.wrapIv,
      record.wrapTag
    );

    if (fileKey.length !== 32) {
      throw new Error('Incorrect file key length.');
    }

    console.log('PASS: Encryption key recovered');

    // Test 3: Recover original audio
    original = decrypt(
      fileKey,
      encrypted,
      record.iv,
      record.authTag
    );

    if (
      sha256(original).toLowerCase() !==
      record.originalSha256.toLowerCase()
    ) {
      throw new Error('Original audio hash mismatch.');
    }

    console.log('PASS: Original audio decrypted');
    console.log('PASS: Original SHA-256 verified');

    // Test 4: Modify a copy of encrypted bytes
    const tampered = Buffer.from(encrypted);

    if (tampered.length === 0) {
      throw new Error('Encrypted file is empty.');
    }

    tampered[0] ^= 0x01;

    let rejected = false;

    try {
      decrypt(
        fileKey,
        tampered,
        record.iv,
        record.authTag
      );
    } catch {
      rejected = true;
    }

    if (!rejected) {
      throw new Error('Tampering was not detected.');
    }

    console.log('PASS: Tampered audio rejected');
    console.log('\nAll encryption tests passed!');

  } finally {
    if (fileKey) fileKey.fill(0);
    if (original) original.fill(0);
    masterKey.fill(0);
    await client.close();
  }
}

main().catch(error => {
  console.error('TEST FAILED:', error.message);
  process.exitCode = 1;
});
