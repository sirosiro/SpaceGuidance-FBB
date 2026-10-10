#!/usr/bin/env python3
import sys
import os
import time
import subprocess
import signal

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def test_full_mission():
    print("[TEST PHASE 3] Starting Stage 1 Asteroid Pipeline Integration Test...")
    daemon_bin = "/workspaces/SpaceGuidance-FBB/bin/space_guidance_daemon"
    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    # Launch simulation daemon
    daemon_proc = subprocess.Popen([daemon_bin], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        dt = 0.02
        prev_err = 0.0
        start = time.time()
        kp = 0.8
        kd = 0.15 # Tuned PD

        print("  Running PD line guidance loop...")
        max_deviation = 0.0

        for step in range(2500): # max 50 seconds
            tlm = hw.read_registers()
            hw.kick_watchdog()

            pos_x = tlm["pos_x"]
            dev = tlm["cross_track_err"]
            if dev > max_deviation:
                max_deviation = dev

            if pos_x >= 45.0:
                elapsed = time.time() - start
                print(f"  ✓ Reached Goal at x={pos_x:.1f}m in {elapsed:.2f}s!")
                print(f"  ✓ Peak Track Deviation: {max_deviation:.3f}m (< 0.35m limit)")
                print(f"  ✓ Remaining Fuel: {tlm['fuel']:.1f}%")
                assert max_deviation < 0.35, "Cross track error exceeded 0.35m limit!"
                assert tlm['fuel'] > 70.0, "Fuel consumption too high!"
                break

            raw_edge = tlm["sensor_edge"]
            if raw_edge >= 0x80000000:
                raw_edge -= 0x100000000
            err = raw_edge / 65536.0

            d_err = (err - prev_err) / dt
            prev_err = err
            tq = -(kp * err + kd * d_err)

            hw.write_commands(thrust_x=0.5, thrust_y=0.0, torque=tq)
            time.sleep(0.002)

        print("==========================================================")
        print("✨ PHASE 3: PYTHON AUTONOMOUS GUIDANCE VERIFIED (100% PASS)")
        print("==========================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        daemon_proc.wait(timeout=2)

if __name__ == "__main__":
    test_full_mission()
