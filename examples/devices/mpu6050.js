// Example of a fake I2C sensor built on RegisterSlave: an InvenSense MPU-6050 motion sensor.
//
// It reproduces what a driver typically relies on: WHO_AM_I, the power-management sleep bit, the
// full-scale selection registers, and the 14-byte burst read of accelerometer, temperature and gyro
// starting at register 0x3B. Measurements are set from the test with `setMotion()`.

import { RegisterSlave } from 'pico-emu-test';

const REG = {
  CONFIG: 0x1a,
  GYRO_CONFIG: 0x1b,
  ACCEL_CONFIG: 0x1c,
  ACCEL_XOUT_H: 0x3b,
  TEMP_OUT_H: 0x41,
  GYRO_XOUT_H: 0x43,
  PWR_MGMT_1: 0x6b,
  WHO_AM_I: 0x75,
};

const GYRO_LSB_PER_DPS = [131, 65.5, 32.8, 16.4]; // for the four full-scale settings
const ACCEL_LSB_PER_G = [16384, 8192, 4096, 2048];

export class FakeMPU6050 extends RegisterSlave {
  /** @param {number} [address=0x68] */
  constructor(address = 0x68) {
    super({
      address,
      registers: { [REG.WHO_AM_I]: 0x68, [REG.PWR_MGMT_1]: 0x40 }, // the part powers up asleep
      readOnly: [REG.WHO_AM_I],
      onRead: (register) => {
        // recompute the measurement registers (0x3B..0x48) from the current physical values
        if (register >= REG.ACCEL_XOUT_H && register <= REG.GYRO_XOUT_H + 5) this._refresh();
        return undefined;
      },
    });
    this.accelG = [0, 0, 1];
    this.gyroDps = [0, 0, 0];
    this.temperatureC = 25;
  }

  /**
   * Set the physical quantities the sensor reports.
   * @param {{accelG?: number[], gyroDps?: number[], temperatureC?: number}} motion
   */
  setMotion({ accelG, gyroDps, temperatureC }) {
    if (accelG) this.accelG = accelG;
    if (gyroDps) this.gyroDps = gyroDps;
    if (temperatureC !== undefined) this.temperatureC = temperatureC;
  }

  get asleep() {
    return Boolean(this.get(REG.PWR_MGMT_1) & 0x40);
  }

  // Convert the physical values to raw codes using the full-scale range the driver selected.
  _refresh() {
    const accelScale = ACCEL_LSB_PER_G[(this.get(REG.ACCEL_CONFIG) >> 3) & 3];
    const gyroScale = GYRO_LSB_PER_DPS[(this.get(REG.GYRO_CONFIG) >> 3) & 3];
    const awake = !this.asleep;
    this.accelG.forEach((g, i) => this.setInt16(REG.ACCEL_XOUT_H + 2 * i, awake ? g * accelScale : 0));
    this.setInt16(REG.TEMP_OUT_H, awake ? (this.temperatureC - 36.53) * 340 : 0);
    this.gyroDps.forEach((d, i) => this.setInt16(REG.GYRO_XOUT_H + 2 * i, awake ? d * gyroScale : 0));
  }
}
