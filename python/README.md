# pico-emu-test, Python launcher

A single-file wrapper around the `pico-emu-test` command line tool, for use from pytest or any
Python script. It needs Node.js 22 or newer. See the main README for the emulator itself.

```python
from pico_emu_test import run

result = run("pico", exec="print(1 + 1)", expect="2")
assert result.ok
print(result.stdout, result.emulated_ms)
```

Use it from a checkout of the repository (the module finds `../bin/pico-emu-test.js` by itself), or
install the command with `npm install -g pico-emu-test` and the module with `pip install ./python`.
