// Fake I2C devices and the bus that connects them to an emulated I2C controller.
//
// A device is any object with an `address` (7 bits) and the four methods of `I2CSlave`.
// `RegisterSlave` implements the very common "register pointer + auto-increment" protocol
// and is the quickest way to fake a sensor.

const FUNCTION_SIO = 5; // GPIO function select value for software-controlled pins

// GPIOs that can carry each I2C controller's lines. A real bus has pull-up resistors on both lines
// and firmware may refuse to start (or wait) when it sees them low, so they all read high.
const I2C_PINS = [
  { sda: [0, 4, 8, 12, 16, 20], scl: [1, 5, 9, 13, 17, 21] },
  { sda: [2, 6, 10, 14, 18, 26], scl: [3, 7, 11, 15, 19, 27] },
];

/** Direction of a transaction as seen by the slave. */
export const I2C_WRITE = 0;
export const I2C_READ = 1;

/**
 * Base class of all fake I2C devices. Override the methods you need.
 */
export class I2CSlave {
  /**
   * @param {number} address 7-bit I2C address
   */
  constructor(address) {
    if (!Number.isInteger(address) || address < 0 || address > 0x7f) {
      throw new RangeError(`Invalid 7-bit I2C address: ${address}`);
    }
    this.address = address;
    /** Set to false to make the device disappear from the bus (it then NACKs its address). */
    this.enabled = true;
  }

  /** Called after the address was acknowledged. @param {0|1} mode I2C_WRITE or I2C_READ */
  start(mode) {} // eslint-disable-line no-unused-vars

  /** Called for each byte the controller writes. @param {number} byte @returns {boolean} true to ACK */
  write(byte) { // eslint-disable-line no-unused-vars
    return true;
  }

  /** Called for each byte the controller reads. @returns {number} 0..255 */
  read() {
    return 0xff;
  }

  /** Called on STOP. */
  stop() {}
}

/**
 * A programmable device with a flat table of 256 8-bit registers.
 *
 * Protocol: in a write transaction the first byte selects the register, further bytes are
 * stored from there (auto-incrementing by default). A read transaction returns bytes from
 * the current register, so "write pointer, repeated start, read" works as on real parts.
 */
export class RegisterSlave extends I2CSlave {
  /**
   * @param {object} options
   * @param {number} options.address 7-bit address
   * @param {Record<number, number>|Array<[number, number]>} [options.registers] initial register values
   * @param {number[]} [options.readOnly] registers that ignore writes (they are still ACKed)
   * @param {boolean} [options.autoIncrement=true] advance the register pointer after each byte
   * @param {(register: number, value: number, device: RegisterSlave) => void} [options.onWrite]
   *        called after a register was written by the firmware
   * @param {(register: number, device: RegisterSlave) => (number|undefined)} [options.onRead]
   *        called before a register is read; return a number to override the stored value
   */
  constructor({ address, registers = {}, readOnly = [], autoIncrement = true, onWrite, onRead }) {
    super(address);
    this.registers = new Uint8Array(256);
    for (const [reg, value] of Array.isArray(registers) ? registers : Object.entries(registers)) {
      this.registers[Number(reg) & 0xff] = value & 0xff;
    }
    this.readOnly = new Set(readOnly);
    this.autoIncrement = autoIncrement;
    this.onWrite = onWrite;
    this.onRead = onRead;
    /** Every register access made by the firmware, oldest first (capped at 10000 entries). */
    this.log = [];
    this._pointer = 0;
    this._expectPointer = true;
  }

  /** @param {number} register @returns {number} */
  get(register) {
    return this.registers[register & 0xff];
  }

  /** Store a byte, or a sequence of bytes starting at `register`. */
  set(register, value) {
    const bytes = typeof value === 'number' ? [value] : value;
    bytes.forEach((b, i) => {
      this.registers[(register + i) & 0xff] = b & 0xff;
    });
  }

  /** Store a signed 16-bit value in two consecutive registers (big-endian by default). */
  setInt16(register, value, { littleEndian = false } = {}) {
    const v = Math.max(-32768, Math.min(32767, Math.round(value))) & 0xffff;
    const [hi, lo] = [v >> 8, v & 0xff];
    this.set(register, littleEndian ? [lo, hi] : [hi, lo]);
  }

