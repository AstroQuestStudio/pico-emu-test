import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { firmwarePath } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/pico-emu-test.js', import.meta.url));

async function cli(...args) {
  const firmware = await firmwarePath();
  const r = spawnSync(process.execPath, [CLI, firmware, '--quiet', ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('--exec prints the output and exits 0', async () => {
  const r = await cli('--exec', 'print(1 + 1)');
  assert.equal(r.code, 0);
  assert.equal(r.out, '2\n');
});

test('--exec and --script run in the order given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-emu-'));
  const script = path.join(dir, 'step.py');
  fs.writeFileSync(script, 'x += 1\nprint("x =", x)\n');
  const r = await cli('--exec', 'x = 41', '--script', script);
  fs.rmSync(dir, { recursive: true });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'x = 42\n');
});

test('a Python exception gives exit code 1 and the traceback on stderr', async () => {
  const r = await cli('--exec', 'print("a")', '--exec', '1/0');
  assert.equal(r.code, 1);
  assert.equal(r.out, 'a\n');
  assert.match(r.err, /ZeroDivisionError/);
});

test('--timeout gives exit code 3', async () => {
  const r = await cli('--exec', 'while True: pass', '--timeout', '1000');
  assert.equal(r.code, 3);
  assert.match(r.err, /did not finish/);
});

test('--expect gives exit code 4 when the text is missing', async () => {
  assert.equal((await cli('--exec', 'print("hello")', '--expect', 'hello')).code, 0);
  const r = await cli('--exec', 'print("hello")', '--expect', 'goodbye');
  assert.equal(r.code, 4);
});

test('using the second core gives exit code 5', async () => {
  const r = await cli('--exec', 'import _thread; _thread.start_new_thread(print, (1,))');
  assert.equal(r.code, 5);
});

test('--put copies a file before the code runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-emu-'));
  const file = path.join(dir, 'greeting.py');
  fs.writeFileSync(file, 'TEXT = "from a file"\n');
  const r = await cli('--put', `${file}=/greeting.py`, '--exec', 'import greeting; print(greeting.TEXT)');
  fs.rmSync(dir, { recursive: true });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'from a file\n');
});

test('--json prints one report', async () => {
  const r = await cli('--json', '--exec', 'print("j")');
  assert.equal(r.code, 0);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.steps[0].stdout, 'j\n');
  assert.ok(report.emulatedMs > 0 && report.wallMs > 0);
});

test('usage errors give exit code 64', async () => {
  assert.equal((await cli()).code, 64); // nothing to do
  const r = spawnSync(process.execPath, [CLI, 'does-not-exist.uf2', '--exec', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
});

test('a file that is not a firmware gives exit code 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pico-emu-'));
  const bogus = path.join(dir, 'bogus.uf2');
  fs.writeFileSync(bogus, Buffer.alloc(2048));
  const r = spawnSync(process.execPath, [CLI, bogus, '--exec', '1'], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true });
  assert.equal(r.status, 2);
});
