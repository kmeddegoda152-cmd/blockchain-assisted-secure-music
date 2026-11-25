"""Diagnostic candidate-code check for an already aligned phone recording.

Place beside hidden_watermark.py. Uses the SAME private watermark key, frequency
selection and payload format. Reports evidence strength; not a forensic proof.

Example:
 python watermarking/phone_candidate_check.py \
   --input watermarking/evidence/phone-aligned.wav \
   --reference watermarking/evidence/clean-reference.wav \
   --code A1B2C3D4E5F6
"""

import argparse
from pathlib import Path

import numpy as np
import hidden_watermark as wm

# The alignment tool has already compensated for the start and clock rate.
# A small timing mismatch can remain, so test several sample offsets.
PHASE_OFFSETS = range(-1536, 1537, 256)
MAX_ANALYSIS_FRAMES = 360


def frame_scores(audio, key, blocks, shift):
    mono = audio.mean(axis=1)
    pad = wm.FRAME * 2
    padded = np.pad(mono, (pad, pad), mode="reflect")
    scores = np.zeros(wm.PAYLOAD_BITS, dtype=np.float64)

    for b in blocks:
        start = pad - wm.FRAME // 2 + int(b) * wm.HOP + shift
        segment = padded[start:start + wm.FRAME]
        spectrum = np.fft.rfft(segment * wm.WINDOW)
        energy = np.abs(spectrum) ** 2 + 1e-10
        chosen = wm.selection(key, int(b))
        a = np.sum(energy[chosen[:, 0, :]], axis=1)
        c = np.sum(energy[chosen[:, 1, :]], axis=1)
        scores += np.log(a) - np.log(c)

    return scores / len(blocks)


def assess(scores, bits):
    signs = 2.0 * bits.astype(np.float64) - 1.0
    agreement = int(np.count_nonzero((scores > 0) == (bits > 0)))
    # Directional score, scaled so original audio level does not affect it.
    direction = float(np.dot(signs, scores) / (np.linalg.norm(scores) * np.sqrt(len(scores)) + 1e-12))
    return agreement, direction


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Already aligned phone WAV")
    parser.add_argument("--reference", required=True, help="Original clean 44.1-kHz WAV")
    parser.add_argument("--code", required=True, help="12-hex-character code issued to the collaborator")
    args = parser.parse_args()

    source = wm.read_wav(args.input)
    reference = wm.read_wav(args.reference)
    bits = wm.payload_bits(args.code)
    key = wm.load_key()

    if abs(len(source) - len(reference)) > wm.HOP:
        raise ValueError("Aligned recording and clean reference have different lengths. Rerun align_phone.py.")
    n = min(len(source), len(reference))
    source = source[:n]
    reference = reference[:n]

    max_block = (n - 2 * wm.FRAME) // wm.HOP
    if max_block <= 4:
        raise ValueError("Not enough aligned music to analyze")

    # Sample frames from across the track, preserving their exact block indexes.
    # Skipping blocks avoids long-running FFT searches on multi-minute songs.
    blocks = np.unique(np.linspace(3, max_block, min(MAX_ANALYSIS_FRAMES, max_block - 2), dtype=int))
    ref_scores = frame_scores(reference, key, blocks, 0)

    best = {"mode": None, "offset": None, "agreement": -1, "direction": -10.0}
    results = []
    for shift in PHASE_OFFSETS:
        phone_scores = frame_scores(source, key, blocks, shift)
        for mode, scores in (("raw", phone_scores), ("reference-adjusted", phone_scores - ref_scores)):
            agreement, direction = assess(scores, bits)
            results.append((agreement, direction, shift, mode))
            if (direction, agreement) > (best["direction"], best["agreement"]):
                best = {"mode": mode, "offset": shift, "agreement": agreement, "direction": direction}

    control_agreement, control_direction = assess(ref_scores, bits)

    print("PHONE WATERMARK CANDIDATE DIAGNOSTIC")
    print("Code being tested:", args.code.upper())
    print("Analyzed frames:", len(blocks))
    print(f"Clean-reference control: {control_agreement}/64 bit signs match (direction={control_direction:.3f})")
    print("Best phone alignment: offset", best["offset"], "samples,", best["mode"])
    print(f"Best phone result: {best['agreement']}/64 bit signs match (direction={best['direction']:.3f})")
    print("Top candidate settings:")
    for match, direction, shift, mode in sorted(results, key=lambda x: (x[1], x[0]), reverse=True)[:3]:
        print(f"  {mode}: offset={shift} samples, {match}/64 matches, direction={direction:.3f}")
    print("\nInterpretation:")
    print("  Around 32/64 matches is close to random guessing; substantially more can be encouraging.")
    print("  This is a known-code diagnostic, not blind recovery or proof of a leak.")
    print("  A negative result does not prove that no watermark was embedded.")
    print("  Test clean and unrelated recordings too, before drawing conclusions.")


if __name__ == "__main__":
    main()
