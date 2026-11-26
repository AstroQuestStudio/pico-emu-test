import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { withBoard } from './helpers.js';

test('writeFile makes a module importable', () =>
  withBoard(async (board) => {
    await board.writeFile('/answer.py', 'VALUE = 6 * 7\n');
    assert.equal(await board.exec('import answer\nprint(answer.VALUE)'), '42\n');
    assert.deepEqual(await board.listDir('/'), ['answer.py']);
  }));

test('writeFile creates parent directories', () =>
  withBoard(async (board) => {
    await board.writeFile('/lib/pkg/mod.py', 'def f():\n    return "deep"\n');
    assert.equal(await board.exec('import sys\nsys.path.append("/lib")\nfrom pkg import mod\nprint(mod.f())'), 'deep\n');
  }));

test('binary data and larger files round-trip unchanged', () =>
  withBoard(async (board) => {
    const data = Buffer.alloc(8000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
    await board.writeFile('/blob.bin', data);
    const back = await board.readFile('/blob.bin');
    assert.equal(back.length, data.length);
    assert.ok(back.equals(data));
  }));

test('a file can be replaced', () =>
  withBoard(async (board) => {
    await board.writeFile('/a.txt', 'first');
    await board.writeFile('/a.txt', 'second');
    assert.equal((await board.readFile('/a.txt')).toString(), 'second');
  }));

test('a prebuilt LittleFS image can be preloaded into flash (main.py runs at boot)', { skip: !process.env.PICO_TEST_LFS_IMAGE }, () =>
  withBoard(
    async (board) => {
      assert.match(board.serialLog, /main\.py ran/);
      assert.equal(await board.exec('import hello\nprint(hello.X)'), 'hello from the flash filesystem\n42\n');
      assert.ok(fs.existsSync(process.env.PICO_TEST_LFS_IMAGE));
    },
    { flashImage: process.env.PICO_TEST_LFS_IMAGE },
  ));
