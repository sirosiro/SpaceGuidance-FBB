#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 4 Automated Regression Test
# Optical Laser Docking 全自動検証スクリプト (SSOT 激突大破・GRADE S 判定アサート)

import sys
import os
import time
import subprocess
import signal
import math

test_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(test_dir, ".."))
daemon_bin = os.path.join(project_root, "bin", "space_guidance_daemon")
pilot_script = os.path.join(project_root, "scenario", "04_laser_docking", "pilot.py")
telemetry_file = "/tmp/space_guidance_telemetry.json"
sys.path.append(os.path.join(project_root, "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def cleanup_daemon():
    subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)
    if os.path.exists(telemetry_file):
        try:
            os.remove(telemetry_file)
        except OSError:
            pass
    time.sleep(0.3)

def test_stage4_nominal_mission():
    print("\n==========================================================")
    print("  [TEST 1] Stage 4: Nominal Autopilot Flight (Grade S)")
    print("==========================================================")

    cleanup_daemon()
    assert os.path.exists(daemon_bin), f"Daemon binary not found at {daemon_bin}"

    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "4"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        print("[Test Runner] Executing Stage 4 pilot.py...")
        pilot_proc = subprocess.Popen(
            [sys.executable, pilot_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        try:
            p_out, p_err = pilot_proc.communicate(timeout=75)
            print(p_out)
        except subprocess.TimeoutExpired:
            pilot_proc.kill()
            raise AssertionError("Stage 4 pilot timed out (> 75s)!")

        assert pilot_proc.returncode == 0, f"pilot.py exited with error code {pilot_proc.returncode}"

        # Read official telemetry from SSOT daemon via POSIX SHM
        hw = SpaceGuidanceHardware()
        tlm = hw.read_registers()
        hw.close()

        print("\n--- Official Referee Verification (SHM SSOT) ---")
        print(f"  Stage ID            : {tlm.get('stage_id')}")
        print(f"  Passed Checkpoints  : {tlm.get('passed_checkpoints')} / {tlm.get('total_checkpoints')}")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (1=COMPLETE, 2=FAILED)")
        print(f"  Remaining Fuel      : {tlm.get('fuel'):.1f}%\n")

        assert tlm.get("stage_id") == 4, "Stage ID mismatch!"
        assert tlm.get("passed_checkpoints") == 7, f"Failed checkpoints: {tlm.get('passed_checkpoints')} / 7"
        assert tlm.get("mission_status") == 1, f"Mission status is {tlm.get('mission_status')}, expected 1 (COMPLETE)"
        assert tlm.get("score") >= 8000, f"Score {tlm.get('score')} < 8000 (GRADE S threshold)"
        assert "GRADE S" in tlm.get("official_grade", ""), f"Grade is {tlm.get('official_grade')}, expected GRADE S"

        print(">> Nominal Mission Test: PASS (GRADE S)")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        cleanup_daemon()

def test_stage4_speed_crash_disqualification():
    print("\n==========================================================")
    print("  [TEST 2] Stage 4: High-Speed Impact Crash Disqualification")
    print("==========================================================")

    cleanup_daemon()
    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "4"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        # Full throttle forward to crash into port collar at high speed (> 0.08 m/s)
        # Also correct lateral offset so collision occurs within port collar
        print("[Test Runner] Approaching with high forward throttle...")
        start_t = time.time()
        while time.time() - start_t < 25.0:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            px = tlm.get("pos_x", 0.0)
            py = tlm.get("pos_y", 0.0)
            vx = tlm.get("vel_x", 0.0)
            status = tlm.get("mission_status", 0)

            if status != 0 or px >= 49.95:
                time.sleep(0.2)
                break

            # Align lateral offset to near-zero, but push forward fast (> 0.5 m/s)
            yaw = tlm.get("yaw", tlm.get("angle", 0.0))
            omega_z = tlm.get("omega_z", tlm.get("omega", 0.0))
            yaw_err = math.atan2(math.sin(yaw), math.cos(yaw))
            tau_yaw = - (yaw_err * 3.0 + omega_z * 2.0)
            tau_yaw = max(-1.0, min(1.0, tau_yaw))

            fx_world = 1.0
            fy_world = -py * 2.0 - tlm.get("vel_y", 0.0) * 1.0

            cos_a = math.cos(yaw)
            sin_a = math.sin(yaw)
            f_fwd = fx_world * cos_a + fy_world * sin_a
            f_lat = -fx_world * sin_a + fy_world * cos_a
            f_fwd = max(-1.0, min(1.0, f_fwd))
            f_lat = max(-0.8, min(0.8, f_lat))

            hw.write_commands(thrust_x=f_fwd, thrust_y=f_lat, torque=tau_yaw)
            time.sleep(0.01)

        tlm = hw.read_registers()
        hw.write_commands(0.0, 0.0, 0.0)
        hw.close()

        print("\n--- Official Referee Disqualification Verification ---")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (Expected 2: FAILED)")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Last Event          : {tlm.get('last_event')}")

        assert tlm.get("mission_status") == 2, f"Expected mission_status 2 (FAILED), got {tlm.get('mission_status')}"
        assert tlm.get("score") == 0, f"Expected score 0, got {tlm.get('score')}"
        assert "DISQUALIFIED (DOCKING CRASH)" in tlm.get("official_grade", ""), f"Grade mismatch: {tlm.get('official_grade')}"
        assert "Docking Collar Collision" in tlm.get("last_event", ""), f"Event string mismatch: {tlm.get('last_event')}"

        print(">> High-Speed Crash Disqualification Test: PASS")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        cleanup_daemon()

def test_stage4_offaxis_crash_disqualification():
    print("\n==========================================================")
    print("  [TEST 3] Stage 4: Off-Axis (>6.0cm) Crash Disqualification")
    print("==========================================================")

    cleanup_daemon()
    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "4"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        # Approach slowly (< 0.05 m/s) but maintain lateral offset > 0.06m (e.g. 0.15m)
        print("[Test Runner] Approaching with intentional lateral offset (>6.0cm)...")
        start_t = time.time()
        while time.time() - start_t < 35.0:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            px = tlm.get("pos_x", 0.0)
            py = tlm.get("pos_y", 0.0)
            vx = tlm.get("vel_x", 0.0)
            status = tlm.get("mission_status", 0)

            if status != 0 or px >= 49.95:
                time.sleep(0.2)
                break

            # Fast approach in early stage, then decelerate near collar
            dist = 50.0 - px
            if dist > 5.0:
                target_vx = 3.0
            elif dist > 1.0:
                target_vx = 1.0
            else:
                target_vx = 0.03 # very safe speed, but lateral offset is kept large!

            yaw = tlm.get("yaw", tlm.get("angle", 0.0))
            omega_z = tlm.get("omega_z", tlm.get("omega", 0.0))
            yaw_err = math.atan2(math.sin(yaw), math.cos(yaw))
            tau_yaw = - (yaw_err * 3.0 + omega_z * 2.0)
            tau_yaw = max(-1.0, min(1.0, tau_yaw))

            fx_world = max(-1.0, min(1.0, (target_vx - vx) * 1.5))
            target_y = 0.15
            fy_world = max(-0.8, min(0.8, (target_y - py) * 1.5 - tlm.get("vel_y", 0.0) * 1.0))

            cos_a = math.cos(yaw)
            sin_a = math.sin(yaw)
            f_fwd = fx_world * cos_a + fy_world * sin_a
            f_lat = -fx_world * sin_a + fy_world * cos_a
            f_fwd = max(-1.0, min(1.0, f_fwd))
            f_lat = max(-0.8, min(0.8, f_lat))

            hw.write_commands(thrust_x=f_fwd, thrust_y=f_lat, torque=tau_yaw)
            time.sleep(0.01)

        tlm = hw.read_registers()
        hw.write_commands(0.0, 0.0, 0.0)
        hw.close()

        print("\n--- Official Referee Disqualification Verification ---")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (Expected 2: FAILED)")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Last Event          : {tlm.get('last_event')}")

        assert tlm.get("mission_status") == 2, f"Expected mission_status 2 (FAILED), got {tlm.get('mission_status')}"
        assert tlm.get("score") == 0, f"Expected score 0, got {tlm.get('score')}"
        assert "DISQUALIFIED (DOCKING CRASH)" in tlm.get("official_grade", ""), f"Grade mismatch: {tlm.get('official_grade')}"

        print(">> Off-Axis Crash Disqualification Test: PASS")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        cleanup_daemon()

def test_stage4_spin_mismatch_crash_disqualification():
    print("\n==========================================================")
    print("  [TEST 4] Stage 4: Station Spin Mismatch Crash Disqualification")
    print("==========================================================")

    cleanup_daemon()
    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "4"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        # Approach safely in speed and centered in Y, but do NOT track rotation (torque = 0)
        # So relative angle / spin rate mismatch will cause collar crash
        print("[Test Runner] Approaching with safe speed & align, but ZERO rotation sync (torque=0)...")
        start_t = time.time()
        while time.time() - start_t < 60.0:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            px = tlm.get("pos_x", 0.0)
            py = tlm.get("pos_y", 0.0)
            vx = tlm.get("vel_x", 0.0)
            status = tlm.get("mission_status", 0)

            if status != 0 or px >= 49.95:
                time.sleep(0.2)
                break

            dist = 50.0 - px
            if dist > 1.0:
                target_vx = min(3.5, math.sqrt(dist * 1.5))
            else:
                target_vx = 0.05 # safe contact speed (< 0.08 m/s), so crash is purely due to attitude/spin!

            fx_world = (target_vx - vx) * 2.5
            fy_world = - py * 2.5 - tlm.get("vel_y", 0.0) * 1.5

            # Align heading to corridor, but do NOT sync roll (torque_x=0.0)
            yaw = tlm.get("yaw", tlm.get("angle", 0.0))
            omega_z = tlm.get("omega_z", tlm.get("omega", 0.0))
            yaw_err = math.atan2(math.sin(yaw), math.cos(yaw))
            tau_yaw = - (yaw_err * 3.0 + omega_z * 2.0)
            tau_yaw = max(-1.0, min(1.0, tau_yaw))

            cos_a = math.cos(yaw)
            sin_a = math.sin(yaw)
            f_fwd = fx_world * cos_a + fy_world * sin_a
            f_lat = -fx_world * sin_a + fy_world * cos_a

            hw.write_commands(thrust_x=f_fwd, thrust_y=f_lat, torque=tau_yaw, torque_x=0.0)
            time.sleep(0.01)

        tlm = hw.read_registers()
        hw.write_commands(0.0, 0.0, 0.0)
        hw.close()

        print("\n--- Official Referee Disqualification Verification ---")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (Expected 2: FAILED)")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Last Event          : {tlm.get('last_event')}")

        assert tlm.get("mission_status") == 2, f"Expected mission_status 2 (FAILED), got {tlm.get('mission_status')}"
        assert tlm.get("score") == 0, f"Expected score 0, got {tlm.get('score')}"
        assert "DISQUALIFIED (DOCKING CRASH)" in tlm.get("official_grade", ""), f"Grade mismatch: {tlm.get('official_grade')}"

        print(">> Spin Mismatch Crash Disqualification Test: PASS")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        cleanup_daemon()

if __name__ == "__main__":
    test_stage4_nominal_mission()
    test_stage4_speed_crash_disqualification()
    test_stage4_offaxis_crash_disqualification()
    test_stage4_spin_mismatch_crash_disqualification()
    print("\n==========================================================")
    print("✨ STAGE 4 INTEGRATION SUITE: 100% PASS (ALL 4 TESTS PASSED)")
    print("==========================================================")
