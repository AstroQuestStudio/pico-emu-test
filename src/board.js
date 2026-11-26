// The emulated board: a RP2040 (rp2040js) with a boot ROM, a UF2 image in flash, a USB serial
// console, and hooks for fake peripherals.

import fs from 'node:fs';
import { ConsoleLogger, LogLevel, Simulator, USBCDC } from 'rp2040js';
import { resolveBootrom } from './bootrom.js';
import { EmulationError, PythonError, TimeoutError } from './errors.js';
import { I2CBus } from './i2c.js';
import { applyPatches } from './patches.js';
import { Pin } from './pin.js';
import { Uart } from './uart.js';
import { FLASH_BASE, loadUf2 } from './uf2.js';

const RAW_REPL_BANNER = 'raw REPL; CTRL-B to exit\r\n>';
const SERIAL_LOG_LIMIT = 1 << 20;
const TX_FIFO_MARGIN = 16;
const ADC_VREF = 3.3;

// A block device backed by a bytearray, handed to os.VfsFat. Runs on the board.
const RAM_BLOCK_DEVICE_PY = `import os
class _PicoEmuRamBlocks:
    def __init__(self, blocks):
        self.data = bytearray(blocks * 512)
    def readblocks(self, n, buf, off=0):
        o = n * 512 + off
        buf[:] = self.data[o:o + len(buf)]
    def writeblocks(self, n, buf, off=None):
        o = n * 512 + (off or 0)
        self.data[o:o + len(buf)] = buf
    def ioctl(self, op, arg):
        if op == 4:
            return len(self.data) // 512
        if op == 5:
            return 512
        return 0`;

/**
 * @typedef {object} BoardOptions
 * @property {string|Uint8Array} firmware  path of a .uf2 file, or its bytes
 * @property {Uint32Array|string} [bootrom]  boot ROM words, or path of a .elf / 16 KiB .bin
 *           (default: the official RP2040 B1 ROM, downloaded and cached on first use)
 * @property {string|Uint8Array} [flashImage]  raw bytes copied into flash after the UF2
 *           (for example a prebuilt filesystem)
 * @property {number} [flashImageOffset=0xa0000]  offset of `flashImage` from the start of flash
 * @property {boolean} [i2cTiming=true]  time hardware I2C transactions like a real bus
 * @property {boolean} [verbose=false]  print emulator warnings on stderr
 * @property {(message: string) => void} [log]  progress messages (downloads)
 */

export { EmulationError, PythonError, TimeoutError };

export class Board {
  /**
   * Build a board without starting it, so peripherals can be attached first.
   * @param {BoardOptions} options
   * @returns {Promise<Board>}
   */
  static async create(options) {
    const bootrom = await resolveBootrom(options.bootrom, { log: options.log });
    return new Board(options, bootrom);
  }

  /**
   * Build a board, start it and wait for the MicroPython prompt.
   * @param {BoardOptions & {bootTimeoutMs?: number}} options
   * @returns {Promise<Board>}
   */
  static async boot(options) {
    const board = await Board.create(options);
    try {
      await board.start({ timeoutMs: options.bootTimeoutMs });
    } catch (err) {
      board.stop();
      throw err;
    }
    return board;
  }

