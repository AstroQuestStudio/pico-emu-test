// The smallest useful test: boot the firmware and run some Python on it.
//
//   node --test examples/hello.test.js

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootOfficial } from './helpers.js';

let board;
before(async () => {
  board = await bootOfficial();
});
after(() => board.stop());

test('the firmware identifies itself', async () => {
  const out = await board.exec('import os\nprint(os.uname().machine)');
  assert.match(out, /Raspberry Pi Pico/);
});

test('arithmetic works and values come back as JSON', async () => {
  assert.equal(await board.evalJson('sum(range(101))'), 5050);
});

test('a library function from the firmware can be exercised', async () => {
  const out = await board.exec('import hashlib, binascii\nprint(binascii.hexlify(hashlib.sha256(b"abc").digest()).decode())');
  assert.equal(out.trim(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
