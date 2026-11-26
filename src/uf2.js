// UF2 container parsing (https://github.com/microsoft/uf2).

const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_NOT_MAIN_FLASH = 0x00000001;

export const FLASH_BASE = 0x10000000;

/**
 * Copy the payload of every valid UF2 block that targets flash into `flash`.
 *
 * @param {Uint8Array} uf2 file contents
 * @param {Uint8Array} flash the emulated flash array (indexed from 0x10000000)
 * @returns {number} number of blocks written
 */
export function loadUf2(uf2, flash) {
  const view = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  let blocks = 0;
  for (let off = 0; off + 512 <= uf2.length; off += 512) {
    if (
      view.getUint32(off, true) !== MAGIC_START0 ||
      view.getUint32(off + 4, true) !== MAGIC_START1 ||
      view.getUint32(off + 508, true) !== MAGIC_END
    ) {
      continue;
    }
    if (view.getUint32(off + 8, true) & FLAG_NOT_MAIN_FLASH) continue;
    const target = view.getUint32(off + 12, true) - FLASH_BASE;
    const size = view.getUint32(off + 16, true);
    if (size > 476 || target < 0 || target + size > flash.length) continue;
    flash.set(uf2.subarray(off + 32, off + 32 + size), target);
    blocks++;
  }
  if (blocks === 0) throw new Error('No valid UF2 block targeting flash was found');
  return blocks;
}
