import { Board, fetchOfficialFirmware } from '../src/index.js';

let firmwarePromise;

/** Path of the firmware under test: $PICO_FIRMWARE, or the official image (downloaded once). */
export function firmwarePath() {
  firmwarePromise ??= process.env.PICO_FIRMWARE
    ? Promise.resolve(process.env.PICO_FIRMWARE)
    : fetchOfficialFirmware('pico', { log: (m) => console.error(m) });
  return firmwarePromise;
}

/**
 * Boot a board, run `fn`, and always stop the board afterwards.
 * @param {(board: Board) => Promise<void>} fn
 * @param {Partial<import('../src/board.js').BoardOptions>} [options]
 */
export async function withBoard(fn, options = {}) {
  const board = await Board.boot({ firmware: await firmwarePath(), ...options });
  try {
    await fn(board);
  } finally {
    board.stop();
  }
}
