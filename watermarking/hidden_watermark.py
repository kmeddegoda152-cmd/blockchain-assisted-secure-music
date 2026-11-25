"""Experimental keyed frequency-domain audio watermark for aligned excerpts.

Use a separate, private 32-byte key. A 12-digit hexadecimal playback code
(48 bits) plus 16-bit checksum is spread across short overlapping frames.
This is an evaluation prototype, not production-grade leak attribution.
"""

import argparse
import binascii
import hashlib
import os
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import correlate

SAMPLE_RATE = 44100
FRAME = 4096
HOP = 2048
STRENGTH = 0.24
PAYLOAD_BITS = 64  # 48-bit session code + 16-bit CRC
BINS_PER_GROUP = 2
BINS = np.arange(int(700 * FRAME / SAMPLE_RATE), int(6000 * FRAME / SAMPLE_RATE))
WINDOW = np.hanning(FRAME)
KEY_FILE = Path(__file__).with_name("watermark.key")


def load_key():
    if not KEY_FILE.exists():
        raise ValueError("Missing key. Run: python watermarking/hidden_watermark.py init-key")
    key = bytes.fromhex(KEY_FILE.read_text(encoding="utf-8").strip())
    if len(key) != 32:
        raise ValueError("Watermark key must be 32 bytes")
    return key


def payload_bits(code):
    if len(code) != 12 or any(c not in "0123456789abcdefABCDEF" for c in code):
        raise ValueError("Expected a 12-character hexadecimal session code")
    data = bytes.fromhex(code)
    crc = binascii.crc_hqx(data, 0xFFFF).to_bytes(2, "big")
    return np.unpackbits(np.frombuffer(data + crc, dtype=np.uint8))


def selection(key, block):
    digest = hashlib.sha256(key + block.to_bytes(8, "big")).digest()
    seed = int.from_bytes(digest[:8], "big")
    bins = np.random.default_rng(seed).permutation(BINS)
    return bins[:PAYLOAD_BITS * 2 * BINS_PER_GROUP].reshape(PAYLOAD_BITS, 2, BINS_PER_GROUP)


def read_wav(filename):
    audio, rate = sf.read(filename, dtype="float64", always_2d=True)
    if rate != SAMPLE_RATE or audio.shape[1] not in (1, 2):
        raise ValueError("Expected 44,100 Hz mono or stereo WAV")
    if len(audio) < SAMPLE_RATE * 10:
        raise ValueError("At least 10 seconds of music are needed")
    if not np.all(np.isfinite(audio)):
        raise ValueError("Invalid audio samples")
    return audio


def embed(audio, code, key):
    bits = payload_bits(code)
    signs = bits.astype(np.int8) * 2 - 1
    gain_a = np.exp(STRENGTH * signs)[:, None]
    gain_b = np.exp(-STRENGTH * signs)[:, None]

    pad = FRAME // 2
    source = np.pad(audio, ((pad, pad), (0, 0)), mode="reflect")
    out = np.zeros_like(source)
    weights = np.zeros(len(source))
    count = 1 + (len(source) - FRAME) // HOP

    for b in range(count):
        pos = b * HOP
        chunk = source[pos:pos + FRAME] * WINDOW[:, None]
        spectrum = np.fft.rfft(chunk, axis=0)
        selected = selection(key, b)
        spectrum[selected[:, 0, :], :] *= gain_a[:, :, None]
        spectrum[selected[:, 1, :], :] *= gain_b[:, :, None]
        recovered = np.fft.irfft(spectrum, n=FRAME, axis=0) * WINDOW[:, None]
        out[pos:pos + FRAME] += recovered
        weights[pos:pos + FRAME] += WINDOW ** 2

    marked = out[pad:pad + len(audio)] / np.maximum(weights[pad:pad + len(audio), None], 1e-8)
    peak = float(np.max(np.abs(marked)))
    if peak > 0.72:
        # Leave headroom for the spoken-cue/chime processor.
        marked *= 0.72 / peak
    return marked


def align_with_reference(suspect, reference):
    """Locate clean music after an intro voice; requires same-speed audio."""
    mono_ref = reference.mean(axis=1)
    mono_suspect = suspect.mean(axis=1)
    sr = SAMPLE_RATE
    probe_length = min(3 * sr, len(mono_ref))
    max_offset = min(30 * sr, len(mono_suspect) - len(reference))
    if max_offset < 0:
        raise ValueError("Suspect audio is shorter than the reference probe")
    step = 8
    probe = mono_ref[:probe_length:step]
    search = mono_suspect[:max_offset + probe_length:step]
    coarse = correlate(search, probe, mode="valid", method="fft")
    start = int(np.argmax(coarse)) * step
    best_start, best_score = start, -float('inf')
    for candidate in range(max(0, start - 24), min(max_offset, start + 24) + 1):
        section = mono_suspect[candidate:candidate + probe_length]
        score = float(np.dot(section, mono_ref[:probe_length]))
        if score > best_score:
            best_score, best_start = score, candidate
    if best_start + len(reference) > len(suspect):
        raise ValueError("Not enough aligned music in suspected audio")
    return suspect[best_start:best_start + len(reference)], best_start


def detect(audio, key):
    mono = audio.mean(axis=1)
    pad = FRAME // 2
    source = np.pad(mono, (pad, pad), mode="reflect")
    count = 1 + (len(source) - FRAME) // HOP
    scores = np.zeros(PAYLOAD_BITS, dtype=np.float64)
    for b in range(count):
        pos = b * HOP
        spectrum = np.fft.rfft(source[pos:pos + FRAME] * WINDOW)
        sel = selection(key, b)
        power = np.abs(spectrum) ** 2 + 1e-10
        a = power[sel[:, 0, :]].sum(axis=1)
        c = power[sel[:, 1, :]].sum(axis=1)
        scores += np.log(a) - np.log(c)
    binary = (scores > 0).astype(np.uint8)
    recovered = np.packbits(binary).tobytes()
    code, given_crc = recovered[:6], recovered[6:8]
    valid = int.from_bytes(given_crc, "big") == binascii.crc_hqx(code, 0xFFFF)
    return code.hex().upper() if valid else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-key")
    e = sub.add_parser("embed")
    e.add_argument("--input", required=True)
    e.add_argument("--output", required=True)
    e.add_argument("--code", required=True)
    d = sub.add_parser("detect")
    d.add_argument("--input", required=True)
    d.add_argument("--reference", help="Original clean WAV for aligning past spoken introduction")
    args = parser.parse_args()

    if args.command == "init-key":
        if KEY_FILE.exists():
            print("Existing watermark key preserved")
        else:
            KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(KEY_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(os.urandom(32).hex() + "\n")
            print("Private watermark key created")
        return

    key = load_key()
    if args.command == "embed":
        if Path(args.input).resolve() == Path(args.output).resolve():
            raise ValueError("Input and output must differ")
        source = read_wav(args.input)
        marked = embed(source, args.code, key)
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        sf.write(args.output, marked, SAMPLE_RATE, subtype="PCM_24")
        print("HIDDEN WATERMARK EMBEDDED")
        print("Session code:", args.code.upper())
        print("Output:", args.output)
    else:
        audio = read_wav(args.input)
        if args.reference:
            reference = read_wav(args.reference)
            audio, offset = align_with_reference(audio, reference)
            print("Music begins at approximately:", round(offset / SAMPLE_RATE, 3), "seconds")
        code = detect(audio, key)
        if code is None:
            print("NO VALID WATERMARK DETECTED")
        else:
            print("VALID WATERMARK DETECTED")
            print("Session code:", code)


if __name__ == "__main__":
    main()
