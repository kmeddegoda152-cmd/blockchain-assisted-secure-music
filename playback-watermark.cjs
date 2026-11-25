'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PYTHON = process.env.WATERMARK_PYTHON || path.join(
  ROOT, '.venv-piper', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const HIDDEN_SCRIPT = path.join(ROOT, 'watermarking', 'hidden_watermark.py');
const AUDIBLE_SCRIPT = path.join(ROOT, 'watermarking', 'audible_watermark.py');

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_WAV_BYTES = 70 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

function runProcess(program, args, inputBytes = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      timeout: 180000,
      stdio: [inputBytes ? 'pipe' : 'ignore', 'ignore', 'pipe']
    });

    let errorText = '';
    child.stderr.on('data', chunk => {
      errorText = (errorText + chunk.toString()).slice(-3000);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${path.basename(program)} failed: ` +
        (errorText || `exit ${code}, signal ${signal}`)
      ));
    });

    if (inputBytes) {
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin.end(inputBytes);
    }
  });
}

async function createWatermarkedMp3(originalBytes, code) {
  if (!Buffer.isBuffer(originalBytes) ||
      originalBytes.length === 0 ||
      originalBytes.length > MAX_INPUT_BYTES) {
    throw new Error('Audio exceeds prototype limits.');
  }
  if (!/^[A-F0-9]{12}$/.test(code)) {
    throw new Error('Invalid session watermark code.');
  }

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-music-wm-'));
  const cleanWav = path.join(folder, 'clean.wav');
  const hiddenWav = path.join(folder, 'hidden.wav');
  const audibleWav = path.join(folder, 'audible.wav');
  const markedMp3 = path.join(folder, 'marked.mp3');

  try {
    if (process.platform !== 'win32') await fs.chmod(folder, 0o700);

    // Decode the AES-GCM-authenticated audio bytes to stereo WAV.
    await runProcess('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'pipe:0', '-vn', '-ar', '44100', '-ac', '2',
      '-c:a', 'pcm_s16le', cleanWav
    ], originalBytes);

    const cleanInfo = await fs.stat(cleanWav);
    if (cleanInfo.size === 0 || cleanInfo.size > MAX_WAV_BYTES) {
      throw new Error('Decoded audio exceeds prototype limits.');
    }

    // First: hidden, session-specific frequency-domain watermark.
    // A failure MUST reject playback, never fall back to clean audio.
    await runProcess(PYTHON, [
      HIDDEN_SCRIPT, 'embed',
      '--input', cleanWav,
      '--output', hiddenWav,
      '--code', code
    ]);

    // Second: spoken beginning/end identifiers and midpoint double chime.
    await runProcess(PYTHON, [
      AUDIBLE_SCRIPT,
      '--input', hiddenWav,
      '--output', audibleWav,
      '--code', code
    ]);

    // Third: encode only the doubly watermarked version for playback.
    await runProcess('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', audibleWav, '-vn', '-map_metadata', '-1',
      '-c:a', 'libmp3lame', '-b:a', '192k', markedMp3
    ]);

    const info = await fs.stat(markedMp3);
    if (info.size === 0 || info.size > MAX_OUTPUT_BYTES) {
      throw new Error('Watermarked output exceeds prototype limits.');
    }
    return await fs.readFile(markedMp3);
  } finally {
    // Temporary plain audio is not secure-erased by deleting files.
    await fs.rm(folder, { recursive: true, force: true });
  }
}

module.exports = { createWatermarkedMp3 };
