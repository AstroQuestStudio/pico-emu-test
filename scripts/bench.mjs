// Measures how fast the emulator runs compared with real time on this machine.
//
//   node scripts/bench.mjs [firmware.uf2]
//
// Every number is "emulated milliseconds" against "wall-clock milliseconds". A ratio below 1 means the
// emulator is slower than a real board.

import { Board, fetchOfficialFirmware } from '../src/index.js';

const firmware = process.argv[2] ?? (await fetchOfficialFirmware('pico'));

const t0 = performance.now();
const board = await Board.boot({ firmware });
const bootWall = performance.now() - t0;
console.log(`boot to prompt: ${board.timeMs.toFixed(1)} ms emulated, ${bootWall.toFixed(0)} ms wall`);

async function measure(label, code) {
  const wall = performance.now();
  const emulated = board.timeMs;
  await board.exec(code, { timeoutMs: 300000 });
  const w = performance.now() - wall;
  const e = board.timeMs - emulated;
  console.log(`${label.padEnd(34)} ${e.toFixed(1).padStart(9)} ms emulated ${w.toFixed(0).padStart(7)} ms wall   ratio ${(e / w).toFixed(2)}`);
}

await measure('empty call (round trip)', 'pass');
await measure('time.sleep(1)', 'import time\ntime.sleep(1)');
await measure('time.sleep(5)', 'import time\ntime.sleep(5)');
await measure('loop, 10000 iterations of pass', 'def f():\n    for i in range(10000):\n        pass\nf()');
await measure('loop, 100000 iterations of pass', 'def f():\n    for i in range(100000):\n        pass\nf()');

const wall = performance.now();
await board.writeFile('/blob.bin', Buffer.alloc(8192, 0x5a));
console.log(`copy 8 KiB to the board: ${(performance.now() - wall).toFixed(0)} ms wall (includes mounting the RAM filesystem)`);

// Timer accuracy: how long does the firmware think 100 ms is, in emulated time?
const out = await board.exec('import time\nt = time.ticks_us()\ntime.sleep_ms(100)\nprint(time.ticks_diff(time.ticks_us(), t))');
console.log(`time.sleep_ms(100) measured by the firmware's own ticks_us(): ${out.trim()} us`);

board.stop();