  /** @private use Board.create() or Board.boot() */
  constructor(options, bootrom) {
    this.options = options;
    this.simulator = new Simulator();
    /** The underlying rp2040js `RP2040` object, for anything this library does not cover. */
    this.mcu = this.simulator.rp2040;
    this.mcu.loadBootrom(bootrom);
    this.mcu.logger = new ConsoleLogger(options.verbose ? LogLevel.Warn : LogLevel.Error);

    const image = typeof options.firmware === 'string' ? fs.readFileSync(options.firmware) : options.firmware;
    /** Number of UF2 blocks loaded into flash. */
    this.uf2Blocks = loadUf2(image, this.mcu.flash);
    if (options.flashImage) {
      const data = typeof options.flashImage === 'string' ? fs.readFileSync(options.flashImage) : options.flashImage;
      const offset = options.flashImageOffset ?? 0xa0000;
      if (offset + data.length > this.mcu.flash.length) throw new Error('flashImage does not fit in flash');
      this.mcu.flash.set(data, offset);
    }

    applyPatches(this);

    /** @type {Map<number, I2CBus>} */
    this._i2c = new Map();
    /** @type {Map<number, Uart>} */
    this._uarts = new Map();
    /** @type {Map<number, Pin>} */
    this._pins = new Map();
    /** @type {Pin[]} */
    this._allPins = this.mcu.gpio.map((_, i) => this.pin(i)); // record every pin from the first instruction

    /** Everything the board printed on its USB serial port (last 1 MiB), as text. */
    this.serialLog = '';
    this._serialListeners = new Set();
    this._txQueue = [];
    this._txTimer = null;
    this._running = false;
    this._queue = Promise.resolve();
    this._startedAt = 0;
    this._ramFs = false;
    this._failure = null;
    this._failHandlers = new Set();

    this.cdc = new USBCDC(this.mcu.usbCtrl);
    this.cdc.onDeviceConnected = () => this._write('\r\n'); // wake the REPL up
    this.cdc.onSerialData = (data) => {
      const chunk = Buffer.from(data);
      this.serialLog = (this.serialLog + chunk.toString('utf8')).slice(-SERIAL_LOG_LIMIT);
      for (const listener of this._serialListeners) listener(chunk);
    };
  }

  /** Emulated time since power-on, in milliseconds. */
  get timeMs() {
    return this.mcu.clock.nanos / 1e6;
  }

  /** The pin used for the on-board LED on a Pico (GP25). Not available on a Pico W (the LED hangs off the radio chip). */
  get led() {
    return this.pin(25);
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Power the board on and wait for the MicroPython prompt.
   * @param {{timeoutMs?: number}} [options] wall-clock limit (default 20000)
   * @returns {Promise<string>} the boot banner
   */
  async start({ timeoutMs = 20000 } = {}) {
    if (this._running) throw new Error('The board is already running');
    this._running = true;
    this._startedAt = Date.now();
    this.mcu.core.PC = FLASH_BASE;
    const prompt = this._waitSerial((text) => text.includes('>>>'), timeoutMs);
    this.simulator.execute();
    try {
      return await prompt;
    } catch (err) {
      if (err instanceof EmulationError) throw err;
      throw new TimeoutError(
        `The firmware did not reach the MicroPython prompt within ${timeoutMs} ms. ` +
          `Serial output so far: ${JSON.stringify(this.serialLog.slice(-300))}`,
        this.serialLog,
      );
    }
  }

  /** Stop the emulation and release timers. The board cannot be restarted. */
  stop() {
    this.simulator.stop();
    for (const pio of this.mcu.pio) pio.stop(); // the PIO blocks run on their own host timers
    this._running = false;
    if (this._txTimer) clearInterval(this._txTimer);
    this._txTimer = null;
  }

  // ------------------------------------------------------------ serial plumbing

  /**
   * Subscribe to the bytes the board sends on its serial port.
   * @param {(chunk: Buffer) => void} listener
   * @returns {() => void} unsubscribe function
   */
  onSerial(listener) {
    this._serialListeners.add(listener);
    return () => this._serialListeners.delete(listener);
  }

  /** Send bytes (or text) to the board's serial port. */
  write(data) {
    this._write(data);
  }

  _write(data) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (const b of bytes) this._txQueue.push(b);
    this._pump();
    if (this._txQueue.length && !this._txTimer) {
      this._txTimer = setInterval(() => this._pump(), 1);
    }
  }

