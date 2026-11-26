import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBoard } from './helpers.js';

test('the LED pin history records every change the firmware makes', () =>
  withBoard(async (board) => {
    await board.exec('from machine import Pin\nled = Pin(25, Pin.OUT)\nled.value(1)\nled.value(0)\nled.value(1)');
    assert.deepEqual(
      board.led.history.map((e) => e.level),
      [false, true, false, true], // the first false is the pin being configured as an output
    );
    assert.equal(board.led.level, true);
    assert.equal(board.led.state, 'high');
  }));

test('an input pin reads what the test drives', () =>
  withBoard(async (board) => {
    await board.exec('from machine import Pin\nbutton = Pin(3, Pin.IN, Pin.PULL_UP)');
    const read = async () => (await board.exec('print(button.value())')).trim();
    board.pin(3).release();
    assert.equal(await read(), '1', 'released with a pull-up reads high');
    board.pin(3).drive(false);
    assert.equal(await read(), '0');
    board.pin(3).drive(true);
    assert.equal(await read(), '1');
  }));

test('an output pin reads back its own level', () =>
  withBoard(async (board) => {
    const out = await board.exec('from machine import Pin\np = Pin(2, Pin.OUT)\np.value(1)\nprint(p.value())\np.value(0)\nprint(p.value())');
    assert.equal(out, '1\n0\n');
  }));

test('pin interrupts fire on the edges the test produces', () =>
  withBoard(async (board) => {
    await board.exec(
      'from machine import Pin\ncount = 0\ndef handler(pin):\n    global count\n    count += 1\n' +
        'button = Pin(4, Pin.IN, Pin.PULL_UP)\nbutton.irq(handler, Pin.IRQ_FALLING)',
    );
    for (let i = 0; i < 3; i++) {
      board.pin(4).drive(false);
      await board.sleep(5);
      board.pin(4).drive(true);
      await board.sleep(5);
    }
    assert.equal((await board.exec('print(count)')).trim(), '3');
  }));

test('PWM output can be measured', () =>
  withBoard(async (board) => {
    await board.exec('from machine import Pin, PWM\npwm = PWM(Pin(15))\npwm.freq(1000)\npwm.duty_u16(16384)');
    await board.sleep(20);
    board.pin(15).clearHistory();
    await board.sleep(100);
    const m = board.pin(15).measure();
    assert.ok(Math.abs(m.frequencyHz - 1000) < 5, `frequency ${m.frequencyHz}`);
    assert.ok(Math.abs(m.dutyCycle - 0.25) < 0.01, `duty cycle ${m.dutyCycle}`);
  }));

test('waitFor resolves when the firmware drives the pin', () =>
  withBoard(async (board) => {
    await board.exec('from machine import Pin, Timer\nout = Pin(6, Pin.OUT, value=0)\nt = Timer(period=20, mode=Timer.ONE_SHOT, callback=lambda t: out.value(1))');
    await board.pin(6).waitFor(true, { timeoutMs: 3000 });
    assert.equal(board.pin(6).level, true);
  }));

test('waitFor rejects when the level never comes', () =>
  withBoard(async (board) => {
    await board.exec('from machine import Pin\nPin(7, Pin.OUT, value=0)');
    await assert.rejects(board.pin(7).waitFor(true, { timeoutMs: 200 }), /did not go high/);
  }));

test('pin numbers are validated', () =>
  withBoard(async (board) => {
    assert.throws(() => board.pin(30), RangeError);
    assert.throws(() => board.pin(-1), RangeError);
  }));
