# Changelog

## 0.1.0

First release.

- `Board`: boot a `.uf2` (official or custom MicroPython firmware) in `rp2040js`, wait for the prompt,
  run Python through the raw REPL (`exec`, `run`, `evalJson`), copy files to a RAM filesystem
  (`writeFile`, `readFile`, `listDir`), preload a prebuilt LittleFS image into flash.
- Fake peripherals: programmable I2C devices (`RegisterSlave`, `I2CSlave`) on hardware and software
  I2C, GPIO pins you can drive and record (`Pin`), ADC inputs, UARTs.
- Fidelity fixes on top of `rp2040js` 1.4.2: output pins read back their own level, the UART transmit
  interrupt can be cleared, a firmware that waits for the second core ends with an `EmulationError`
  instead of hanging.
- `pico-emu-test` command line tool with exit codes for CI, and a Python launcher for pytest.
- The boot ROM and the official firmware are downloaded on demand and verified by SHA-256; neither is
  stored in the repository.
- Continuous integration workflow, examples (hello, I2C sensor driver, button and LED), README with
  a measured table of what is and is not emulated.
