# Contributing

Bug reports and pull requests are welcome.

## Running the tests

```sh
npm ci
npm run fetch     # downloads the boot ROM and the official MicroPython images (once)
npm test          # library and command line tests
npm run examples  # the example tests
python -m pytest examples/pytest
```

The tests need network access the first time (to download the boot ROM and the firmware) and
Node.js 22 or newer. `npm run fetch` prints where the files are cached.

## Guidelines

- New behaviour comes with a test next to the existing ones in `test/`.
- A claim in the README table of what is emulated must be backed by a test or by `scripts/bench.mjs`.
  `test/limits.test.js` pins the known limits: if it fails after upgrading `rp2040js`, a limit was
  probably lifted, so update the README together with the test.
- Fixes to `rp2040js` behaviour live in `src/patches.js`, each with a comment saying what is wrong
  and what real hardware does. Prefer sending the fix upstream as well.
- The code is plain JavaScript (ES modules) with JSDoc types; there is no build step.
- Do not commit firmware images, boot ROMs or other third-party binaries.
