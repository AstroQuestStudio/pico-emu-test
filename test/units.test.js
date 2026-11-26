import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOTROM_B1, bootromFromElf, ensureAsset, loadUf2, resolveBootrom } from '../src/index.js';

function uf2Block(address, payload, flags = 0) {
  const block = Buffer.alloc(512);
  block.writeUInt32LE(0x0a324655, 0);
  block.writeUInt32LE(0x9e5d5157, 4);
  block.writeUInt32LE(flags, 8);
  block.writeUInt32LE(address, 12);
  block.writeUInt32LE(payload.length, 16);
  payload.copy(block, 32);
  block.writeUInt32LE(0x0ab16f30, 508);
  return block;
}

test('loadUf2 copies each block to its address and ignores non-flash blocks', () => {
  const flash = new Uint8Array(4096).fill(0xff);
  const image = Buffer.concat([
    uf2Block(0x10000000, Buffer.from([1, 2, 3, 4])),
    uf2Block(0x10000100, Buffer.from([9, 9]), 0x1), // "not main flash": skipped
    uf2Block(0x10000200, Buffer.from([5, 6])),
  ]);
  assert.equal(loadUf2(image, flash), 2);
  assert.deepEqual([...flash.subarray(0, 4)], [1, 2, 3, 4]);
  assert.equal(flash[0x100], 0xff);
  assert.deepEqual([...flash.subarray(0x200, 0x202)], [5, 6]);
});

test('loadUf2 rejects a file that has no UF2 block', () => {
  assert.throws(() => loadUf2(Buffer.alloc(1024), new Uint8Array(4096)), /No valid UF2 block/);
});

test('bootromFromElf rejects other files', () => {
  assert.throws(() => bootromFromElf(Buffer.from('not an elf file at all, really')), /ELF/);
});

test('the official boot ROM is downloaded, verified and parsed', async () => {
  const file = await ensureAsset(BOOTROM_B1);
  const words = await resolveBootrom(file);
  assert.equal(words.length, 0x1000);
  assert.equal(words[0], 0x20041f00, 'initial stack pointer of the RP2040 B1 boot ROM');
  assert.equal(words[1] & 0xff, 0xef, 'the reset vector sits in the ROM');
});

test('resolveBootrom accepts a prebuilt word array and rejects a wrong size', async () => {
  const words = new Uint32Array(0x1000);
  assert.equal(await resolveBootrom(words), words);
  await assert.rejects(resolveBootrom(new Uint32Array(10)), /4096/);
});
