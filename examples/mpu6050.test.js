// Test a sensor driver against a fake I2C device.
//
// The driver (examples/firmware/mpu6050_driver.py) is copied onto the board's filesystem, imported,
// and run against FakeMPU6050, a register-level model written in JavaScript. The test then checks
// both what the driver returns and what it wrote to the sensor.
//
//   node --test examples/mpu6050.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { FakeMPU6050 } from './devices/mpu6050.js';
import { bootOfficial } from './helpers.js';

let board;
let sensor;

before(async () => {
  board = await bootOfficial();
  sensor = board.i2c(0).attach(new FakeMPU6050());
  await board.writeFile('/mpu6050_driver.py', fs.readFileSync(new URL('./firmware/mpu6050_driver.py', import.meta.url)));
  await board.exec(
    'from machine import I2C, Pin\nfrom mpu6050_driver import MPU6050\n' +
      'i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=400000)\nimu = MPU6050(i2c)',
  );
});
after(() => board.stop());

test('the driver wakes the sensor up and selects its ranges', () => {
  assert.equal(sensor.asleep, false);
  assert.equal(sensor.get(0x1b), 0x08, 'gyro range register');
  assert.deepEqual(sensor.writesTo(0x6b), [0x00], 'power management written once');
});

test('it reports gravity on Z when the board lies flat', async () => {
  sensor.setMotion({ accelG: [0, 0, 1], gyroDps: [0, 0, 0], temperatureC: 25 });
  const { accel, temp, gyro } = await board.evalJson('dict(zip(("accel", "temp", "gyro"), imu.read()))');
  assert.ok(Math.abs(accel[2] - 1) < 0.001);
  assert.ok(Math.abs(temp - 25) < 0.5);
  assert.deepEqual(gyro, [0, 0, 0]);
});

test('it converts a rotation using the range it selected', async () => {
  sensor.setMotion({ accelG: [0.5, -0.5, 0.7], gyroDps: [10, -20, 125] });
  const [accel, , gyro] = await board.evalJson('imu.read()');
  assert.ok(Math.abs(accel[0] - 0.5) < 0.001 && Math.abs(accel[1] + 0.5) < 0.001);
  assert.ok(Math.abs(gyro[2] - 125) < 0.1, `gyro Z ${gyro[2]}`);
  assert.ok(Math.abs(gyro[1] + 20) < 0.1);
});

test('the driver refuses a device that is not an MPU-6050', async () => {
  sensor.registers[0x75] = 0x70; // WHO_AM_I is read-only for the firmware, so change the backing store directly
  const result = await board.run('MPU6050(i2c)');
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MPU-6050 not found/);
});
