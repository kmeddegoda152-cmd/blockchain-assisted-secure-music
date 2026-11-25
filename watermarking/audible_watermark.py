
import argparse
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


BASE_DIR = Path(__file__).resolve().parent
VOICE_DIR = BASE_DIR / "voices"
VOICE_NAME = "en_US-lessac-medium"

# Beginning and ending voice announcements.
PAUSE_SECONDS = 0.35
VOICE_PEAK = 0.70

CHIME_DURATION = 0.75
CHIME_PEAK = 0.22
DUCK_DEPTH = 0.30


def generate_voice(code, target_rate):
    """Generate a spoken session code using Piper."""

    model = VOICE_DIR / f"{VOICE_NAME}.onnx"
    config = VOICE_DIR / f"{VOICE_NAME}.onnx.json"

    if not model.is_file() or not config.is_file():
        raise FileNotFoundError(
            "Piper voice files are missing."
        )

    speech = "Session " + " ".join(code)

    with tempfile.TemporaryDirectory() as folder:
        voice_path = Path(folder) / "voice.wav"

        command = [
            sys.executable,
            "-m", "piper",
            "--data-dir", str(VOICE_DIR),
            "-m", VOICE_NAME,
            "-f", str(voice_path),
            "--",
            speech,
        ]

        print("Generating speech:", speech)

        subprocess.run(command, check=True)

        voice, voice_rate = sf.read(
            voice_path,
            dtype="float32",
            always_2d=True,
        )

    if len(voice) == 0:
        raise ValueError("Piper produced empty audio.")

    voice = voice.mean(axis=1)

    if voice_rate != target_rate:
        divisor = math.gcd(voice_rate, target_rate)

        voice = resample_poly(
            voice,
            target_rate // divisor,
            voice_rate // divisor,
        )

    voice = np.asarray(voice, dtype=np.float32)

    peak = float(np.max(np.abs(voice)))

    if not np.isfinite(peak) or peak <= 0:
        raise ValueError("Generated voice is invalid.")

    return voice / peak * VOICE_PEAK


def build_announcement(voice, rate, channels):
    """Silence + spoken session code + silence."""

    gap = round(PAUSE_SECONDS * rate)

    silence = np.zeros(
        (gap, channels),
        dtype=np.float32,
    )

    spoken = np.repeat(
        voice[:, None],
        channels,
        axis=1,
    )

    return np.concatenate(
        [silence, spoken, silence],
        axis=0,
    )



