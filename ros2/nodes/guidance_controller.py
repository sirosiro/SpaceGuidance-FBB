#!/usr/bin/env python3
import mmap
import struct
import time
import os
import sys
import json

class UartTee:
    """
    Sim-to-Real Telemetry Mirror (Terminal + Zynq PS UART)

    標準出力 (sys.stdout) をターミナル画面に表示すると同時に、
    物理実機互換のシリアルポート（AMD Xilinx Zynq PS UART1: /dev/ttyPS1 等）
    へ透過的に複製出力（Tee）するストリームハンドラ。
    コンテキストマネージャ (with 構文) および直接インスタンス化の両方に対応。
    """
    def __init__(self, uart_dev="/dev/ttyPS1", auto_redirect=True):
        self.uart_dev = uart_dev
        self.auto_redirect = auto_redirect
        self.stdout = sys.__stdout__
        self.uart_fd = None
        try:
            self.uart_fd = os.open(uart_dev, os.O_RDWR | os.O_NOCTTY)
        except Exception:
            self.uart_fd = None

        if self.auto_redirect:
            sys.stdout = self

    def write(self, data):
        self.stdout.write(data)
        if self.uart_fd is not None:
            try:
                # \r\n を単一の \n に正規化（PTY 側での二重改行 \n\n を防止）
                formatted = data.replace("\r\n", "\n").replace("\r", "")
                os.write(self.uart_fd, formatted.encode("utf-8"))
            except Exception:
                pass

    def flush(self):
        self.stdout.flush()

    def close(self):
        if self.auto_redirect and sys.stdout is self:
            sys.stdout = self.stdout
        if self.uart_fd is not None:
            try:
                os.close(self.uart_fd)
            except Exception:
                pass
            self.uart_fd = None

    def __enter__(self):
        if not self.auto_redirect:
            sys.stdout = self
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