  /** Values the firmware wrote to `register`, in order. @param {number} register @returns {number[]} */
  writesTo(register) {
    return this.log.filter((e) => e.type === 'write' && e.register === register).map((e) => e.value);
  }

  clearLog() {
    this.log.length = 0;
  }

  _record(type, register, value) {
    if (this.log.length < 10000) this.log.push({ type, register, value });
  }

  start(mode) {
    if (mode === I2C_WRITE) this._expectPointer = true;
  }

  write(byte) {
    if (this._expectPointer) {
      this._pointer = byte & 0xff;
      this._expectPointer = false;
      return true;
    }
    const reg = this._pointer;
    if (!this.readOnly.has(reg)) this.registers[reg] = byte & 0xff;
    this._record('write', reg, byte & 0xff);
    if (this.autoIncrement) this._pointer = (reg + 1) & 0xff;
    this.onWrite?.(reg, byte & 0xff, this);
    return true;
  }

  read() {
    const reg = this._pointer;
    const override = this.onRead?.(reg, this);
    const value = (override ?? this.registers[reg]) & 0xff;
    this._record('read', reg, value);
    if (this.autoIncrement) this._pointer = (reg + 1) & 0xff;
    return value;
  }

  stop() {
    this._expectPointer = true;
  }
}

/**
 * One emulated I2C controller (I2C0 or I2C1) with the fake devices wired to it.
 * Obtain it with `board.i2c(index, { sda, scl })`.
 *
 * Hardware I2C transactions are timed on the emulated clock from the controller's SCL
 * counters, so a 400 kHz bus takes about as long as it would on a board. Software I2C
 * (`machine.SoftI2C`) is also supported when `sda` and `scl` pins are given.
 */
export class I2CBus {
  /**
   * @param {import('rp2040js').RP2040} mcu
   * @param {import('rp2040js').RPI2C} controller
   * @param {0|1} index controller number
   * @param {{sda?: number, scl?: number, simulateTiming?: boolean}} [options]
   */
  constructor(mcu, controller, index, options = {}) {
    this.mcu = mcu;
    this.controller = controller;
    this.simulateTiming = options.simulateTiming ?? true;
    this.sda = options.sda ?? null;
    this.scl = options.scl ?? null;
    /** @type {Map<number, I2CSlave>} */
    this.devices = new Map();
    this.active = null;
    /** Counters since boot. */
    this.stats = { transactions: 0, bytesWritten: 0, bytesRead: 0, nacks: 0 };
    this._pending = null;
    this._alarm = mcu.clock.createAlarm(() => {
      const fn = this._pending;
      this._pending = null;
      fn?.();
    });
    const { sda, scl } = I2C_PINS[index];
    for (const pin of [...sda, ...scl]) mcu.gpio[pin].setInputValue(true);
    this._bindController();
    // MicroPython scans the bus (and SoftI2C talks) by wiggling the pins itself, so the bus also
    // decodes the pin pairs the controller can use, plus the pair given by the caller.
    const pairs = sda.map((pin, i) => [pin, scl[i]]);
    if (this.sda !== null && this.scl !== null && !pairs.some(([a, b]) => a === this.sda && b === this.scl)) {
      pairs.push([this.sda, this.scl]);
    }
    for (const [sdaPin, sclPin] of pairs) this._bindBitBang(sdaPin, sclPin);
  }

  /**
   * Connect a device to the bus.
   * @template {I2CSlave} T
   * @param {T} device
   * @returns {T} the same device, for chaining
   */
  attach(device) {
    this.devices.set(device.address, device);
    return device;
  }

  /** Remove the device at `address`, if any. */
  detach(address) {
    this.devices.delete(address);
  }

  _lookup(address) {
    const device = this.devices.get(address & 0x7f);
    return device && device.enabled !== false ? device : null;
  }

  _bitNanos() {
    const { sclLowPeriod, sclHighPeriod } = this.controller;
    const ticks = Math.max(10, (sclLowPeriod || 0) + (sclHighPeriod || 0) + 8);
    // The DW_apb_i2c block is clocked from clk_sys on the RP2040.
    return (ticks / (this.mcu.clkSys || 125e6)) * 1e9;
  }

  _after(bits, fn) {
    if (!this.simulateTiming) {
      fn();
      return;
    }
    this._pending = fn;
    this._alarm.schedule(Math.max(1, Math.round(bits * this._bitNanos())));
  }

