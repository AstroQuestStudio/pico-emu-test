import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PythonError, TimeoutError } from '../src/index.js';
import { withBoard } from './helpers.js';

test('boots to the MicroPython prompt', () =>
  withBoard(async (board) => {
    assert.match(board.serialLog, /MicroPython v\d+\.\d+/);
    assert.match(board.serialLog, />>> /);
    assert.ok(board.timeMs > 0 && board.timeMs < 1000, `boot took ${board.timeMs} ms of emulated time`);
  }));

test('exec returns what the code printed', () =>
  withBoard(async (board) => {
    assert.equal(await board.exec('print(1 + 1)'), '2\n');
    assert.equal(await board.exec('import sys\nprint(sys.implementation.name)'), 'micropython\n');
  }));

test('state persists between calls', () =>
  withBoard(async (board) => {
    await board.exec('counter = 40');
    await board.exec('counter += 2');
    assert.equal(await board.exec('print(counter)'), '42\n');
  }));

test('evalJson returns Python values', () =>
  withBoard(async (board) => {
    assert.deepEqual(await board.evalJson('{"a": [1, 2, 3], "b": "x"}'), { a: [1, 2, 3], b: 'x' });
  }));

test('a Python exception becomes a PythonError with the traceback', () =>
  withBoard(async (board) => {
    await assert.rejects(board.exec('print("before")\n1 / 0'), (err) => {
      assert.ok(err instanceof PythonError);
      assert.equal(err.message, 'ZeroDivisionError: divide by zero');
      assert.equal(err.stdout, 'before\n');
      assert.match(err.stderr, /Traceback/);
      return true;
    });
    // the board is still usable afterwards
    assert.equal(await board.exec('print("alive")'), 'alive\n');
  }));

test('run reports failure without throwing', () =>
  withBoard(async (board) => {
    const result = await board.run('raise ValueError("nope")');
    assert.equal(result.ok, false);
    assert.match(result.stderr, /ValueError: nope/);
  }));

test('a program that never ends hits the wall-clock timeout and the board recovers', () =>
  withBoard(async (board) => {
    await assert.rejects(board.exec('while True:\n    pass', { timeoutMs: 1500 }), TimeoutError);
    assert.equal(await board.exec('print("recovered")'), 'recovered\n');
  }));

test('concurrent calls are serialised', () =>
  withBoard(async (board) => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => board.exec(`print(${n} * 10)`)));
    assert.deepEqual(results, ['10\n', '20\n', '30\n', '40\n']);
  }));

test('non-ASCII output survives the round trip', () =>
  withBoard(async (board) => {
    assert.equal(await board.exec('print("caf\\u00e9")'), 'café\n');
  }));

test('emulated time advances with sleep()', () =>
  withBoard(async (board) => {
    const before = board.timeMs;
    await board.exec('import time\ntime.sleep_ms(200)');
    assert.ok(board.timeMs - before >= 200, 'sleep_ms(200) must take at least 200 emulated ms');
    const t0 = board.timeMs;
    await board.sleep(50);
    assert.ok(Math.abs(board.timeMs - t0 - 50) < 0.01);
  }));
