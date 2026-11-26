import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBoard } from './helpers.js';

test('ADC reads the value the test sets', () =>
  withBoard(async (board) => {
    await board.exec('from machine import ADC\nadc = ADC(26)');
    board.setAdc(0, { volts: 1.65 });
    const half = Number((await board.exec('print(adc.read_u16())')).trim());
    assert.ok(Math.abs(half / 65535 - 0.5) < 0.01, `read ${half}`);
    board.setAdc(0, { raw: 4095 });
    assert.ok(Number((await board.exec('print(adc.read_u16())')).trim()) > 65000);
    assert.throws(() => board.setAdc(9, { raw: 0 }), RangeError);
  }));

test('the internal temperature sensor follows its channel', () =>
  withBoard(async (board) => {
    const celsius = async () =>
      Number(
        (await board.exec('from machine import ADC\nv = ADC(4).read_u16() * 3.3 / 65535\nprint(27 - (v - 0.706) / 0.001721)')).trim(),
      );
    board.setAdc(4, { volts: 0.706 });
    assert.ok(Math.abs((await celsius()) - 27) < 1);
    board.setAdc(4, { volts: 0.706 - 0.001721 * 20 });
    assert.ok(Math.abs((await celsius()) - 47) < 1);
  }));

test('UART: capture what the firmware sends and feed it bytes', () =>
  withBoard(async (board) => {
    const uart = board.uart(0);
    await board.exec('from machine import UART, Pin\nu = UART(0, baudrate=115200, tx=Pin(0), rx=Pin(1))\nu.write(b"hello")');
    await board.sleep(5);
    assert.equal(uart.sentText, 'hello');
    uart.feed('AB');
    await board.sleep(5);
    assert.equal(await board.exec('print(u.read())'), "b'AB'\n");
    uart.clearSent();
    assert.equal(uart.sent.length, 0);
  }));

test('UART: a line can be read with readline()', () =>
  withBoard(async (board) => {
    await board.exec('from machine import UART, Pin\nu = UART(1, baudrate=9600, tx=Pin(4), rx=Pin(5), timeout=500)');
    board.uart(1).feed('$GPGGA,123519\r\n');
    assert.equal(await board.exec('print(u.readline())'), "b'$GPGGA,123519\\r\\n'\n");
  }));

test('Timer callbacks fire at the programmed period', () =>
  withBoard(async (board) => {
    const out = await board.exec(
      'from machine import Timer\nimport time\nn = 0\ndef tick(t):\n    global n\n    n += 1\n' +
        't = Timer(period=10, mode=Timer.PERIODIC, callback=tick)\ntime.sleep_ms(105)\nt.deinit()\nprint(n)',
    );
    assert.equal(Number(out), 10);
  }));
