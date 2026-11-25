"""Experimental alignment of a complete phone recording to its clean music reference.

Produces a 44.1-kHz mono WAV on the reference timeline for the existing
hidden_watermark.py detector. Does not read the watermark key or alter originals.
Requires numpy, scipy, soundfile, and ffmpeg.

A good alignment is NOT proof of watermark presence or who recorded the audio.
"""

import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, resample_poly, sosfilt

RATE = 44100
SEARCH_RATE = 11025
MAX_SECONDS = 300
PROBE_SECONDS = 0.45


def convert_to_wav(source: Path, dest: Path):
    if not source.is_file():
        raise FileNotFoundError(source)
    if not 0 < source.stat().st_size <= 150 * 1024 * 1024:
        raise ValueError(f"Invalid file size: {source}")

    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         "-y", "-i", str(source), "-vn", "-ar", str(RATE), "-ac", "1",
         "-c:a", "pcm_f32le", str(dest)],
        capture_output=True, text=True, timeout=180,
    )
    if p.returncode:
        raise RuntimeError(f"FFmpeg failed: {p.stderr.strip()[-1500:]}")

    audio, sr = sf.read(dest, dtype="float32")
    if sr != RATE or audio.ndim != 1:
        raise RuntimeError("Conversion did not create mono 44.1-kHz audio")
    if not 10 * RATE <= len(audio) <= MAX_SECONDS * RATE:
        raise ValueError("Use 10-second to 5-minute recordings for this experiment")
    if not np.all(np.isfinite(audio)):
        raise ValueError("Invalid samples in decoded audio")
    return audio


def filtered_for_search(x):
    # Band-limiting makes correlation less sensitive to bass rumble and hiss.
    down = resample_poly(x.astype(np.float64), 1, 4)
    filt = butter(3, (250, 2600), btype="bandpass", fs=SEARCH_RATE, output="sos")
    return sosfilt(filt, down)


def best_match(suspect, probe, low, high):
    """Normalized cross-correlation for probe starts within [low,high]."""
    n = len(probe)
    low = max(0, int(low))
    high = min(len(suspect) - n, int(high))
    if low > high:
        return None

    segment = suspect[low:high + n]
    numer = correlate(segment, probe, mode="valid", method="fft")

    # Moving window energy for correlation normalized to [-1,1].
    squares = segment * segment
    prefix = np.concatenate(([0.0], np.cumsum(squares)))
    window_energy = prefix[n:] - prefix[:-n]
    probe_energy = float(np.dot(probe, probe))
    denom = np.sqrt(np.maximum(window_energy * probe_energy, 1e-20))
    scores = numer / denom
    i = int(np.argmax(scores))
    return low + i, float(scores[i])


def align(suspect, reference):
    suspect_search = filtered_for_search(suspect)
    reference_search = filtered_for_search(reference)
    dur = len(reference) / RATE
    probe_samples = round(PROBE_SECONDS * SEARCH_RATE)

    if len(reference_search) < probe_samples * 2:
        raise ValueError("Clean reference is too short for alignment")

    # Multiple landmarks detect modest sample-clock drift over a song.
    starts = [max(0.0, min(2.0, dur * 0.10)),
              max(0.0, dur * 0.48 - 2),
              max(0.0, dur * 0.85 - 4)]
    starts = sorted(set(round(min(t, dur - PROBE_SECONDS - 0.25), 3) for t in starts))
    anchors = []
    for index, t in enumerate(starts):
        ref_pos = round(t * SEARCH_RATE)
        probe = reference_search[ref_pos:ref_pos + probe_samples]
        if float(np.sqrt(np.mean(probe ** 2))) < 1e-5:
            continue

        if not anchors:
            result = best_match(suspect_search, probe, 0, len(suspect_search))
        else:
            # Look near the expected location, allowing up to 1.5% drift
            # plus 1.5 seconds for matching error.
            initial_t = anchors[0][1] + (t - anchors[0][0])
            radius = (1.5 + 0.015 * abs(t - anchors[0][0])) * SEARCH_RATE
            center = initial_t * SEARCH_RATE
            result = best_match(suspect_search, probe, center - radius, center + radius)
        if result is None:
            continue
        location, score = result
        print(f"Anchor at music {t:.2f}s: phone {location / SEARCH_RATE:.2f}s, correlation {score:.3f}")
        if score >= 0.065:
            anchors.append((t, location / SEARCH_RATE, score))

    if not anchors:
        raise RuntimeError("No reliable alignment found. Check the reference and phone recording.")

    if len(anchors) >= 2:
        a = np.array([r for r, _, _ in anchors])
        b = np.array([s for _, s, _ in anchors])
        weights = np.array([score for _, _, score in anchors])
        # Fit phone_time = intercept + speed_ratio * reference_time.
        slope, intercept = np.polyfit(a, b, deg=1, w=weights)
        if not 0.985 <= slope <= 1.015:
            print("Warning: inconsistent landmarks; using nominal playback speed")
            slope = 1.0
            intercept = anchors[0][1] - anchors[0][0]
    else:
        slope = 1.0
        intercept = anchors[0][1] - anchors[0][0]
        print("Warning: only one reliable landmark; drift compensation unavailable")

    print(f"Estimated music start in phone recording: {intercept:.3f}s")
    print(f"Estimated phone/reference speed ratio: {slope:.6f}")

    n = len(reference)
    phone_positions = (intercept * RATE) + slope * np.arange(n, dtype=np.float64)
    covered = np.mean((phone_positions >= 0) & (phone_positions < len(suspect)))
    print(f"Reference timeline covered by phone recording: {covered * 100:.1f}%")
    if covered < 0.8:
        print("Warning: recording is incomplete; full-code detection may fail")

    aligned = np.interp(
        phone_positions,
        np.arange(len(suspect), dtype=np.float64),
        suspect.astype(np.float64),
        left=0.0, right=0.0
    ).astype(np.float32)
    return aligned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suspect", required=True, help="Phone recording .m4a, .mp3, or .wav")
    parser.add_argument("--reference", required=True, help="Unwatermarked original song")
    parser.add_argument("--output", required=True, help="New, aligned WAV for forensic detection")
    args = parser.parse_args()

    suspect_path = Path(args.suspect).resolve()
    reference_path = Path(args.reference).resolve()
    output_path = Path(args.output).resolve()
    if output_path in (suspect_path, reference_path):
        raise ValueError("Output must not overwrite either input")

    with tempfile.TemporaryDirectory(prefix="wm-align-") as tmp:
        tmp = Path(tmp)
        reference = convert_to_wav(reference_path, tmp / "reference.wav")
        suspect = convert_to_wav(suspect_path, tmp / "suspect.wav")
        aligned = align(suspect, reference)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, aligned, RATE, subtype="PCM_24")
    print(f"ALIGNED AUDIO SAVED: {output_path}")
    print("Now run hidden_watermark.py detect WITHOUT --reference.")


if __name__ == "__main__":
    main()
