// Shared by the examples: boot the official MicroPython image (downloaded once and cached).
import { Board, fetchOfficialFirmware } from 'pico-emu-test';

export async function bootOfficial(options = {}) {
  const firmware = process.env.PICO_FIRMWARE ?? (await fetchOfficialFirmware('pico'));
  return Board.boot({ firmware, ...options });
}
