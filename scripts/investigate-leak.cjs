
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');

const ROOT = path.resolve(__dirname, '..');

const PYTHON = process.env.WATERMARK_PYTHON ||
  path.join(
    ROOT,
    '.venv-piper',
    process.platform === 'win32'
      ? 'Scripts/python.exe'
      : 'bin/python'
  );

const DETECTOR = path.join(
  ROOT,
  'watermarking',
  'hidden_watermark.py'
);

const MAX_INPUT_BYTES = 150 * 1024 * 1024;
const MAX_DECODED_BYTES = 250 * 1024 * 1024;

// Execute programs without using a shell.
function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout = (
        stdout + chunk.toString()
      ).slice(-12000);
    });

    child.stderr.on('data', chunk => {
      stderr = (
        stderr + chunk.toString()
      ).slice(-12000);
    });

    child.on('error', reject);

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(
          `${path.basename(program)} failed ` +
          `(${signal || code}):\n` +
          (stderr || stdout || 'No diagnostic output')
        ));
      }
    });
  });
}

async function validateFile(file, label) {
  const fullPath = path.resolve(file);
  const info = await fs.stat(fullPath);

  if (
    !info.isFile() ||
    info.size === 0 ||
    info.size > MAX_INPUT_BYTES
  ) {
    throw new Error(
      `${label} must be a nonempty file smaller than 150 MB.`
    );
  }

  return fullPath;
}

async function decodeToWav(sourcePath, destPath) {
  await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-vn',
    '-ar', '44100',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    destPath
  ]);

  const info = await fs.stat(destPath);

  if (
    !info.size ||
    info.size > MAX_DECODED_BYTES
  ) {
    throw new Error(
      'Decoded WAV is empty or exceeds 250 MB.'
    );
  }
}

async function main() {
  if (process.argv.length !== 4) {
    console.error(
      'Usage: node scripts/investigate-leak.cjs ' +
      '"suspect.mp3" "clean-original.wav"'
    );

    process.exitCode = 1;
    return;
  }

  const suspect = await validateFile(
    process.argv[2],
    'Suspected recording'
  );

  const reference = await validateFile(
    process.argv[3],
    'Clean reference'
  );

  // Create a fingerprint of the evidence file.
  const suspectHash = crypto
    .createHash('sha256')
    .update(await fs.readFile(suspect))
    .digest('hex');

  // Use a private temporary folder.
  const tempDir = await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'music-investigation-'
    )
  );

  try {
    if (process.platform !== 'win32') {
      await fs.chmod(tempDir, 0o700);
    }

    const suspectWav = path.join(
      tempDir,
      'suspect.wav'
    );

    const referenceWav = path.join(
      tempDir,
      'reference.wav'
    );

    console.log(
      'Preparing suspected recording and clean reference...'
    );

    await decodeToWav(suspect, suspectWav);
    await decodeToWav(reference, referenceWav);

    console.log(
      'Running experimental hidden-watermark detector...'
    );

    // Reuse the detector from Milestone 6D.
    const output = await run(PYTHON, [
      DETECTOR,
      'detect',
      '--input', suspectWav,
      '--reference', referenceWav
    ]);

    console.log(output.trim());

    console.log(
      'Suspected file SHA-256:',
      suspectHash
    );

    const match =
      /VALID WATERMARK DETECTED\s*\r?\nSession code:\s*([A-F0-9]{12})\b/i
      .exec(output);

    if (!match) {
      console.log(
        'No confirmed session match. ' +
        'This does not prove the file is clean.'
      );
      return;
    }

    const code = match[1].toUpperCase();

    // Query the existing MongoDB audit collection.
    const client = new MongoClient(
      process.env.MONGODB_URI ||
        'mongodb://127.0.0.1:27017',
      { serverSelectionTimeoutMS: 5000 }
    );

    try {
      await client.connect();

      const audit = await client
        .db('secure_music_dapp')
        .collection('playback_audit')
        .findOne(
          { watermarkCode: code },
          {
            projection: {
              _id: 0,
              watermarkCode: 1,
              trackId: 1,
              wallet: 1,
              createdAt: 1,
              sessionIdHash: 1
            }
          }
        );

      if (!audit) {
        console.log(
          'No matching playback_audit entry in MongoDB.'
        );

        console.log(
          'The code may belong to an offline test ' +
          'or another database.'
        );

        return;
      }

      console.log(
        '\nPOSSIBLE PLAYBACK SESSION MATCH'
      );

      console.log(
        'Watermark code:',
        audit.watermarkCode
      );

      console.log(
        'Track ID:',
        audit.trackId
      );

      console.log(
        'Authenticated wallet:',
        audit.wallet
      );

      console.log(
        'Session created:',
        audit.createdAt
      );

      console.log(
        'Session ID hash:',
        audit.sessionIdHash
      );

      console.log(
        '\nCaution: this record proves session issuance, ' +
        'not who recorded or leaked the audio.'
      );

    } finally {
      await client.close();
    }

  } finally {
    // Delete temporary decoded audio copies.
    await fs.rm(tempDir, {
      recursive: true,
      force: true
    });
  }
}

main().catch(error => {
  console.error(
    'INVESTIGATION FAILED:',
    error.message
  );

  process.exitCode = 1;
});
