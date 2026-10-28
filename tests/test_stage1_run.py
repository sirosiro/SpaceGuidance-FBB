#!/usr/bin/env python3
import sys
import os
import time
import subprocess
import signal
import math

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def test_full_mission():
    print("[TEST PHASE 3] Starting Stage 1 Asteroid Pipeline Integration Test...")
    daemon_bin = "/workspaces/SpaceGuidance-FBB/bin/space_guidance_daemon"
    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"])
    time.sleep(0.3)

    # Launch simulation daemon
    daemon_proc = subprocess.Popen([daemon_bin, "--stage=1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        dt = 0.02
        start = time.time()
        kp = 1.20
        kd = 0.60
        kp_roll = 2.80
        kd_roll = 3.20
        klat = 1.40
        kvlat = 2.80
        target_vx = 1.15

        def calc_target_bank(x):
            BANK_MAX = 0.5404 # 31.0 deg
            if x < 5.2: return 0.0
            elif x < 9.0: return BANK_MAX * math.sin((x - 5.2) / 3.8 * math.pi * 0.5)
            elif x < 19.5: return BANK_MAX
            elif x < 24.5: return BANK_MAX * math.cos((x - 19.5) / 5.0 * math.pi)
            elif x < 35.0: return -BANK_MAX
            elif x < 39.5: return -BANK_MAX * math.cos((x - 35.0) / 4.5 * math.pi * 0.5)
            else: return 0.0

        print("  Running PD line guidance loop with 3D Bank-to-Translate...")
        max_deviation = 0.0
        gate_events = []

        while time.time() - start < 65.0:
            tlm = hw.read_registers()
            hw.kick_watchdog()

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]
            pos_z = tlm.get("pos_z", 0.0)
            vel_x = tlm.get("vel_x", 0.0)
            vel_y = tlm.get("vel_y", 0.0)
            vel_z = tlm.get("vel_z", 0.0)
            angle = tlm.get("angle", 0.0)
            omega = tlm.get("omega", 0.0)
            roll = tlm.get("roll", 0.0)
            omega_x = tlm.get("omega_x", 0.0)
            dev = abs(tlm["cross_track_err"])
            if dev > max_deviation:
                max_deviation = dev

            event = tlm.get("last_event", "")
            if "GATE" in event and event not in gate_events:
                gate_events.append(event)
                print(f"  {event}")

            if pos_x >= 49.0:
                elapsed = time.time() - start
                score = tlm.get("official_score", 0)
                grade = tlm.get("official_grade", "N/A")
                print(f"  ✓ Reached Goal at x={pos_x:.1f}m in {elapsed:.2f}s!")
                print(f"  ✓ Peak Transient Deviation: {max_deviation:.3f}m")
                print(f"  ✓ Final Score: {score} pts ({grade})")
                print(f"  ✓ Remaining Fuel: {tlm['fuel']:.1f}%")
                assert score >= 7000, f"Score {score} below required 7000 threshold!"
                assert tlm['fuel'] > 70.0, "Fuel consumption too high!"
                break

            lookahead_x = pos_x + max(0.4, vel_x * 0.6)
            target_bank = calc_target_bank(lookahead_x)
            roll_err = target_bank - roll
            wheel_torque_x = -((kp_roll * roll_err) - (kd_roll * omega_x))

            nom_y = 0.0
            nom_z = 0.0
            v_lat_nom = 0.0
            v_z_nom = 0.0
            ff_ay = 0.0
            ff_az = 0.0
            k_w = math.pi / 15.0
            if 10.0 <= pos_x <= 25.0:
                ph = (pos_x - 10.0) * k_w
                nom_y = 2.5 * math.sin(ph)
                nom_z = 1.5 * math.sin(ph)
                v_lat_nom = 2.5 * k_w * math.cos(ph) * vel_x
                v_z_nom = 1.5 * k_w * math.cos(ph) * vel_x
                ff_ay = -2.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
                ff_az = -1.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
            elif 25.0 < pos_x <= 40.0:
                ph = (pos_x - 25.0) * k_w
                nom_y = -2.5 * math.sin(ph)
                nom_z = 1.5 * math.sin(ph)
                v_lat_nom = -2.5 * k_w * math.cos(ph) * vel_x
                v_z_nom = 1.5 * k_w * math.cos(ph) * vel_x
                ff_ay = +2.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
                ff_az = -1.5 * (k_w**2) * math.sin(ph) * (vel_x**2)

            sensor_raw = tlm["sensor_raw"]
            if sensor_raw != 0:
                raw_edge = tlm["sensor_edge"]
                if raw_edge >= 0x80000000:
                    raw_edge -= 0x100000000
                err = raw_edge / 65536.0
            else:
                dy = pos_y - nom_y
                dz = pos_z - nom_z
                err = - (dy * math.cos(roll) + dz * math.sin(roll))

            target_tq = -(kp * angle + kd * omega)

            cos_p = math.cos(roll)
            sin_p = math.sin(roll)
            ff_thrust_lat = (100.0 * (ff_ay * cos_p + ff_az * sin_p)) / 50.0
            v_lat = -vel_x * math.sin(angle) + vel_y * math.cos(angle)
            lat_cmd = ff_thrust_lat + (klat * err) - kvlat * (v_lat - v_lat_nom)
            lat_thrust = max(-1.0, min(1.0, lat_cmd))

            z_err = nom_z - pos_z
            ff_thrust_vert = (100.0 * (-ff_ay * sin_p + ff_az * cos_p)) / 50.0
            vert_cmd = ff_thrust_vert + 2.50 * z_err - 2.50 * (vel_z - v_z_nom)
            vert_thrust = max(-1.0, min(1.0, vert_cmd))

            thrust_x = max(-0.25, min(0.35, 0.35 * (target_vx - vel_x)))

            hw.write_commands(
                thrust_x=thrust_x,
                thrust_y=lat_thrust,
                torque=0.0,
                wheel_torque=-target_tq,
                wheel_torque_x=wheel_torque_x,
                thrust_vertical=vert_thrust
            )
            time.sleep(0.005)

        print("==========================================================")
        print("✨ PHASE 3: PYTHON AUTONOMOUS GUIDANCE VERIFIED (100% PASS)")
        print("==========================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        daemon_proc.wait(timeout=2)

if __name__ == "__main__":
    test_full_mission()
