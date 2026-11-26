import assert from 'node:assert/strict';
import { test } from 'node:test';
import { I2CSlave, RegisterSlave } from '../src/index.js';
import { withBoard } from './helpers.js';

const SETUP = 'from machine import I2C, SoftI2C, Pin\ni2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=400000)\n';

test('a register device answers scan, reads and writes (hardware I2C)', () =>
  withBoard(async (board) => {
    const bus = board.i2c(0);
    const device = bus.attach(new RegisterSlave({ address: 0x50, registers: { 0x00: 0xab, 0x01: 0xcd } }));
    assert.equal(await board.exec(`${SETUP}print(i2c.scan())`), '[80]\n');
    assert.equal(await board.exec('print(i2c.readfrom_mem(0x50, 0, 2))'), "b'\\xab\\xcd'\n");
    await board.exec('i2c.writeto_mem(0x50, 0x10, b"\\x01\\x02\\x03")');
    assert.deepEqual([...device.registers.subarray(0x10, 0x13)], [1, 2, 3]);
    assert.deepEqual(device.writesTo(0x11), [2]);
    assert.ok(bus.stats.transactions > 0);
  }));

test('software I2C works when the bus is given its pins', () =>
  withBoard(async (board) => {
    board.i2c(1, { sda: 6, scl: 7 }).attach(new RegisterSlave({ address: 0x29, registers: { 0x0f: 0x5a } }));
    const out = await board.exec(
      'from machine import SoftI2C, Pin\ns = SoftI2C(sda=Pin(6), scl=Pin(7))\nprint(s.scan())\nprint(s.readfrom_mem(0x29, 0x0f, 1))',
    );
    assert.equal(out, "[41]\nb'Z'\n");
  }));

test('a missing device is NACKed', () =>
  withBoard(async (board) => {
    board.i2c(0);
    const out = await board.exec(`${SETUP}try:\n    i2c.readfrom(0x33, 1)\nexcept OSError as e:\n    print("OSError", e.errno)`);
    assert.match(out, /OSError/);
    assert.equal(await board.exec('print(i2c.scan())'), '[]\n');
  }));

test('a device can be unplugged and plugged back', () =>
  withBoard(async (board) => {
    const device = board.i2c(0).attach(new RegisterSlave({ address: 0x40 }));
    assert.equal(await board.exec(`${SETUP}print(i2c.scan())`), '[64]\n');
    device.enabled = false;
    assert.equal(await board.exec('print(i2c.scan())'), '[]\n');
    device.enabled = true;
    assert.equal(await board.exec('print(i2c.scan())'), '[64]\n');
  }));

test('onRead and onWrite hooks see register accesses', () =>
  withBoard(async (board) => {
    let counter = 0;
    const seen = [];
    board.i2c(0).attach(
      new RegisterSlave({
        address: 0x20,
        onRead: (reg) => (reg === 0x07 ? ++counter : undefined),
        onWrite: (reg, value) => seen.push([reg, value]),
      }),
    );
    await board.exec(`${SETUP}i2c.writeto_mem(0x20, 0x01, b"\\x09")`);
    assert.deepEqual(seen, [[1, 9]]);
    assert.equal(await board.exec('print(i2c.readfrom_mem(0x20, 7, 1)[0], i2c.readfrom_mem(0x20, 7, 1)[0])'), '1 2\n');
  }));

test('a custom device built from the I2CSlave base class works', () =>
  withBoard(async (board) => {
    class Echo extends I2CSlave {
      last = 0;
      write(byte) {
        this.last = byte;
        return true;
      }
      read() {
        return (this.last + 1) & 0xff;
      }
    }
    board.i2c(0).attach(new Echo(0x42));
    const out = await board.exec(`${SETUP}i2c.writeto(0x42, b"\\x09")\nprint(i2c.readfrom(0x42, 1)[0])`);
    assert.equal(out, '10\n');
  }));

test('hardware transactions take emulated time like a real bus', () =>
  withBoard(async (board) => {
    board.i2c(0).attach(new RegisterSlave({ address: 0x50 }));
    await board.exec(SETUP);
    const out = await board.exec(
      'import time\nt0 = time.ticks_us()\nfor _ in range(20):\n    i2c.readfrom_mem(0x50, 0, 6)\nprint((time.ticks_diff(time.ticks_us(), t0)) // 20)',
    );
    const perTransaction = Number(out);
    // 6 bytes + address and register phases at 400 kHz is a few hundred microseconds, not zero and not milliseconds
    assert.ok(perTransaction > 100 && perTransaction < 2000, `${perTransaction} us per transaction`);
  }));

test('invalid addresses are rejected', () => {
  assert.throws(() => new RegisterSlave({ address: 0x80 }), RangeError);
  assert.throws(() => new I2CSlave(-1), RangeError);
});