  _bindController() {
    const c = this.controller;
    c.onStart = () => this._after(1.5, () => c.completeStart());
    c.onConnect = (address, mode) =>
      this._after(9, () => {
        this.active = this._lookup(address);
        if (this.active) {
          this.stats.transactions++;
          this.active.start(mode);
          c.completeConnect(true);
        } else {
          this.stats.nacks++;
          c.completeConnect(false);
        }
      });
    c.onWriteByte = (byte) =>
      this._after(9, () => {
        if (!this.active) {
          this.stats.nacks++;
          c.completeWrite(false);
          return;
        }
        this.stats.bytesWritten++;
        const ack = this.active.write(byte & 0xff) !== false;
        if (!ack) this.stats.nacks++;
        c.completeWrite(ack);
      });
    c.onReadByte = () =>
      this._after(9, () => {
        this.stats.bytesRead++;
        c.completeRead(this.active ? this.active.read() & 0xff : 0xff);
      });
    c.onStop = () =>
      this._after(1.5, () => {
        this.active?.stop();
        this.active = null;
        c.completeStop();
      });
  }

  // Software I2C: watch the two pins, decode START / STOP / bytes, answer as a slave.
  _bindBitBang(sdaPin, sclPin) {
    const sda = this.mcu.gpio[sdaPin];
    const scl = this.mcu.gpio[sclPin];
    sda.setInputValue(true); // pull-ups
    scl.setInputValue(true);

    const high = (pin) => !(pin.outputEnable && !pin.outputValue);
    let prevSda = high(sda);
    let prevScl = high(scl);
    let phase = 'idle';
    let bit = 0;
    let shift = 0;
    let mode = 0;
    let tx = 0xff;
    let lastAck = false;
    let device = null;

    const idle = () => {
      phase = 'idle';
      bit = 0;
      shift = 0;
      device = null;
      sda.setInputValue(true);
    };

    const onChange = () => {
      if (sda.functionSelect !== FUNCTION_SIO || scl.functionSelect !== FUNCTION_SIO) {
        prevSda = high(sda);
        prevScl = high(scl);
        if (phase !== 'idle') idle();
        return;
      }
      const curSda = high(sda);
      const curScl = high(scl);

      if (curScl && prevScl && curSda !== prevSda) {
        if (!curSda) {
          phase = 'address'; // START or repeated START
          bit = 0;
          shift = 0;
          device = null;
          sda.setInputValue(true);
        } else {
          device?.stop();
          idle(); // STOP
        }
      }

      if (curScl && !prevScl) {
        // rising edge of SCL: the controller's bit is stable, sample it
        if (phase === 'address') {
          shift = (shift << 1) | (curSda ? 1 : 0);
          if (++bit === 8) {
            mode = shift & 1;
            device = this._lookup((shift >> 1) & 0x7f);
            if (device) {
              this.stats.transactions++;
              device.start(mode);
            }
            phase = 'address-ack';
          }
        } else if (phase === 'address-ack') {
          if (!device) {
            phase = 'idle';
          } else {
            phase = mode ? 'read' : 'write';
            bit = 0;
            shift = 0;
          }
        } else if (phase === 'write') {
          shift = (shift << 1) | (curSda ? 1 : 0);
          if (++bit === 8) {
            this.stats.bytesWritten++;
            lastAck = device ? device.write(shift & 0xff) !== false : false;
            phase = 'write-ack';
          }
        } else if (phase === 'write-ack') {
          phase = 'write';
          bit = 0;
          shift = 0;
        } else if (phase === 'read-ack') {
          if (!curSda) {
            phase = 'read';
            bit = 0;
          } else {
            phase = 'idle';
          }
        }
      }

      if (!curScl && prevScl) {
        // falling edge of SCL: drive the next bit / ACK
        if (phase === 'address-ack') {
          sda.setInputValue(!device);
        } else if (phase === 'write-ack') {
          sda.setInputValue(!lastAck);
        } else if (phase === 'read') {
          if (bit === 0) {
            tx = device ? device.read() & 0xff : 0xff;
            this.stats.bytesRead++;
          }
          sda.setInputValue(((tx >> (7 - bit)) & 1) === 1);
          if (++bit === 8) phase = 'read-ack';
        } else {
          sda.setInputValue(true);
        }
      }

      prevSda = curSda;
      prevScl = curScl;
    };

    sda.addListener(onChange);
    scl.addListener(onChange);
  }
}
