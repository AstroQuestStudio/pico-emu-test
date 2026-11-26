// Boot ROM handling. The RP2040 boot ROM is 16 KiB of read-only code at address 0 that
// MicroPython calls into (memory routines, flash helpers, soft-float tables). The emulator
// cannot start without it. It is not stored in this repository: see assets.js.

import fs from 'node:fs';
import { BOOTROM_B1, ensureAsset } from './assets.js';

const ROM_SIZE = 0x4000;

/**
 * Extract the 16 KiB boot ROM image from an ELF32 file (the format of the official release).
 * @param {Uint8Array} bytes
 * @returns {Uint32Array}
 */
export function bootromFromElf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 1 || bytes[5] !== 1) {
    throw new Error('Not a little-endian ELF32 file');
  }
  const phoff = view.getUint32(28, true);
  const phentsize = view.getUint16(42, true);
  const phnum = view.getUint16(44, true);
  const rom = new Uint8Array(ROM_SIZE);
  let loaded = 0;
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    const type = view.getUint32(ph, true);
    const offset = view.getUint32(ph + 4, true);
    const paddr = view.getUint32(ph + 12, true);
    const filesz = view.getUint32(ph + 16, true);
    if (type !== 1 || filesz === 0 || paddr >= ROM_SIZE) continue;
    if (paddr + filesz > ROM_SIZE) throw new Error('ELF segment does not fit in the 16 KiB boot ROM');
    rom.set(bytes.subarray(offset, offset + filesz), paddr);
    loaded += filesz;
  }
  if (loaded === 0) throw new Error('No loadable segment at address 0 in the ELF file');
  return new Uint32Array(rom.buffer);
}

/**
 * Turn the `bootrom` option into the 32-bit word array the emulator wants.
 *
 * Resolution order: an explicit value (Uint32Array, or the path of a .elf / 16 KiB .bin file),
 * then the PICO_EMU_BOOTROM environment variable, then the cached official B1 image
 * (downloaded and verified on first use).
 *
 * @param {Uint32Array|string|undefined} source
 * @param {{log?: (msg: string) => void}} [options]
 * @returns {Promise<Uint32Array>}
 */
export async function resolveBootrom(source, options = {}) {
  if (source instanceof Uint32Array) {
    if (source.length !== ROM_SIZE / 4) throw new Error('A boot ROM must be 4096 32-bit words');
    return source;
  }
  const file = source ?? process.env.PICO_EMU_BOOTROM ?? (await ensureAsset(BOOTROM_B1, options));
  const bytes = fs.readFileSync(file);
  if (bytes.length === ROM_SIZE) {
    return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + ROM_SIZE));
  }
  return bootromFromElf(bytes);
}
