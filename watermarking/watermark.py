
import argparse
import binascii
import hashlib
import os
from pathlib import Path

import numpy as np
import soundfile as sf


SAMPLE_RATE = 44100
WINDOW_SIZE = 4096
HOP = 2048

# 64-bit session code + 16-bit checksum.
PAYLOAD_BITS = 80
BINS_PER_GROUP = 2

# Experimental watermark strength.
STRENGTH = 0.32

WINDOW = np.hanning(WINDOW_SIZE)

FREQUENCY_BINS = np.arange(
    int(np.ceil(500 * WINDOW_SIZE / SAMPLE_RATE)),
    int(np.floor(6000 * WINDOW_SIZE / SAMPLE_RATE))
)

KEY_PATH = Path(__file__).with_name("watermark.key")


def load_key():
    if not KEY_PATH.exists():
        raise SystemExit(
            "Missing key. Run: "
            "python watermarking/watermark.py init-key"
        )

    key = bytes.fromhex(KEY_PATH.read_text().strip())

    if len(key) != 32:
        raise ValueError("Invalid watermark key")

    return key


def code_bits(code):
    if (
        len(code) != 16
        or any(
            char not in "0123456789abcdefABCDEF"
            for char in code
        )
    ):
        raise ValueError(
            "Session code must be 16 hexadecimal characters"
        )

    payload = bytes.fromhex(code)

    checksum = binascii.crc_hqx(
        payload, 0xffff
    ).to_bytes(2, "big")

    return np.unpackbits(
        np.frombuffer(
            payload + checksum,
            dtype=np.uint8
        )
    )


def locations(key, block_index):
    digest = hashlib.sha256(
        key + block_index.to_bytes(8, "big")
    ).digest()

    seed = int.from_bytes(digest[:8], "big")

    shuffled = np.random.default_rng(
        seed
    ).permutation(FREQUENCY_BINS)

    return shuffled[
        :PAYLOAD_BITS * 2 * BINS_PER_GROUP
    ].reshape(
        PAYLOAD_BITS, 2, BINS_PER_GROUP
    )


def read_audio(filename):
    audio, sample_rate = sf.read(
        filename,
        dtype="float64"
    )

    if sample_rate != SAMPLE_RATE or audio.ndim != 1:
        raise ValueError(
            "Input must be mono, 44,100 Hz WAV"
        )

    if len(audio) < SAMPLE_RATE * 10:
        raise ValueError(
            "Use at least 10 seconds of audio"
        )

    return audio


def embed(audio, code, key):
    bits = code_bits(code)

    signs = 2 * bits.astype(np.int16) - 1

    gain_a = np.exp(
        STRENGTH * signs
    )[:, None]

    gain_b = np.exp(
        -STRENGTH * signs
    )[:, None]

    pad = WINDOW_SIZE // 2

    source = np.pad(
        audio,
        (pad, pad),
        mode="reflect"
    )

    output = np.zeros_like(source)
    weights = np.zeros_like(source)

    count = 1 + (
        len(source) - WINDOW_SIZE
    ) // HOP

    for block in range(count):
        start = block * HOP

        segment = (
            source[start:start + WINDOW_SIZE]
            * WINDOW
        )

        spectrum = np.fft.rfft(segment)

        pairs = locations(key, block)

        # Embed the session bits by changing
        # relative energy in two frequency groups.
        spectrum[pairs[:, 0, :]] *= gain_a
        spectrum[pairs[:, 1, :]] *= gain_b

        reconstructed = np.fft.irfft(
            spectrum,
            n=WINDOW_SIZE
        ) * WINDOW

        output[
            start:start + WINDOW_SIZE
        ] += reconstructed

        weights[
            start:start + WINDOW_SIZE
        ] += WINDOW ** 2

    result = (
        output[pad:pad + len(audio)]
        / np.maximum(
            weights[pad:pad + len(audio)],
            1e-9
        )
    )

    peak = np.max(np.abs(result))

    if peak > 0.999:
        result *= 0.999 / peak

    return result


def detect(audio, key):
    pad = WINDOW_SIZE // 2

    source = np.pad(
        audio,
        (pad, pad),
        mode="reflect"
    )

    count = 1 + (
        len(source) - WINDOW_SIZE
    ) // HOP

    scores = np.zeros(
        PAYLOAD_BITS,
        dtype=np.float64
    )

    for block in range(count):
        start = block * HOP

        segment = (
            source[start:start + WINDOW_SIZE]
            * WINDOW
        )

        spectrum = np.fft.rfft(segment)

        energy = np.abs(spectrum) ** 2 + 1e-10

        pairs = locations(key, block)

        energy_a = np.sum(
            energy[pairs[:, 0, :]],
            axis=1
        )

        energy_b = np.sum(
            energy[pairs[:, 1, :]],
            axis=1
        )

        scores += (
            np.log(energy_a)
            - np.log(energy_b)
        )

    recovered_bits = (
        scores > 0
    ).astype(np.uint8)

    recovered = np.packbits(
        recovered_bits
    ).tobytes()

    payload = recovered[:8]

    received_checksum = int.from_bytes(
        recovered[8:10],
        "big"
    )

    expected_checksum = binascii.crc_hqx(
        payload,
        0xffff
    )

    if received_checksum != expected_checksum:
        return None

    return payload.hex()


def main():
    parser = argparse.ArgumentParser(
        description="Experimental audio watermarking"
    )

    sub = parser.add_subparsers(
        dest="command",
        required=True
    )

    sub.add_parser("init-key")

    embed_parser = sub.add_parser("embed")
    embed_parser.add_argument(
        "--input", required=True
    )
    embed_parser.add_argument(
        "--output", required=True
    )
    embed_parser.add_argument(
        "--code", required=True
    )

    detect_parser = sub.add_parser("detect")
    detect_parser.add_argument(
        "--input", required=True
    )

    args = parser.parse_args()

    if args.command == "init-key":
        KEY_PATH.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        try:
            fd = os.open(
                KEY_PATH,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600
            )

            with os.fdopen(fd, "w") as output:
                output.write(
                    os.urandom(32).hex() + "\n"
                )

            print(
                "Private watermark key created."
            )

        except FileExistsError:
            print(
                "Existing watermark key preserved."
            )

        return

    key = load_key()
    audio = read_audio(args.input)

    if args.command == "embed":

        if (
            Path(args.input).resolve()
            == Path(args.output).resolve()
        ):
            raise ValueError(
                "Input and output must be different files"
            )

        result = embed(
            audio,
            args.code,
            key
        )

        Path(args.output).parent.mkdir(
            parents=True,
            exist_ok=True
        )

        sf.write(
            args.output,
            result,
            SAMPLE_RATE,
            subtype="PCM_24"
        )

        distortion = np.sum(
            (audio - result) ** 2
        )

        snr = 10 * np.log10(
            np.sum(audio ** 2)
            / max(distortion, 1e-18)
        )

        print(
            "Watermarked audio saved:",
            args.output
        )

        print(
            f"Approximate SNR: {snr:.1f} dB"
        )

    elif args.command == "detect":

        recovered_code = detect(
            audio,
            key
        )

        if recovered_code:
            print("VALID WATERMARK DETECTED")
            print(
                "Session code:",
                recovered_code
            )
        else:
            print(
                "NO VALID WATERMARK DETECTED "
                "(experimental detector)"
            )


if __name__ == "__main__":
    main()
