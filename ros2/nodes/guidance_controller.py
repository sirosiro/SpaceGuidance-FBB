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
    SHM_LAYOUT = "=12I9d2Ii3I" # 12 uint32 + 9 doubles + 2 uint32 + 1 int32 + 3 uint32 = 144 bytes
    SIZE = struct.calcsize(SHM_LAYOUT)

    def __init__(self, dev_path=None):
        if dev_path is None:
            dev_path = os.getenv("FBB_SHM_PATH", "/tmp/vfpga_reg")
            if not os.path.exists(dev_path) and os.path.exists("/tmp/fbb_space_guidance_shm"):
                dev_path = "/tmp/fbb_space_guidance_shm"
        self.dev_path = dev_path
        if not os.path.exists(dev_path):
            with open(dev_path, "wb") as f:
                f.write(b"\x00" * max(self.SIZE, 4096))
        self.f = open(dev_path, "r+b")
        file_size = os.path.getsize(dev_path)
        if file_size < self.SIZE:
            self.f.truncate(self.SIZE)
            file_size = self.SIZE
        self.mm = mmap.mmap(self.f.fileno(), file_size)

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
            "wheel_torque_cmd": unpacked[11],
            "pos_x": unpacked[12],
            "pos_y": unpacked[13],
            "vel_x": unpacked[14],
            "vel_y": unpacked[15],
            "angle": unpacked[16],
            "omega": unpacked[17],
            "fuel": unpacked[18],
            "cross_track_err": unpacked[19],
            "wheel_rpm": unpacked[20],
            "fdir_mode": unpacked[21],
            "stage_id": unpacked[22],
            "official_score": unpacked[23],
            "passed_gates": unpacked[24],
            "mission_status": unpacked[25],
            "total_gates": unpacked[26]
        }

    def write_commands(self, thrust_x, thrust_y, torque=0.0, wheel_torque=0.0, fdir_mode=0):
        # Convert floats to Q16.16 integers
        tx_int = int(thrust_x * 65536.0) & 0xFFFFFFFF
        ty_int = int(thrust_y * 65536.0) & 0xFFFFFFFF
        tq_int = int(torque * 65536.0) & 0xFFFFFFFF
        tw_int = int(wheel_torque * 65536.0) & 0xFFFFFFFF

        # Offset for thrust_cmd_x is 0x10 (16 bytes = 4 uint32s)
        self.mm.seek(16)
        self.mm.write(struct.pack("=3I", tx_int, ty_int, 0)) # x, y, z
        self.mm.seek(28)
        self.mm.write(struct.pack("=I", tq_int))              # RCS torque

        # Offset for wheel_torque_cmd is 0x2C (44 bytes)
        self.mm.seek(44)
        self.mm.write(struct.pack("=I", tw_int))              # Reaction Wheel torque

        # Write FDIR mode telemetry (offset: 12*4 + 9*8 = 120 bytes)
        self.mm.seek(120)
        self.mm.write(struct.pack("=I", fdir_mode))

    def write_reaction_wheel(self, wheel_torque):
        """Dedicated Reaction Wheel torque control (consumes 0 propellant)"""
        tw_int = int(wheel_torque * 65536.0) & 0xFFFFFFFF
        self.mm.seek(44)
        self.mm.write(struct.pack("=I", tw_int))

    def kick_watchdog(self):
        self.mm.seek(36) # 0x24 WATCHDOG_KICK
        self.mm.write(struct.pack("=I", 1))

    def close(self):
        self.mm.close()
        self.f.close()