def add_midpoint_chime(music, rate):
    """
    Add two short, gentle chimes at the midpoint.
    Music continues throughout both sounds.
    """

    count = max(2, round(CHIME_DURATION * rate))

    if count > len(music):
        raise ValueError(
            "Track is too short for the chime."
        )

    midpoint = len(music) // 2
    start = min(
        max(0, midpoint - count // 2),
        len(music) - count,
    )

    t = np.arange(count) / rate

    # Two short bell-like pulses.
    chime = np.zeros(count, dtype=np.float32)
    envelope = np.zeros(count, dtype=np.float32)

    for pulse_start in (0.05, 0.40):
        duration = 0.24

        active = (
            (t >= pulse_start)
            & (t < pulse_start + duration)
        )

        pulse_t = t[active] - pulse_start

        if len(pulse_t) == 0:
            continue

        # Smooth start and finish, avoiding clicks.
        shape = np.sin(
            np.linspace(0, np.pi, len(pulse_t))
        ) ** 2

        # Soft, bright two-tone chime.
        tone = (
            0.80 * np.sin(2 * np.pi * 880 * pulse_t)
            + 0.20 * np.sin(2 * np.pi * 1320 * pulse_t)
        )

        tone /= max(
            float(np.max(np.abs(tone))),
            1e-9,
        )

        chime[active] += (
            CHIME_PEAK * tone * shape
        ).astype(np.float32)

        envelope[active] = np.maximum(
            envelope[active],
            shape,
        )

    # Lower the music very slightly during
    # the chimes, but never stop it.
    music_gain = (
        1.0 - DUCK_DEPTH * envelope
    ).astype(np.float32)

    result = music.copy()

    section = result[start:start + count]

    result[start:start + count] = (
        section * music_gain[:, None]
        + chime[:, None]
    )

    print(
        "Middle chime applied at original music time:",
        round(start / rate, 2),
        "seconds"
    )

    print(
        "Chime peak:",
        round(float(np.max(np.abs(chime))), 4)
    )

    return result, start, count



def main():
    parser = argparse.ArgumentParser(
        description=(
            "Two spoken watermarks and one "
            "uninterrupted midpoint chime"
        )
    )

    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--code", required=True)

    args = parser.parse_args()

    code = args.code.upper()

    if not re.fullmatch(r"[A-Z0-9]{6,12}", code):
        raise ValueError(
            "Session code must contain "
            "6-12 letters or numbers."
        )

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if input_path == output_path:
        raise ValueError(
            "Input and output must be different."
        )

    music, sample_rate = sf.read(
        input_path,
        dtype="float32",
        always_2d=True,
    )

    if len(music) == 0:
        raise ValueError("Input audio is empty.")

    if not np.all(np.isfinite(music)):
        raise ValueError("Invalid audio samples.")

    channels = music.shape[1]

    # Generate voice for beginning and end.
    voice = generate_voice(code, sample_rate)

    announcement = build_announcement(
        voice,
        sample_rate,
        channels,
    )

    # Add the chime directly over the middle
    # of the original music.
    music_with_chime, chime_start, chime_frames = (
        add_midpoint_chime(music, sample_rate)
    )

    # ONLY TWO SPOKEN ANNOUNCEMENTS.
    # Music runs continuously in between.
    result = np.concatenate(
        [
            announcement,
            music_with_chime,
            announcement,
        ],
        axis=0,
    )

    expected_frames = (
        len(music) + 2 * len(announcement)
    )

    if len(result) != expected_frames:
        raise RuntimeError("Unexpected output length.")

   
    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Check audio amplitude before saving.
    peak = float(np.max(np.abs(result)))

    print("Generated audio peak:", round(peak, 4))

    if not np.isfinite(peak) or peak > 1.0:
        raise RuntimeError(
            f"Audio would clip (peak={peak:.3f}). "
            "Reduce CHIME_PEAK instead of saving."
        )

    sf.write(
        output_path,
        result,
        sample_rate,
        subtype="PCM_24",
    )


    # Verify the actual WAV file on disk.
    saved, saved_rate = sf.read(
        output_path,
        dtype="float32",
        always_2d=True,
    )

    cue = len(announcement)
    recovered_music = saved[cue:cue + len(music)]

    # Check the saved file contains exactly the
    # intended music-with-chime signal.
    valid = (
        saved_rate == sample_rate
        and len(saved) == expected_frames
        and np.allclose(
            recovered_music,
            music_with_chime,
            atol=2e-6,
            rtol=0,
        )
        and np.allclose(
            saved[:cue],
            announcement,
            atol=2e-6,
            rtol=0,
        )
        and np.allclose(
            saved[-cue:],
            announcement,
            atol=2e-6,
            rtol=0,
        )
    )

    # Outside the chime region, the music must
    # match the original signal.
    chime_end = chime_start + chime_frames

    valid = (
        valid
        and np.allclose(
            recovered_music[:chime_start],
            music[:chime_start],
            atol=2e-6,
            rtol=0,
        )
        and np.allclose(
            recovered_music[chime_end:],
            music[chime_end:],
            atol=2e-6,
            rtol=0,
        )
    )

    if not valid:
        raise RuntimeError(
            "Audio preservation verification failed."
        )

    print()
    print("HYBRID AUDIBLE WATERMARK CREATED")
    print("Session code:", code)
    print("Spoken announcements: 2")
    print("Middle chimes: 1")
    print("Music interrupted at midpoint: NO")
    print(
        "Chime duration:",
        round(chime_frames / sample_rate, 3),
        "seconds"
    )
    print(
        "Chime begins at playback time:",
        round(
            (cue + chime_start) / sample_rate,
            2,
        ),
        "seconds"
    )
    print(
        "Original music:",
        round(len(music) / sample_rate, 2),
        "seconds"
    )
    print(
        "Final playback:",
        round(len(saved) / sample_rate, 2),
        "seconds"
    )
    print("Audio preservation: VERIFIED")
    print("Output:", output_path)


if __name__ == "__main__":
    main()
