#!/usr/bin/env python3
"""Generate a camera-like Y4M face clip for the browser test."""

import argparse
from io import BytesIO
import os
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

import numpy as np
from PIL import Image

WIDTH = 640
HEIGHT = 480
FPS = 30
DURATION_SECONDS = 40
ASTRONAUT_URL = (
    "https://raw.githubusercontent.com/scikit-image/scikit-image/"
    "v0.24.0/skimage/data/astronaut.png"
)


def make_face_frame(base, skin_mask, frame, bpm, rng):
    time = frame / FPS
    phase = 2 * np.pi * bpm * time / 60
    pulse = np.sin(phase)
    image = base.astype(np.float32).copy()
    for channel, ratio in enumerate((0.003, 0.006, 0.002)):
        image[:, :, channel][skin_mask] *= 1 + ratio * pulse
    image += rng.normal(0, 0.08, image.shape).astype(np.float32)
    image = np.clip(image, 0, 255).astype(np.uint8)

    jitter_x, jitter_y = rng.integers(-2, 3, size=2)
    if jitter_x or jitter_y:
        image = np.roll(image, (jitter_y, jitter_x), axis=(0, 1))
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bpm", type=float, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    image_source = os.environ.get("NADI_FACE_IMAGE")
    if image_source:
        source = Image.open(image_source).convert("RGB")
    else:
        with urlopen(ASTRONAUT_URL, timeout=30) as response:
            source = Image.open(BytesIO(response.read())).convert("RGB")
    source = source.resize((480, 480), Image.Resampling.LANCZOS)
    base = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    base[:, 80:560] = np.asarray(source)

    yy, xx = np.ogrid[:HEIGHT, :WIDTH]
    face_ellipse = ((xx - 302) / 68) ** 2 + ((yy - 120) / 86) ** 2 <= 1
    red, green, blue = base.transpose(2, 0, 1)
    skin_tone = (red > 45) & (green > 25) & (blue > 15) & (red > green * 1.02) & (green > blue * 1.02)
    skin_mask = face_ellipse & skin_tone
    if int(skin_mask.sum()) < 500:
        raise RuntimeError("The sample face skin mask is unexpectedly small")

    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{WIDTH}x{HEIGHT}",
        "-framerate",
        str(FPS),
        "-i",
        "-",
        "-frames:v",
        str(DURATION_SECONDS * FPS),
        "-pix_fmt",
        "yuv420p",
        args.output,
    ]
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    rng = np.random.default_rng(8128 + int(args.bpm))
    try:
        for frame in range(DURATION_SECONDS * FPS):
            process.stdin.write(make_face_frame(base, skin_mask, frame, args.bpm, rng).tobytes())
    except BrokenPipeError:
        pass
    finally:
        process.stdin.close()
    if process.wait() != 0:
        sys.exit("ffmpeg failed to write the synthetic face video")


if __name__ == "__main__":
    main()
