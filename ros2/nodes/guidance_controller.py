#!/usr/bin/env python3
import mmap
import struct
import time
import os

class SpaceGuidanceHardware:
    """
    Sim-to-Real Hardware Interface
    Transparently connects to either:
    - F-BB shared memory emulation (/tmp/fbb_space_guidance_shm)
    - Physical AMD Xilinx Zynq UIO device (/dev/uio0)
    """
    SHM_LAYOUT = "=12I8d2I" # 12 uint32 + 8 doubles + 2 uint32 = 120 bytes
    SIZE = struct.calcsize(SHM_LAYOUT)

    def __init__(self, dev_path="/tmp/fbb_space_guidance_shm"):
        self.dev_path = dev_path
        if not os.path.exists(dev_path):
            # Create if not exists
            with open(dev_path, "wb") as f:
                f.write(b"\x00" * self.SIZE)
        self.f = open(dev_path, "r+b")
        self.mm = mmap.mmap(self.f.fileno(), self.SIZE)

    def read_registers(self):
        self.mm.seek(0)
        data = self.mm.read(self.SIZE)
        unpacked = struct.unpack(self.SHM_LAYOUT, data)
        return {
            "cr_ctrl": unpacked[0],
            "sr_status": unpacked[1],
            "sensor_raw": unpacked[2],
            "sensor_edge": unpacked[3],
            "thrust_cmd_x": unpacked[4],
            "thrust_cmd_y": unpacked[5],
            "torque_cmd": unpacked[7],
            "pos_x": unpacked[12],
            "pos_y": unpacked[13],
            "vel_x": unpacked[14],
            "vel_y": unpacked[15],
            "angle": unpacked[16],
            "omega": unpacked[17],
            "fuel": unpacked[18],
            "cross_track_err": unpacked[19],
            "fdir_mode": unpacked[20]
        }

    def write_commands(self, thrust_x, thrust_y, torque, fdir_mode=0):
        # Convert floats to Q16.16 integers
        tx_int = int(thrust_x * 65536.0) & 0xFFFFFFFF
        ty_int = int(thrust_y * 65536.0) & 0xFFFFFFFF
        tq_int = int(torque * 65536.0) & 0xFFFFFFFF

        # Offset for thrust_cmd_x is 0x10 (16 bytes = 4 uint32s)
        self.mm.seek(16)
        self.mm.write(struct.pack("=3I", tx_int, ty_int, 0)) # x, y, z
        self.mm.seek(28)
        self.mm.write(struct.pack("=I", tq_int))              # torque

        # Write FDIR mode telemetry (offset: 12*4 + 8*8 = 112 bytes)
        self.mm.seek(112)
        self.mm.write(struct.pack("=I", fdir_mode))

    def kick_watchdog(self):
        self.mm.seek(36) # 0x24 WATCHDOG_KICK
        self.mm.write(struct.pack("=I", 1))

    def close(self):
        self.mm.close()
        self.f.close()
