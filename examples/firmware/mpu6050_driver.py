# A small MPU-6050 driver, the kind of code you would test before putting it on a board.
import struct

ADDR = 0x68


class MPU6050:
    def __init__(self, i2c, addr=ADDR):
        self.i2c = i2c
        self.addr = addr
        if self.i2c.readfrom_mem(addr, 0x75, 1)[0] != 0x68:
            raise OSError("MPU-6050 not found")
        self.i2c.writeto_mem(addr, 0x6B, b"\x00")  # wake up
        self.i2c.writeto_mem(addr, 0x1B, b"\x08")  # gyro +-500 dps
        self.i2c.writeto_mem(addr, 0x1C, b"\x00")  # accel +-2 g

    def read(self):
        raw = struct.unpack(">hhhhhhh", self.i2c.readfrom_mem(self.addr, 0x3B, 14))
        accel = tuple(v / 16384 for v in raw[0:3])
        temp = raw[3] / 340 + 36.53
        gyro = tuple(v / 65.5 for v in raw[4:7])
        return accel, temp, gyro
