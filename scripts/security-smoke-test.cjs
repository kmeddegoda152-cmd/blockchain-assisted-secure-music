'use strict';

// Run from the main project directory:
// node scripts/security-smoke-test.cjs
// Uses Node.js 18+ built-in fetch and the project's existing mongodb package.
// All HTTP requests are unauthenticated and are read-only except for rejected POSTs.

const { MongoClient } = require('mongodb');

const BASE_URL = (process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DUMMY_SESSION = 'a'.repeat(48);
const DUMMY_TRACK = '0x' + '1'.repeat(64);

let passed = 0;
let failed = 0;
let skipped = 0;

async function check(name, pathname, options, allowedStatuses) {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    const ok = allowedStatuses.includes(response.status);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — HTTP ${response.status}`);
    if (!ok) {
      console.log(`      Expected one of: ${allowedStatuses.join(', ')}`);
      console.log(`      Content-Type: ${response.headers.get('content-type') || '(none)'}`);
    }
    if (response.body) await response.body.cancel();
    if (ok) passed++; else failed++;
  } catch (error) {
    console.log(`FAIL  ${name} — ${error.message}`);
    failed++;
  }
}

async function main() {
  console.log(`\nSecurity smoke test: ${BASE_URL}`);
  console.log('No browser session cookies are sent.\n');

  await check(
    'Unauthenticated playback-session creation denied',
    '/api/playback/start',
    {
      method: 'POST',
      headers: {
        Origin: BASE_URL,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trackId: DUMMY_TRACK })
    },
    [401]
  );

  await check(
    'Unauthenticated playback-session status denied',
    `/api/playback/status/${DUMMY_SESSION}`,
    {},
    [401]
  );

  await check(
    'Unauthenticated protected audio denied',
    `/api/playback/audio/${DUMMY_SESSION}`,
    { headers: { Range: 'bytes=0-1023' } },
    [401]
  );

  // Use an actual encrypted filename from MongoDB rather than a guessed name.
  let client;
  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    const records = await client.db('secure_music_dapp')
      .collection('tracks')
      .find({ storageFile: { $type: 'string' } })
      .project({ storageFile: 1, _id: 0 })
      .limit(3)
      .toArray();

    if (records.length === 0) {
      console.log('SKIP  Direct encrypted-file access — no storageFile record found');
      skipped++;
    }

    for (const record of records) {
      const filename = record.storageFile;
      if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        console.log('SKIP  Suspicious storage filename; inspect MongoDB manually');
        skipped++;
        continue;
      }
      await check(
        `Encrypted file not publicly served (${filename})`,
        `/private-audio/${encodeURIComponent(filename)}`,
        {},
        [401, 403, 404]
      );
    }
  } catch (error) {
    console.log(`SKIP  Direct encrypted-file access — MongoDB lookup failed: ${error.message}`);
    skipped++;
  } finally {
    if (client) await client.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (failed > 0) {
    console.log('Investigate failures before marking the security milestone complete.');
    process.exitCode = 1;
  } else {
    console.log('Unauthenticated-access smoke tests passed.');
    console.log('This does not replace authenticated authorization, revocation, or penetration testing.');
  }
}

main().catch(error => {
  console.error('TEST ERROR:', error);
  process.exitCode = 1;
});
