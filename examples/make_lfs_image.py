"""Build a LittleFS image of a directory, to preload into the emulated flash.

    pip install littlefs-python
    python examples/make_lfs_image.py my_files fs.img
    pico-emu-test firmware.uf2 --flash-image fs.img --exec "import os; print(os.listdir('/'))"

In JavaScript: Board.boot({ firmware, flashImage: 'fs.img' }).

Defaults match the official Raspberry Pi Pico image: the filesystem starts at flash offset 0xA0000
(the default of --flash-image) and fills the rest of the 2 MiB flash with 4 KiB blocks, 352 of them.
The official Pico W image uses 212 blocks starting at 0x12C000. Custom firmware may use another
layout: read the block count on it with `rp2.Flash().ioctl(4, None)`. The emulator cannot write to
flash, so the filesystem is read-only in practice.
"""

import argparse
from pathlib import Path

from littlefs import LittleFS

BLOCK_SIZE = 4096


def build(source: Path, blocks: int) -> bytes:
    fs = LittleFS(
        block_size=BLOCK_SIZE, block_count=blocks, read_size=32, prog_size=32, lookahead_size=32, cache_size=32
    )
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source).as_posix()
        if path.is_dir():
            fs.mkdir(relative)
        else:
            with fs.open(relative, "wb") as handle:
                handle.write(path.read_bytes())
    return bytes(fs.context.buffer)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a LittleFS image for pico-emu-test.")
    parser.add_argument("source", type=Path, help="directory whose content becomes the filesystem")
    parser.add_argument("image", type=Path, help="output file")
    parser.add_argument("--blocks", type=int, default=352, help="number of 4 KiB blocks (default: 352, official Pico)")
    args = parser.parse_args()
    args.image.write_bytes(build(args.source, args.blocks))
    print(f"wrote {args.image} ({args.blocks} blocks of {BLOCK_SIZE} bytes)")


if __name__ == "__main__":
    main()
