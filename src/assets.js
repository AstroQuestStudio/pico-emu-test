// Downloading and caching of the two third-party binaries the emulator needs:
//   * the RP2040 boot ROM (Raspberry Pi, build B1)
//   * an official MicroPython firmware image
// Neither is stored in this repository; both are fetched on demand and verified
// against a pinned SHA-256 digest.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BOOTROM_B1 = Object.freeze({
  file: 'rp2040-bootrom-b1.elf',
  url: 'https://github.com/raspberrypi/pico-bootrom-rp2040/releases/download/b1/b1.elf',
  sha256: '53b2723b590207c678c5a52c095e9150d2afa60e7f66a1c26d188ff59d29c778',
});

/** Official MicroPython images known to work, keyed by board name. */
export const OFFICIAL_FIRMWARE = Object.freeze({
  pico: Object.freeze({
    file: 'RPI_PICO-20260824-v1.29.0.uf2',
    url: 'https://micropython.org/resources/firmware/RPI_PICO-20260824-v1.29.0.uf2',
    sha256: 'e1160e602e277d85920adb5fe741435edccba9ba6ecadc85fdab75252eeff4e9',
  }),
  'pico-w': Object.freeze({
    file: 'RPI_PICO_W-20260824-v1.29.0.uf2',
    url: 'https://micropython.org/resources/firmware/RPI_PICO_W-20260824-v1.29.0.uf2',
    sha256: 'f918c0a082c6daf53e27998b7f990ba5f065db2e298b21a34024532a20786794',
  }),
});

/**
 * Directory where downloaded assets are cached.
 * Override with the PICO_EMU_CACHE_DIR environment variable.
 * @returns {string}
 */
export function cacheDir() {
  if (process.env.PICO_EMU_CACHE_DIR) return path.resolve(process.env.PICO_EMU_CACHE_DIR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'pico-emu-test');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'pico-emu-test');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Return the cached copy of `asset`, downloading it first if needed.
 * The file is checked against the pinned SHA-256 digest in both cases.
 *
 * @param {{file: string, url: string, sha256: string}} asset
 * @param {{dir?: string, offline?: boolean, log?: (msg: string) => void}} [options]
 * @returns {Promise<string>} absolute path of the verified file
 */
export async function ensureAsset(asset, options = {}) {
  const dir = options.dir ?? cacheDir();
  const target = path.join(dir, asset.file);
  if (fs.existsSync(target)) {
    if (sha256File(target) === asset.sha256) return target;
    fs.rmSync(target);
  }
  if (options.offline ?? process.env.PICO_EMU_OFFLINE === '1') {
    throw new Error(
      `${asset.file} is not in the cache (${dir}) and PICO_EMU_OFFLINE=1 forbids downloading it. ` +
        `Fetch it from ${asset.url} and place it there, or point to your own copy.`,
    );
  }
  options.log?.(`downloading ${asset.url}`);
  const response = await fetch(asset.url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download of ${asset.url} failed: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(
      `Downloaded ${asset.file} has SHA-256 ${digest}, expected ${asset.sha256}. ` +
        'The file was not saved.',
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Download (or find in the cache) an official MicroPython image.
 * @param {'pico'|'pico-w'} [board='pico']
 * @param {{dir?: string, offline?: boolean, log?: (msg: string) => void}} [options]
 * @returns {Promise<string>} path of the .uf2 file
 */
export function fetchOfficialFirmware(board = 'pico', options = {}) {
  const asset = OFFICIAL_FIRMWARE[board];
  if (!asset) {
    throw new Error(`Unknown board "${board}". Known boards: ${Object.keys(OFFICIAL_FIRMWARE).join(', ')}`);
  }
  return ensureAsset(asset, options);
}
