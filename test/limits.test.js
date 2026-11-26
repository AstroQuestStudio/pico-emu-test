// These tests pin down what the emulator does NOT do, exactly as the README table states it.
// If one fails after an upgrade of rp2040js, the limit has probably been lifted: update the README.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, EmulationError, fetchOfficialFirmware } from '../src/index.js';
import { withBoard } from './helpers.js';

test('second core: _thread stops with an EmulationError instead of hanging', () =>
  withBoard(async (board) => {
    await assert.rejects(board.exec('import _thread\n_thread.start_new_thread(print, (1,))', { timeoutMs: 20000 }), EmulationError);
    // a failed board stays failed
    await assert.rejects(board.exec('print(1)'), EmulationError);
  }));

test('second core: a write to the inter-core FIFO is reported', () =>
  withBoard(async (board) => {
    await assert.rejects(board.exec('import machine\nmachine.mem32[0xd0000054] = 1'), EmulationError);
  }));

test('flash writes are silently ignored', () =>
  withBoard(async (board) => {
    const out = await board.exec(
      [
        'import rp2',
        'f = rp2.Flash()',
        'buf = bytearray(4)',
        'f.readblocks(300, buf)',
        'f.ioctl(6, 300)',
        'f.writeblocks(300, b"abcd" * 1024)',
        'f.readblocks(300, buf)',
        'print(bytes(buf))',
      ].join('\n'),
    );
    assert.equal(out, "b'\\xff\\xff\\xff\\xff'\n", 'data written to flash is still erased');
  }));

test('without a mounted filesystem the root is empty and not writable', () =>
  withBoard(async (board) => {
    assert.equal(await board.exec('import os\nprint(os.listdir("/"))'), '[]\n');
    await assert.rejects(board.exec('open("/x.txt", "w")'), /ENODEV|19/);
  }));

test('Pico W: the firmware boots, but the radio chip is not emulated', async () => {
  const firmware = await fetchOfficialFirmware('pico-w');
  const board = await Board.boot({ firmware });
  try {
    assert.match(board.serialLog, /Raspberry Pi Pico W/);
    assert.equal(await board.exec('print(1 + 1)'), '2\n');
    await board.exec('import network\nnetwork.WLAN(network.STA_IF).active(True)', { timeoutMs: 30000 });
    assert.match(board.serialLog, /\[CYW43\] Failed to start CYW43/);
  } finally {
    board.stop();
  }
});
