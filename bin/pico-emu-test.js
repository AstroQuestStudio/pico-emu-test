#!/usr/bin/env node
// Command line front end: boot a firmware, run Python on it, report through the exit code.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  Board,
  BOOTROM_B1,
  EmulationError,
  OFFICIAL_FIRMWARE,
  PythonError,
  TimeoutError,
  ensureAsset,
  fetchOfficialFirmware,
} from '../src/index.js';

const EXIT = { ok: 0, python: 1, boot: 2, timeout: 3, expect: 4, emulation: 5, usage: 64 };

const HELP = `pico-emu-test: boot a MicroPython firmware for the Raspberry Pi Pico on your PC.

Usage:
  pico-emu-test <firmware> [options]
  pico-emu-test fetch [pico|pico-w|bootrom]

<firmware> is a .uf2 file, or "pico" / "pico-w" for the official MicroPython image
(downloaded once into the cache directory).

Options:
  -e, --exec <code>        Python code to run (repeatable; items run in order)
  -s, --script <file.py>   Python file to run (repeatable, mixed with --exec in command-line order)
  -p, --put <local[=remote]>
                           Copy a file to the board's filesystem first (repeatable).
                           remote defaults to /<file name>. Creates a RAM filesystem as "/".
      --expect <text>      Fail with exit code 4 unless the output contains <text> (repeatable)
  -t, --timeout <ms>       Wall-clock limit for each --exec / --script (default 30000)
      --boot-timeout <ms>  Wall-clock limit to reach the prompt (default 20000)
      --bootrom <file>     RP2040 boot ROM (.elf or 16 KiB .bin). Default: official B1, downloaded once
      --flash-image <file> Raw image (for example a LittleFS filesystem) copied into flash at --flash-offset
      --flash-offset <n>   Where --flash-image goes, from the start of flash (default 0xa0000)
  -i, --interactive        After the runs, connect the terminal to the board's console (Ctrl-X quits)
      --json               Print one JSON report on stdout instead of the raw output
  -q, --quiet              No progress messages on stderr
  -v, --verbose            Show emulator warnings
  -h, --help               This text
      --version            Print the version

Exit codes:
  0 success    1 Python exception    2 the firmware did not boot    3 timeout
  4 --expect not satisfied    5 a feature the emulator lacks was needed    64 usage error
`;

function fail(message, code = EXIT.usage) {
  process.stderr.write(`pico-emu-test: ${message}\n`);
  process.exit(code);
}

async function fetchCommand(what = 'all') {
  const log = (m) => process.stderr.write(`${m}\n`);
  const out = [];
  if (what === 'all' || what === 'bootrom') out.push(await ensureAsset(BOOTROM_B1, { log }));
  if (what === 'all' || what === 'pico') out.push(await fetchOfficialFirmware('pico', { log }));
  if (what === 'all' || what === 'pico-w') out.push(await fetchOfficialFirmware('pico-w', { log }));
  if (out.length === 0) fail(`unknown item "${what}" (expected: pico, pico-w, bootrom)`);
  for (const file of out) console.log(file);
}

