// Test GPIO logic: a button toggles the LED, with debouncing done in the firmware.
//
//   node --test examples/button-led.test.js

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootOfficial } from './helpers.js';

const FIRMWARE_UNDER_TEST = `
from machine import Pin
import time

led = Pin(25, Pin.OUT, value=0)
button = Pin(14, Pin.IN, Pin.PULL_UP)
last = 0

def on_press(pin):
    global last
    now = time.ticks_ms()
    if time.ticks_diff(now, last) > 50:   # ignore contact bounce
        led.toggle()
        last = now

button.irq(on_press, Pin.IRQ_FALLING)
`;

let board;
before(async () => {
  board = await bootOfficial();
  await board.exec(FIRMWARE_UNDER_TEST);
  board.pin(14).release(); // the pull-up holds the button released
});
after(() => board.stop());

async function press({ bounce = false } = {}) {
  const button = board.pin(14);
  button.drive(false);
  if (bounce) {
    for (let i = 0; i < 3; i++) {
      await board.sleep(1);
      button.drive(true);
      await board.sleep(1);
      button.drive(false);
    }
  }
  await board.sleep(100);
  button.drive(true);
  await board.sleep(100);
}

test('the LED starts off', () => {
  assert.equal(board.led.level, false);
});

test('a press turns the LED on, the next press turns it off', async () => {
  await press();
  assert.equal(board.led.level, true);
  await press();
  assert.equal(board.led.level, false);
});

test('contact bounce counts as a single press', async () => {
  const before = board.led.level;
  await press({ bounce: true });
  assert.equal(board.led.level, !before);
});
