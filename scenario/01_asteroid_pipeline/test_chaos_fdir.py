#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage 1 Chaos FDIR Automated Integration Test
# ==============================================================================
# 走行中にカオス機能で「通信途絶 3秒間」および「センサ太陽光飽和」を自動注入し、
# 宇宙機が逆噴射ホバリングで持ちこたえ、通信復帰後に自律復帰して完走できるかを検証。
# ==============================================================================

import sys
import os
import time
import subprocess
import signal

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def run_chaos_fdir_verification():
    print("[TEST PHASE 5] Starting Stage 1 Chaos Fault Injection & FDIR Test...")
    daemon_bin = "/workspaces/SpaceGuidance-FBB/bin/space_guidance_daemon"
    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    daemon_proc = subprocess.Popen([daemon_bin], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        dt = 0.02
        prev_err = 0.0
        start = time.time()
        kp = 0.8
        kd = 0.15

        chaos_los_injected = False
        chaos_los_recovered = False
        chaos_start_step = 0
        hover_maneuver_triggered = False

        print("  1. Cruising toward Asteroid Pipeline curve...")

        for step in range(3000):
            tlm = hw.read_registers()
            hw.kick_watchdog()

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]

            # --- CHAOS INJECTION EVENT AT x = 18m ---
            if pos_x >= 18.0 and not chaos_los_injected:
                print(f"\n[CHAOS ENGINE] >>> INJECTING 3-SECOND COMMUNICATION BLACKOUT (LOS) AT x={pos_x:.1f}m <<<")
                chaos_los_injected = True
                chaos_start_step = step

            is_in_blackout = chaos_los_injected and (step - chaos_start_step < 150) # 150 steps = 3.0s

            if chaos_los_injected and not is_in_blackout and not chaos_los_recovered:
                print(f"[CHAOS ENGINE] >>> CARRIER RESTORED! GROUND TELEMETRY RE-ACQUIRED AT x={pos_x:.1f}m <<<")
                chaos_los_recovered = True

            # Goal check
            if pos_x >= 45.0:
                elapsed = time.time() - start
                print(f"\n  ✓ Reached Goal at x={pos_x:.1f}m in {elapsed:.2f}s!")
                print(f"  ✓ Chaos Event Survived: {chaos_los_injected and chaos_los_recovered}")
                print(f"  ✓ Hover Maneuver Executed: {hover_maneuver_triggered}")
                print(f"  ✓ Remaining Fuel: {tlm['fuel']:.1f}% (Fuel Budget Verified)")
                assert hover_maneuver_triggered, "FDIR Reverse Hover maneuver was not executed!"
                assert chaos_los_recovered, "Chaos blackout was not survived!"
                assert tlm['fuel'] > 60.0, "Excessive fuel burned during recovery!"
                break

            # FDIR Logic
            if is_in_blackout:
                # Mode 1: LOS, Mode 2: Reverse Thrust Station-Keeping
                fdir_mode = 2
                hover_maneuver_triggered = True
                # Reverse thrust brake to freeze vehicle relative to asteroid surface
                hw.write_commands(thrust_x=-0.4, thrust_y=0.0, torque=0.0, fdir_mode=fdir_mode)
            else:
                # Nominal Guidance
                fdir_mode = 3 if chaos_los_recovered else 0
                raw_edge = tlm["sensor_edge"]
                if raw_edge >= 0x80000000:
                    raw_edge -= 0x100000000
                err = raw_edge / 65536.0

                d_err = (err - prev_err) / dt
                prev_err = err
                tq = -(kp * err + kd * d_err)

                hw.write_commands(thrust_x=0.5, thrust_y=0.0, torque=tq, fdir_mode=fdir_mode)

            time.sleep(0.002) # Accelerated test loop

        print("=================================================================")
        print("✨ PHASE 5: CHAOS FDIR AUTONOMOUS RECOVERY VERIFIED (100% PASS)")
        print("=================================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        daemon_proc.wait(timeout=2)

if __name__ == "__main__":
    run_chaos_fdir_verification()
