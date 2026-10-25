#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 2 Automated Regression Test
# Orbital Tether Climber 全自動検証スクリプト (SSOT 判定アサート)

import sys
import os
import time
import subprocess
import signal

def test_stage2_mission():
    print("==========================================================")
    print("  [TEST] SpaceGuidance Stage 2: Orbital Tether Climber")
    print("==========================================================")

    test_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(test_dir, ".."))
    daemon_bin = os.path.join(project_root, "bin", "space_guidance_daemon")
    pilot_script = os.path.join(project_root, "scenario", "02_tether_climber", "pilot.py")

    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    # Clean previous shared memory & telemetry
    subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)
    for shm_path in ["/dev/shm/fbb_space_guidance_shm", "/tmp/fbb_space_guidance_shm",
                     "/tmp/space_guidance_telemetry.json", "/tmp/fbb_scenario_telemetry.json"]:
        if os.path.exists(shm_path):
            try:
                os.remove(shm_path)
            except Exception:
                pass

    # 1. Launch C++ Daemon in Stage 2
    daemon_proc = subprocess.Popen(
        [daemon_bin, "--stage", "2"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(0.5)

    try:
        # 2. Run Stage 2 Autopilot
        print("[Test Runner] Executing Stage 2 pilot.py...")
        pilot_proc = subprocess.Popen(
            [sys.executable, pilot_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        try:
            p_out, p_err = pilot_proc.communicate(timeout=65)
            print(p_out)
        except subprocess.TimeoutExpired:
            pilot_proc.kill()
            raise AssertionError("Stage 2 pilot timed out (> 65s)!")

        assert pilot_proc.returncode == 0, f"pilot.py exited with error code {pilot_proc.returncode}"

        # 3. Read official telemetry directly from SSOT daemon via POSIX SHM
        sys.path.append(os.path.join(project_root, "ros2", "nodes"))
        from guidance_controller import SpaceGuidanceHardware
        hw = SpaceGuidanceHardware()
        tlm = hw.read_registers()

        print("\n--- Official Referee Verification (SHM SSOT) ---")
        print(f"  Stage ID            : {tlm.get('stage_id')}")
        print(f"  Final Altitude      : {tlm.get('pos_x', 0.0):.2f} m")
        print(f"  Passed Beacons      : {tlm.get('passed_checkpoints')} / {tlm.get('total_checkpoints')}")
        print(f"  Final Score         : {tlm.get('score')} pts")
        print(f"  Official Grade      : {tlm.get('official_grade')}")
        print(f"  Mission Status Code : {tlm.get('mission_status')} (1=COMPLETE)")
        print(f"  Elapsed Time        : {tlm.get('elapsed_time', 0.0):.2f}s")
        print(f"  Remaining Battery   : {tlm.get('fuel', 0.0):.1f}%\n")

        # 4. Strict assertions for 100% PASS
        assert tlm.get("stage_id") == 2, "Stage ID mismatch!"
        assert tlm.get("pos_x", 0.0) >= 99.8, f"Climber did not reach 100m dock (alt={tlm.get('pos_x'):.2f}m)"
        assert tlm.get("passed_checkpoints") == 9, f"Failed beacons: {tlm.get('passed_checkpoints')} / 9"
        assert tlm.get("cable_snapped", 0) == 0, "Tether cable snapped during climb!"
        assert tlm.get("mission_status") == 1, f"Mission status is {tlm.get('mission_status')}, expected 1 (COMPLETE)"
        assert tlm.get("score") >= 6500, f"Score {tlm.get('score')} < 6500 (GRADE A threshold)"
        assert ("GRADE S" in tlm.get("official_grade", "")) or ("GRADE A" in tlm.get("official_grade", "")), \
            f"Grade is {tlm.get('official_grade')}, expected GRADE S or A"

        print("==========================================================")
        print("✨ STAGE 2 INTEGRATION TEST: 100% PASS (GEO DOCK REACHED)")
        print("==========================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        try:
            daemon_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            daemon_proc.kill()
        subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    test_stage2_mission()