// Keep --exec and --script in the order they were typed.
function orderedSteps(argv) {
  const steps = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^(?:--(exec|script)=(.*)|(-e|-s|--exec|--script))$/.exec(a);
    if (!m) continue;
    if (m[1]) steps.push({ kind: m[1], value: m[2] });
    else steps.push({ kind: m[3].replace(/^-+/, '').replace(/^e$/, 'exec').replace(/^s$/, 'script'), value: argv[++i] });
  }
  return steps;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'fetch') return fetchCommand(argv[1]);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        exec: { type: 'string', short: 'e', multiple: true },
        script: { type: 'string', short: 's', multiple: true },
        put: { type: 'string', short: 'p', multiple: true },
        expect: { type: 'string', multiple: true },
        timeout: { type: 'string', short: 't' },
        'boot-timeout': { type: 'string' },
        bootrom: { type: 'string' },
        'flash-image': { type: 'string' },
        'flash-offset': { type: 'string' },
        interactive: { type: 'boolean', short: 'i' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    return fail(`${err.message}\nTry --help.`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return;
  }
  if (positionals.length !== 1) return fail('expected exactly one firmware argument. Try --help.');

  const timeoutMs = values.timeout ? Number(values.timeout) : 30000;
  const bootTimeoutMs = values['boot-timeout'] ? Number(values['boot-timeout']) : 20000;
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(bootTimeoutMs)) return fail('timeouts must be numbers (ms)');

  const info = values.quiet || values.json ? () => {} : (m) => process.stderr.write(`[pico-emu-test] ${m}\n`);
  const steps = orderedSteps(argv).map((s) => {
    if (s.kind === 'script') {
      if (!fs.existsSync(s.value)) fail(`script not found: ${s.value}`);
      return { label: s.value, code: fs.readFileSync(s.value, 'utf8') };
    }
    return { label: '--exec', code: s.value };
  });
  const puts = (values.put ?? []).map((spec) => {
    const idx = spec.lastIndexOf('=');
    const local = idx >= 0 ? spec.slice(0, idx) : spec;
    const remote = idx >= 0 ? spec.slice(idx + 1) : `/${path.basename(spec)}`;
    if (!fs.existsSync(local)) fail(`file not found: ${local}`);
    return { local, remote };
  });
  if (steps.length === 0 && !values.interactive) {
    return fail('nothing to do: give --exec, --script or --interactive');
  }

  let firmware = positionals[0];
  if (!fs.existsSync(firmware)) {
    if (OFFICIAL_FIRMWARE[firmware]) {
      firmware = await fetchOfficialFirmware(firmware, { log: info });
    } else {
      return fail(`firmware not found: ${firmware}`);
    }
  }

  const report = { ok: false, exitCode: EXIT.ok, firmware: path.basename(firmware), steps: [], bootMs: 0, wallMs: 0 };
  const wall0 = Date.now();
  let board;
  const finish = (code, message) => {
    report.exitCode = code;
    report.ok = code === EXIT.ok;
    if (message) report.error = message;
    report.wallMs = Date.now() - wall0;
    if (board) {
      report.emulatedMs = Math.round(board.timeMs * 1000) / 1000;
      board.stop();
    }
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (message) process.stderr.write(`pico-emu-test: ${message}\n`);
    process.exit(code);
  };

  try {
    board = await Board.boot({
      firmware,
      bootrom: values.bootrom,
      flashImage: values['flash-image'],
      flashImageOffset: values['flash-offset'] ? Number(values['flash-offset']) : undefined,
      verbose: values.verbose,
      bootTimeoutMs,
      log: info,
    });
  } catch (err) {
    return finish(err instanceof EmulationError ? EXIT.emulation : EXIT.boot, err.message);
  }
  report.bootMs = Math.round(board.timeMs * 1000) / 1000;
  info(`booted in ${report.bootMs.toFixed(1)} ms of emulated time (${Date.now() - wall0} ms wall clock)`);

  let allOutput = '';
  try {
    for (const { local, remote } of puts) {
      info(`copying ${local} to ${remote}`);
      await board.writeFile(remote, fs.readFileSync(local));
    }
    for (const step of steps) {
      const result = await board.run(step.code, { timeoutMs });
      report.steps.push({ label: step.label, ok: result.ok, stdout: result.stdout, stderr: result.stderr, emulatedMs: result.timeMs });
      allOutput += result.stdout;
      if (!values.json) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      if (!result.ok) return finish(EXIT.python, `${step.label} raised ${new PythonError(result.stderr, '').message}`);
    }
  } catch (err) {
    const code = err instanceof TimeoutError ? EXIT.timeout : err instanceof EmulationError ? EXIT.emulation : EXIT.python;
    return finish(code, err.message);
  }

  for (const text of values.expect ?? []) {
    if (!allOutput.includes(text)) return finish(EXIT.expect, `expected output not found: ${JSON.stringify(text)}`);
  }

  if (values.interactive) {
    process.stderr.write('[pico-emu-test] console attached, Ctrl-X to quit\n');
    board.onSerial((chunk) => process.stdout.write(chunk));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    board.write('\x02\r\n'); // leave the raw REPL, print a fresh prompt
    process.stdin.on('data', (chunk) => {
      if (chunk[0] === 0x18) finish(EXIT.ok);
      else board.write(chunk);
    });
    return;
  }
  finish(EXIT.ok);
}

main().catch((err) => {
  process.stderr.write(`pico-emu-test: ${err.stack ?? err}\n`);
  process.exit(EXIT.boot);
});