class SpaceGuidanceHardware:
    """
    Sim-to-Real Hardware Interface
    Transparently connects to either:
    - F-BB shared memory emulation (/tmp/fbb_space_guidance_shm)
    - Physical AMD Xilinx Zynq UIO device (/dev/uio0)
    """
    SHM_LAYOUT = "=12I9d2Ii3I" # 12 uint32 + 9 doubles + 2 uint32 + 1 int32 + 3 uint32 = 144 bytes
    SIZE = max(struct.calcsize(SHM_LAYOUT), 496)

    def __init__(self, dev_path=None, telemetry_uart=None):
        if dev_path is None:
            dev_path = os.getenv("FBB_SHM_PATH", "")
            if not dev_path:
                for candidate in ["/dev/shm/fbb_space_guidance_shm", "/tmp/fbb_space_guidance_shm", "/tmp/vfpga_reg"]:
                    if os.path.exists(candidate):
                        dev_path = candidate
                        break
            if not dev_path:
                dev_path = "/tmp/vfpga_reg"
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
        self.uart_tee = UartTee(telemetry_uart) if telemetry_uart else None

    def engage(self):
        """
        Explicit Engagement Trigger (CR_CTRL |= 0x09).
        Signals official referee to start mission timer if not already triggered by commands.
        """
        self.mm.seek(0)
        cr = struct.unpack("=I", self.mm.read(4))[0]
        cr |= 0x09 # Ensure Bit 0 (Run/Enable) and Bit 3 (Engage)
        self.mm.seek(0)
        self.mm.write(struct.pack("=I", cr))

    def read_registers(self):
        # Seqlock lock-free retry loop (up to 10 attempts) to prevent torn reads
        res = {}
        shm_ext_loaded = False
        for retry in range(10):
            self.mm.seek(0)
            data = self.mm.read(self.SIZE)
            seq_start = 0
            if len(data) >= 496:
                magic_check, seq_start = struct.unpack_from("=2I", data, 0xA8)
                if magic_check == 0x53504731 and (seq_start & 1):
                    # Odd sequence number indicates daemon write in progress; retry
                    time.sleep(0.0005)
                    continue

            unpacked = struct.unpack(self.SHM_LAYOUT, data[:struct.calcsize(self.SHM_LAYOUT)])
            res = {
                "cr_ctrl": unpacked[0],
                "sr_status": unpacked[1],
                "sensor_raw": unpacked[2],
                "sensor_edge": unpacked[3],
                "thrust_cmd_x": unpacked[4],
                "thrust_cmd_y": unpacked[5],
                "thrust_cmd_z": unpacked[6],
                "torque_cmd": unpacked[7],
                "chaos_fault_inj": unpacked[10],
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
                "score": unpacked[23],
                "official_score": unpacked[23],
                "passed_checkpoints": unpacked[24],
                "passed_gates": unpacked[24],
                "mission_status": unpacked[25],
                "total_checkpoints": unpacked[26],
                "total_gates": unpacked[26]
            }

            # Zero Disk I/O: Unpack extended 6-DoF telemetry directly from SHM if magic 'SPG1' matches
            if len(data) >= 496:
                magic, seq_end = struct.unpack_from("=2I", data, 0xA8)
                if magic == 0x53504731: # 'SPG1'
                    if seq_start != seq_end:
                        # Sequence changed during unpack (torn read); retry
                        time.sleep(0.0005)
                        continue
                    doubles = struct.unpack_from("=23d", data, 0xB0)
                    res["pos_z"] = doubles[0]
                    res["vel_z"] = doubles[1]
                    res["roll"] = doubles[2]
                    res["pitch"] = doubles[3]
                    res["yaw"] = doubles[4]
                    res["omega_x"] = doubles[5]
                    res["omega_y"] = doubles[6]
                    res["omega_z"] = doubles[7]
                    res["wheel_rpm_x"] = doubles[8]
                    res["wheel_rpm_y"] = doubles[9]
                    res["wheel_rpm_z"] = doubles[10]
                    res["cable_tension"] = doubles[11]
                    res["cable_vibration"] = doubles[12]
                    res["detumble_time"] = doubles[13]
                    res["elapsed_time"] = doubles[14]
                    res["debris_azimuth"] = doubles[15]
                    res["debris_elevation"] = doubles[16]
                    res["debris_spawn_x"] = doubles[17]
                    res["debris_spawn_y"] = doubles[18]
                    res["debris_spawn_z"] = doubles[19]
                    res["debris_impact_x"] = doubles[20]
                    res["debris_impact_y"] = doubles[21]
                    res["debris_impact_z"] = doubles[22]
                    if res.get("stage_id") == 4:
                        res["target_angle"] = doubles[15]
                        res["target_omega"] = doubles[16]
                        res["rel_angle"] = doubles[17]
                        res["rel_omega"] = doubles[18]

                    ints = struct.unpack_from("=2i8I", data, 0x168)
                    res["checkpoint_score"] = ints[0]
                    res["bonus_score"] = ints[1]
                    res["cable_snapped"] = ints[2]
                    res["thruster_health"] = ints[3]
                    res["is_detumbled"] = ints[4]
                    res["debris_hits"] = ints[5]
                    res["chaos_seed"] = ints[6]
                    res["damaged_thruster_1"] = ints[7]
                    res["damaged_thruster_2"] = ints[8]
                    res["mission_status_code"] = ints[9]
                    if ints[9] != 0:
                        res["mission_status"] = ints[9]

                    grade_raw = data[0x190:0x1B0].split(b'\x00')[0]
                    event_raw = data[0x1B0:0x1F0].split(b'\x00')[0]
                    res["official_grade"] = grade_raw.decode('utf-8', errors='ignore')
                    res["last_event"] = event_raw.decode('utf-8', errors='ignore')
                    shm_ext_loaded = True
            break

        if not shm_ext_loaded and os.path.exists("/tmp/space_guidance_telemetry.json"):
            for _ in range(3):
                try:
                    with open("/tmp/space_guidance_telemetry.json", "r") as jf:
                        jdata = json.load(jf)
                    for k in ["pos_z", "vel_z", "roll", "pitch", "yaw", "omega_x", "omega_y", "omega_z",
                              "wheel_rpm_x", "wheel_rpm_y", "wheel_rpm_z", "thruster_health",
                              "chaos_seed", "debris_azimuth", "debris_elevation",
                              "damaged_thruster_1", "damaged_thruster_2"]:
                        if k in jdata:
                            res[k] = jdata[k]
                    break
                except Exception:
                    time.sleep(0.001)
        return res

    def write_commands(self, thrust_x, thrust_y, torque=0.0, wheel_torque=0.0, fdir_mode=0, thrust_z=0.0,
                       torque_x=0.0, torque_y=0.0, wheel_torque_x=0.0, wheel_torque_y=0.0, thrust_vertical=0.0):
        # Convert floats to Q16.16 integers
        tx_int = int(thrust_x * 65536.0) & 0xFFFFFFFF
        ty_int = int(thrust_y * 65536.0) & 0xFFFFFFFF
        tz_int = int(thrust_z) if isinstance(thrust_z, int) else (int(thrust_z * 65536.0) & 0xFFFFFFFF)
        tq_int = int(torque * 65536.0) & 0xFFFFFFFF
        tw_int = int(wheel_torque * 65536.0) & 0xFFFFFFFF

        # Offset for thrust_cmd_x is 0x10 (16 bytes = 4 uint32s)
        self.mm.seek(16)
        self.mm.write(struct.pack("=3I", tx_int, ty_int, tz_int)) # x, y, z
        self.mm.seek(28)
        self.mm.write(struct.pack("=I", tq_int))              # RCS torque

        # Offset for wheel_torque_cmd is 0x2C (44 bytes)
        self.mm.seek(44)
        self.mm.write(struct.pack("=I", tw_int))              # Reaction Wheel torque

        # Write FDIR mode telemetry (offset: 12*4 + 9*8 = 120 bytes)
        self.mm.seek(120)
        self.mm.write(struct.pack("=I", fdir_mode))

        # Extended 6-DoF multi-axis commands (offset 0x90 = 144 bytes)
        ext_bytes = struct.pack("=5i",
                                int(torque_x * 65536.0),
                                int(torque_y * 65536.0),
                                int(wheel_torque_x * 65536.0),
                                int(wheel_torque_y * 65536.0),
                                int(thrust_vertical * 65536.0))
        self.mm.seek(144)
        self.mm.write(ext_bytes)

    def write_thruster_pulse(self, nozzle_mask):
        """Direct actuation for Stage 5 / Panic Control SysID & Control Allocation (12 nozzles)"""
        self.mm.seek(24) # 0x18 THRUST_CMD_Z
        self.mm.write(struct.pack("=I", int(nozzle_mask) & 0x0FFF))

    def write_reaction_wheel(self, wheel_torque, wheel_torque_x=0.0, wheel_torque_y=0.0):
        """Dedicated 3-Axis Reaction Wheel torque control (consumes 0 propellant)"""
        tw_int = int(wheel_torque * 65536.0) & 0xFFFFFFFF
        self.mm.seek(44)
        self.mm.write(struct.pack("=I", tw_int))
        self.mm.seek(144 + 8) # offset 0x98: wheel_torque_x_cmd, wheel_torque_y_cmd
        self.mm.write(struct.pack("=2i", int(wheel_torque_x * 65536.0), int(wheel_torque_y * 65536.0)))

    def set_inspection_scan(self, angle_deg, beam_width_deg=15.0, drive_thrust=0.0, fdir_mode=1):
        """
        Stage 3 360-degree Optical Laser / LiDAR Flaw Inspection Scanner API.
        Controls the turret scan angle and aperture beam width.
        - angle_deg: Turret scan angle around the truss joint (0 to 360 deg)
        - beam_width_deg: Aperture width in degrees (narrow = high SNR sensitivity, wide = fast coarse sweep)
        - drive_thrust: Forward/reverse drive thrust
        - fdir_mode: 1 = Clamped / Latched on rail collar, 0 = Travelling
        """
        self.write_commands(thrust_x=drive_thrust, thrust_y=float(angle_deg), torque=float(beam_width_deg), fdir_mode=fdir_mode)

    def kick_watchdog(self):
        self.mm.seek(36) # 0x24 WATCHDOG_KICK
        self.mm.write(struct.pack("=I", 1))

    def print_summary(self, stage_title=None):
        """
        Official Flight Evaluation Summary (SSOT from OfficialReferee in SHM).
        Learner-centric purity: pilot.py does not need redundant ASCII formatting or timing logic.
        """
        regs = self.read_registers()
        title = stage_title if stage_title else f"STAGE {regs.get('stage_id', 1)} MISSION SUMMARY"
        elapsed = regs.get("elapsed_time", 0.0)
        score = regs.get("official_score", regs.get("score", 0))
        grade = regs.get("official_grade", "IN_FLIGHT")
        fuel = regs.get("fuel", 0.0)
        passed = regs.get("passed_checkpoints", regs.get("passed_gates", 0))
        total = regs.get("total_checkpoints", regs.get("total_gates", 0))
        chk_pts = regs.get("checkpoint_score", 0)
        bonus_pts = regs.get("bonus_score", 0)
        last_evt = regs.get("last_event", "")

        print("\n" + "=" * 70)
        print(f"      OFFICIAL REFEREE EVALUATION (DAEMON SSOT) - {title}")
        print("=" * 70)
        print(f"  Official Flight Time : {elapsed:6.2f} s")
        print(f"  Checkpoints Cleared  : {passed} / {total}")
        print(f"  Checkpoint Score     : {chk_pts:,} pts")
        print(f"  Bonus Score          : {bonus_pts:,} pts")
        print(f"  Official Final Score : {score:,} pts")
        print(f"  Remaining Propellant : {fuel:5.1f} %")
        print(f"  Official Grade       : {grade}")
        if last_evt:
            print(f"  Referee Event        : {last_evt}")
        print("=" * 70 + "\n")

    def close(self):
        if hasattr(self, 'uart_tee') and self.uart_tee:
            self.uart_tee.close()
            self.uart_tee = None
        self.mm.close()
        self.f.close()
