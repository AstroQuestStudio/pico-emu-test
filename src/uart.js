// A UART seen from the outside: capture what the firmware sends, feed it bytes.

/**
 * One of the two UARTs. Obtain it with `board.uart(0)` or `board.uart(1)`.
 */
export class Uart {
  /**
   * @param {import('./board.js').Board} board
   * @param {0|1} index
   */
  constructor(board, index) {
    this.board = board;
    this.index = index;
    this._uart = board.mcu.uart[index];
    /** @type {number[]} */
    this._sent = [];
    this._pending = [];
    this._alarm = board.mcu.clock.createAlarm(() => this._feedNext());
    this._uart.onByte = (value) => {
      this._sent.push(value);
    };
  }

  /** Bytes the firmware has transmitted so far. @returns {Buffer} */
  get sent() {
    return Buffer.from(this._sent);
  }

  /** Transmitted bytes as UTF-8 text. */
  get sentText() {
    return this.sent.toString('utf8');
  }

  /** Forget the captured bytes. */
  clearSent() {
    this._sent.length = 0;
  }

  /**
   * Send bytes to the firmware's receive pin, spaced at the baud rate the firmware configured
   * (115200 if it has not configured one yet). Returns immediately; the bytes arrive as emulated time passes.
   *
   * @param {string|Uint8Array} data
   */
  feed(data) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const idle = this._pending.length === 0;
    this._pending.push(...bytes);
    if (idle) this._feedNext();
  }

  _feedNext() {
    const next = this._pending.shift();
    if (next === undefined) return;
    this._uart.feedByte(next);
    if (this._pending.length) {
      const baud = this._uart.baudRate || 115200;
      this._alarm.schedule(Math.round((10 / baud) * 1e9)); // start + 8 data + stop bits
    }
  }
}
