// Fidelity fixes applied to rp2040js 1.4.2 at run time (nothing in node_modules is modified).
// Each one corrects behaviour that real firmware relies on; each is described in the README.

import { EmulationError } from './errors.js';

const SIO_FIFO_ST = 0x50;
const SIO_FIFO_WR = 0x54;
const SIO_FIFO_RD = 0x58;
const SIO_FIFO_ST_RDY = 1 << 1;

const UART_DR = 0x00;
const UART_IMSC = 0x38;
const UART_TX_INTERRUPT = 1 << 5;

/**
 * @param {import('./board.js').Board} board
 */
export function applyPatches(board) {
  const { mcu } = board;

  // 1. A pin the firmware drives as an output reads back its own level (as on silicon).
  //    rp2040js returns the externally applied level instead, so `led.value()` read 0 after `led.value(1)`.
  for (const gpio of mcu.gpio) {
    const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(gpio), 'inputValue').get;
    Object.defineProperty(gpio, 'inputValue', {
      get() {
        return this.outputEnable ? this.outputValue : original.call(this);
      },
    });
  }

  // 2. The UART transmit interrupt. rp2040js re-asserts it after every register access, so it can
  //    never be cleared and MicroPython's UART driver spins in its interrupt handler forever.
  //    Model it like the PL011: raised when a byte has been sent or when the interrupt is unmasked
  //    (the transmit FIFO is always empty), cleared by the interrupt-clear register.
  for (const uart of mcu.uart) {
    uart.checkInterrupts = function checkInterrupts() {
      this.rp2040.setInterrupt(this.irq, Boolean(this.interruptStatus & this.interruptMask));
    };
    const write = uart.writeUint32.bind(uart);
    uart.writeUint32 = (offset, value) => {
      write(offset, value);
      if (offset === UART_DR || (offset === UART_IMSC && value & UART_TX_INTERRUPT)) {
        uart.interruptStatus |= UART_TX_INTERRUPT;
        uart.checkInterrupts();
      }
    };
  }

  // 3. There is no second core. The SIO inter-core FIFO is where the SDK's launch handshake
  //    (and `_thread.start_new_thread`) talks to core 1; without an answer the firmware would wait
  //    for ever. Report "ready to write, nothing to read", and stop with a clear message as soon as
  //    the firmware writes to the FIFO, instead of hanging until a timeout.
  const sio = mcu.sio;
  const sioRead = sio.readUint32.bind(sio);
  const sioWrite = sio.writeUint32.bind(sio);
  sio.readUint32 = (offset) => {
    if (offset === SIO_FIFO_ST) return SIO_FIFO_ST_RDY;
    if (offset === SIO_FIFO_RD) return 0;
    return sioRead(offset);
  };
  sio.writeUint32 = (offset, value) => {
    if (offset === SIO_FIFO_WR) {
      board._fail(
        new EmulationError(
          'The firmware used the second core (_thread, or the multicore FIFO). ' +
            'Core 1 is not emulated, so this can never complete.',
        ),
      );
      return;
    }
    sioWrite(offset, value);
  };
}
