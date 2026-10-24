#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 3 Automated Regression Test
# ISS Truss Inspector 全自動検証スクリプト (SSOT 判定アサート)

import sys
import os
import time
import subprocess
import signal
import json

def test_stage3_mission():
    print("==========================================================")
    print("  [TEST] SpaceGuidance Stage 3: ISS Truss Inspector")
    print("==========================================================")

    test_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(test_dir, ".."))
    daemon_bin = os.path.join(project_root, "bin", "space_guidance_daemon")
    pilot_script = os.path.join(project_root, "scenario", "03_iss_truss", "pilot.py")
    telemetry_file = "/tmp/space_guidance_telemetry.json"

    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    # Clean previous shared memory & telemetry
    subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)
    if os.path.exists(telemetry_file):
        os.remove(telemetry_file)

    # 1. Launch C++ Daemon in Stage 3
    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "3"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        # 2. Run Stage 3 Autopilot
        print("[Test Runner] Executing Stage 3 pilot.py...")
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
            raise AssertionError("Stage 3 pilot timed out (> 75s)!")

        assert pilot_proc.returncode == 0, f"pilot.py exited with error code {pilot_proc.returncode}"

        # 3. Read official telemetry directly from SSOT daemon via POSIX SHM (ADR #001: Zero Disk I/O)
        sys.path.append(os.path.join(project_root, "ros2", "nodes"))
        from guidance_controller import SpaceGuidanceHardware
        hw = SpaceGuidanceHardware()
        tlm = hw.read_registers()

        det_cnt = (tlm.get("sensor_edge", 0) >> 24) & 0x0F
        print("\n--- Official Referee Verification (SHM SSOT) ---")
        print(f"  Stage ID            : {tlm.get('stage_id')}")
        print(f"  Passed Checkpoints  : {tlm.get('passed_checkpoints')} / {tlm.get('total_checkpoints')}")
        print(f"  Defects Detected    : {det_cnt} / 3")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (1=COMPLETE)")
        print(f"  Elapsed Time        : {tlm.get('elapsed_time', 0.0):.2f}s")
        print(f"  Remaining Battery   : {tlm.get('fuel'):.1f}%\n")

        # 4. Strict assertions for 100% PASS
        assert tlm.get("stage_id") == 3, "Stage ID mismatch!"
        assert tlm.get("passed_checkpoints") == 4, f"Failed checkpoints: {tlm.get('passed_checkpoints')} / 4"
        assert det_cnt == 3, f"Expected 3 defects detected, but got {det_cnt} / 3"
        assert tlm.get("mission_status") == 1, f"Mission status is {tlm.get('mission_status')}, expected 1 (COMPLETE)"
        assert tlm.get("score") >= 8000, f"Score {tlm.get('score')} < 8000 (GRADE S threshold)"
        assert "GRADE S" in tlm.get("official_grade", ""), f"Grade is {tlm.get('official_grade')}, expected GRADE S"

        print("==========================================================")
        print("✨ STAGE 3 INTEGRATION TEST: 100% PASS (GRADE S CONFIRMED)")
        print("==========================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    test_stage3_mission()