  // The USB endpoint buffer is small: feed it only as fast as the firmware drains it.
  _pump() {
    const fifo = this.cdc.txFIFO;
    while (this._txQueue.length && fifo.itemCount < fifo.size - TX_FIFO_MARGIN) {
      this.cdc.sendSerialByte(this._txQueue.shift());
    }
    if (!this._txQueue.length && this._txTimer) {
      clearInterval(this._txTimer);
      this._txTimer = null;
    }
  }

  // Resolve when `predicate(text received since now)` is true.
  _waitSerial(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this._failure) {
        reject(this._failure);
        return;
      }
      let text = '';
      const done = () => {
        clearTimeout(timer);
        off();
        this._failHandlers.delete(onFail);
      };
      const onFail = (err) => {
        done();
        reject(err);
      };
      const timer = setTimeout(() => {
        done();
        reject(new TimeoutError(`No expected serial output within ${timeoutMs} ms`, text));
      }, timeoutMs);
      const off = this.onSerial((chunk) => {
        text += chunk.toString('latin1');
        if (predicate(text)) {
          done();
          resolve(text);
        }
      });
      this._failHandlers.add(onFail);
    });
  }

  // The emulation cannot continue (a feature is missing): stop it and fail everything that waits.
  _fail(error) {
    if (this._failure) return;
    this._failure = error;
    this.simulator.stop();
    for (const handler of [...this._failHandlers]) handler(error);
  }

  // ------------------------------------------------------------------ Python

  /**
   * Run Python code in the raw REPL and return what it printed and raised.
   * Calls are serialised: concurrent calls run one after the other.
   *
   * @param {string} code
   * @param {{timeoutMs?: number}} [options] wall-clock limit (default 30000)
   * @returns {Promise<{ok: boolean, stdout: string, stderr: string, timeMs: number}>}
   *          `timeMs` is the emulated time the call took.
   */
  run(code, { timeoutMs = 30000 } = {}) {
    const job = this._queue.then(() => this._runRaw(code, timeoutMs));
    this._queue = job.catch(() => {});
    return job;
  }

  /**
   * Run Python code and return what it printed. Throws `PythonError` if it raises.
   * @param {string} code
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<string>} stdout, with line ends normalised to "\n"
   */
  async exec(code, options) {
    const result = await this.run(code, options);
    if (!result.ok) throw new PythonError(result.stderr, result.stdout);
    return result.stdout;
  }

  /**
   * Evaluate a Python expression whose value is JSON-serialisable (numbers, strings, lists, dicts...).
   * @param {string} expression
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<any>}
   */
  async evalJson(expression, options) {
    const out = await this.exec(`import json\nprint(json.dumps(${expression}))`, options);
    return JSON.parse(out.trim().split('\n').pop());
  }

  async _runRaw(code, timeoutMs) {
    const t0 = this.timeMs;
    let partial = '';
    const watchdog = this._watchForDeadlock();
    try {
      // 1. interrupt whatever is running and enter the raw REPL
      const entered = this._waitSerial((t) => t.includes(RAW_REPL_BANNER), Math.min(timeoutMs, 10000));
      this._write('\x03\x03\x01');
      await entered;

      // 2. send the program, then Ctrl-D; the reply is "OK" stdout EOT stderr EOT ">"
      const reply = this._waitSerial((t) => {
        partial = t;
        const first = t.indexOf('\x04');
        if (!t.startsWith('OK') || first < 0) return false;
        const second = t.indexOf('\x04', first + 1);
        return second >= 0 && t.indexOf('>', second) >= 0;
      }, timeoutMs);
      this._write(code);
      this._write('\x04');
      const raw = await reply;

      const first = raw.indexOf('\x04');
      const second = raw.indexOf('\x04', first + 1);
      const decode = (s) => Buffer.from(s, 'latin1').toString('utf8').replace(/\r\n/g, '\n');
      const stdout = decode(raw.slice(2, first));
      const stderr = decode(raw.slice(first + 1, second));
      return { ok: stderr === '', stdout, stderr, timeMs: this.timeMs - t0 };
    } catch (err) {
      if (err instanceof TimeoutError) {
        this._write('\x03\x03'); // try to get the prompt back for the next call
        throw new TimeoutError(
          `Python code did not finish within ${timeoutMs} ms (wall clock). Output so far: ${JSON.stringify(partial.slice(0, 300))}`,
          partial,
        );
      }
      throw err;
    } finally {
      clearInterval(watchdog);
    }
  }

  // The CPU sleeps (WFE/WFI) and no timer is scheduled: nothing can ever wake it up. The usual cause is
  // code that waits for the second core, which does not exist. Fail with that explanation instead of
  // waiting for the timeout.
  _watchForDeadlock() {
    let strikes = 0;
    const timer = setInterval(() => {
      const asleep = this.mcu.core.waiting && !this.mcu.clock.nextAlarm;
      strikes = asleep ? strikes + 1 : 0;
      if (strikes >= 5) {
        this._fail(
          new EmulationError(
            'The CPU is asleep and nothing is scheduled to wake it: the firmware waits for an event that cannot happen. ' +
              'The usual cause is code that waits for the second core (_thread, multicore), which is not emulated. ' +
              'machine.soft_reset() and machine.reset() end the same way: to restart a board, boot a new one.',
          ),
        );
      }
    }, 100);
    timer.unref?.();
    return timer;
  }

  /** Interrupt the running Python program (Ctrl-C twice). */
  interrupt() {
    this._write('\x03\x03');
  }

  /**
   * Let emulated time pass without running any Python: resolves once the clock has advanced by `ms`.
   * The emulation is paused at that exact instant while your code runs its next synchronous
   * statements (so a pin read right after `await board.sleep(5)` sees the state at +5 ms), then resumes.
   *
   * @param {number} ms emulated milliseconds
   */
  sleep(ms) {
    return new Promise((resolve) => {
      this.mcu.clock
        .createAlarm(() => {
          this.simulator.stop();
          resolve();
          setImmediate(() => {
            if (this._running && !this._failure && this.simulator.stopped) this.simulator.execute();
          });
        })
        .schedule(ms * 1e6);
    });
  }

  // ------------------------------------------------------------------- files

  /**
   * Mount a FAT filesystem held in RAM as the root filesystem ("/").
   *
   * The emulator cannot write to flash (see README), so MicroPython boots with no usable root
   * filesystem. This gives the firmware a working one. It is called automatically by `writeFile`
   * unless the board was created with a `flashImage`.
   *
   * @param {{sizeKb?: number}} [options] size of the RAM disk (default 64 KiB, taken from the 264 KiB of RAM)
   */
  async mountRamFs({ sizeKb = 64 } = {}) {
    const blocks = Math.max(16, Math.round((sizeKb * 1024) / 512));
    await this.exec(
      [
        RAM_BLOCK_DEVICE_PY,
        `_pico_emu_dev = _PicoEmuRamBlocks(${blocks})`,
        'os.VfsFat.mkfs(_pico_emu_dev)',
        "os.mount(os.VfsFat(_pico_emu_dev), '/')",
        "os.chdir('/')",
        'del _PicoEmuRamBlocks',
      ].join('\n'),
    );
    this._ramFs = true;
  }

  /**
   * Create or replace a file on the board's filesystem. Parent directories are created.
   * Mounts a RAM filesystem first if the board has none yet.
   *
   * @param {string} path absolute path on the board, for example "/main.py" or "/lib/driver.py"
   * @param {string|Uint8Array} data
   */
  async writeFile(path, data) {
    if (!this._ramFs && !this.options.flashImage) await this.mountRamFs();
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const parts = path.split('/').filter(Boolean);
    const lines = ['import os, binascii'];
    for (let i = 1; i < parts.length; i++) {
      lines.push('try:', ` os.mkdir(${JSON.stringify('/' + parts.slice(0, i).join('/'))})`, 'except OSError:', ' pass');
    }
    lines.push(`_f = open(${JSON.stringify(path)}, 'wb')`);
    await this.exec(lines.join('\n'));
    const CHUNK = 3072; // raw bytes per statement (4096 base64 characters)
    const PER_CALL = 4;
    for (let off = 0; off < bytes.length; off += CHUNK * PER_CALL) {
      const statements = [];
      for (let o = off; o < Math.min(bytes.length, off + CHUNK * PER_CALL); o += CHUNK) {
        statements.push(`_f.write(binascii.a2b_base64(b'${bytes.subarray(o, o + CHUNK).toString('base64')}'))`);
      }
      await this.exec(statements.join('\n'));
    }
    await this.exec(['_f.close()', 'del _f'].join('\n'));
  }

  /**
   * Read a file from the board.
   * @param {string} path
   * @returns {Promise<Buffer>}
   */
  async readFile(path) {
    const out = await this.exec(
      [
        'import binascii',
        `with open(${JSON.stringify(path)}, 'rb') as f:`,
        ' d = f.read()',
        'print(binascii.b2a_base64(d).decode())',
      ].join('\n'),
    );
    return Buffer.from(out.replace(/\s+/g, ''), 'base64');
  }

  /**
   * List a directory of the board's filesystem.
   * @param {string} [path='/']
   * @returns {Promise<string[]>}
   */
  listDir(path = '/') {
    return this.evalJson(`__import__('os').listdir(${JSON.stringify(path)})`);
  }

  // -------------------------------------------------------------- peripherals

  /**
   * One GPIO pin (0..29).
   * @param {number} index
   * @returns {Pin}
   */
  pin(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.mcu.gpio.length) {
      throw new RangeError(`GPIO ${index} does not exist (0..${this.mcu.gpio.length - 1})`);
    }
    let pin = this._pins.get(index);
    if (!pin) {
      pin = new Pin(this, index);
      this._pins.set(index, pin);
    }
    return pin;
  }

  /**
   * One of the two UARTs, to capture what the firmware sends and feed it bytes.
   * @param {0|1} index
   * @returns {Uart}
   */
  uart(index) {
    if (index !== 0 && index !== 1) throw new RangeError('The RP2040 has two UARTs: 0 and 1');
    let uart = this._uarts.get(index);
    if (!uart) {
      uart = new Uart(this, index);
      this._uarts.set(index, uart);
    }
    return uart;
  }

  /**
   * Set what an ADC input reads. Channels 0..3 are GP26..GP29; channel 4 is the internal temperature sensor.
   * @param {0|1|2|3|4} channel
   * @param {{volts?: number, raw?: number}} value voltage (0..3.3, the reference is assumed to be 3.3 V) or the 12-bit code
   */
  setAdc(channel, { volts, raw }) {
    const values = this.mcu.adc.channelValues;
    if (!Number.isInteger(channel) || channel < 0 || channel >= values.length) {
      throw new RangeError(`ADC channel ${channel} does not exist (0..${values.length - 1})`);
    }
    const code = raw ?? Math.round((volts / ADC_VREF) * 4095);
    values[channel] = Math.max(0, Math.min(4095, code));
  }

  /**
   * One of the two I2C controllers, ready to receive fake devices with `bus.attach(device)`.
   * Give `sda` and `scl` to also support `machine.SoftI2C` on those pins.
   *
   * @param {0|1} index controller number
   * @param {{sda?: number, scl?: number}} [pins]
   * @returns {I2CBus}
   */
  i2c(index, pins = {}) {
    let bus = this._i2c.get(index);
    if (!bus) {
      if (index !== 0 && index !== 1) throw new RangeError('The RP2040 has two I2C controllers: 0 and 1');
      bus = new I2CBus(this.mcu, this.mcu.i2c[index], index, {
        sda: pins.sda,
        scl: pins.scl,
        simulateTiming: this.options.i2cTiming ?? true,
      });
      this._i2c.set(index, bus);
    }
    return bus;
  }
}
