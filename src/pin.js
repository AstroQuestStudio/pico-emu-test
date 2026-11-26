// GPIO access from the test side: drive an input, observe an output, record its history.

import { GPIOPinState } from 'rp2040js';

const HISTORY_LIMIT = 100000;

/**
 * One GPIO pin of the emulated board. Obtain it with `board.pin(number)`.
 *
 * Two directions of use:
 *  - the firmware reads the pin  -> call `drive(level)` to act as the outside world (a button, a sensor output);
 *  - the firmware drives the pin -> read `level`, or inspect `history` (every change, with its time).
 */
export class Pin {
  /**
   * @param {import('./board.js').Board} board
   * @param {number} index GPIO number, 0..29
   */
  constructor(board, index) {
    this.board = board;
    this.index = index;
    this._gpio = board.mcu.gpio[index];
    /** Changes of the level the firmware drives, oldest first: `{ timeMs, level }` (emulated time). */
    this.history = [];
    this._waiters = new Set();
    this._gpio.addListener((state) => this._onState(state));
  }

  _onState(state) {
    if (state !== GPIOPinState.High && state !== GPIOPinState.Low) return; // not driven as an output
    const level = state === GPIOPinState.High;
    if (this.history.length < HISTORY_LIMIT) {
      this.history.push({ timeMs: this.board.timeMs, level });
    }
    for (const waiter of [...this._waiters]) waiter(level);
  }

  /**
   * Level currently driven by the firmware: `true`, `false`, or `null` when the pin is not an output.
   * @returns {boolean|null}
   */
  get level() {
    return this._gpio.outputEnable ? this._gpio.outputValue : null;
  }

  /** Human-readable pin state: 'high', 'low' (driven), or 'input', 'input-pullup', 'input-pulldown', 'input-bus-keeper'. */
  get state() {
    return ['low', 'high', 'input', 'input-pullup', 'input-pulldown', 'input-bus-keeper'][this._gpio.value];
  }

  /**
   * Apply an external level to the pin, as a button or another chip would.
   * @param {boolean|number} level
   */
  drive(level) {
    this._gpio.setInputValue(Boolean(level));
  }

  /**
   * Stop driving the pin from outside: it reads high if the firmware enabled the pull-up, low otherwise.
   */
  release() {
    this._gpio.setInputValue(this._gpio.pullupEnabled && !this._gpio.pulldownEnabled);
  }

  /** Forget the recorded history. */
  clearHistory() {
    this.history.length = 0;
  }

  /**
   * Wait until the firmware drives the pin to `level`.
   * Resolves immediately if it already does.
   *
   * @param {boolean} level
   * @param {{timeoutMs?: number}} [options] wall-clock timeout (default 5000)
   * @returns {Promise<void>}
   */
  waitFor(level, { timeoutMs = 5000 } = {}) {
    if (this.level === level) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(waiter);
        reject(new Error(`GP${this.index} did not go ${level ? 'high' : 'low'} within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = (value) => {
        if (value !== level) return;
        clearTimeout(timer);
        this._waiters.delete(waiter);
        resolve();
      };
      this._waiters.add(waiter);
    });
  }

  /**
   * Estimate frequency and duty cycle of the signal the firmware drives, from the recorded history.
   * Uses the rising edges found in `history` (optionally only those after `sinceMs`).
   *
   * @param {{sinceMs?: number}} [options]
   * @returns {{edges: number, frequencyHz: number|null, dutyCycle: number|null}}
   */
  measure({ sinceMs = 0 } = {}) {
    const events = this.history.filter((e) => e.timeMs >= sinceMs);
    const rising = events.filter((e) => e.level).map((e) => e.timeMs);
    if (rising.length < 2) return { edges: events.length, frequencyHz: null, dutyCycle: null };
    const period = (rising[rising.length - 1] - rising[0]) / (rising.length - 1);
    let highTime = 0;
    let cycles = 0;
    for (let i = 0; i < events.length - 1; i++) {
      if (events[i].level && !events[i + 1].level) {
        highTime += events[i + 1].timeMs - events[i].timeMs;
        cycles++;
      }
    }
    return {
      edges: events.length,
      frequencyHz: 1000 / period,
      dutyCycle: cycles ? highTime / cycles / period : null,
    };
  }
}
