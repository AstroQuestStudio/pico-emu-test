# Third-party software and files

pico-emu-test is MIT licensed (see `LICENSE`). It builds on, and downloads, the following.

## rp2040js (dependency, installed by npm)

The RP2040 emulator at the core of this project.
Copyright (c) 2021 Uri Shaked, MIT License. https://github.com/wokwi/rp2040js

## RP2040 boot ROM (downloaded, not distributed here)

The emulator needs the 16 KiB boot ROM of the RP2040 (build B1). It is **not** stored in this
repository. `pico-emu-test` downloads the official release
`https://github.com/raspberrypi/pico-bootrom-rp2040/releases/download/b1/b1.elf` on first use,
checks its SHA-256 digest against the value pinned in `src/assets.js`, and keeps it in a cache
directory on your machine.

Why it is not bundled: the boot ROM contains floating-point routines by Mark Owen, which Raspberry Pi
license "solely on a Raspberry Pi RP2040 device"; the rest of the ROM source is under the BSD 3-Clause
licence. Running it inside an emulator on a PC is outside that wording, so the file is left to each
user to fetch from its official source and is not redistributed by this project.

## MicroPython firmware (downloaded for the examples and tests, not distributed here)

The examples, tests and continuous integration run against the official MicroPython images
`RPI_PICO-20260824-v1.29.0.uf2` and `RPI_PICO_W-20260824-v1.29.0.uf2` from
`https://micropython.org/resources/firmware/`. MicroPython is MIT licensed
(Copyright (c) 2013-2026 Damien P. George). The images are downloaded on demand,
verified against pinned SHA-256 digests (`src/assets.js`) and cached; they are not committed here.

## littlefs-python (optional, example only)

`examples/make_lfs_image.py` uses the `littlefs-python` package (BSD 3-Clause) to build filesystem
images. It is not a dependency of the emulator.
