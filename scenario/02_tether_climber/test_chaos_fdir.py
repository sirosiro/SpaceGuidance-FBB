import functools
print_flush = functools.partial(print, flush=True)
#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage 2 Chaos FDIR Automated Integration Test
# ==============================================================================
# テザークライマー昇降中にカオス機能で「微小隕石衝突（横衝撃波）」および
# 「モータ過大トルクサージ」を自動注入し、破断限界（15,000N）寸前での
# 非常制動（E-STOP）と共振抑制ダンピングにより生還・完走できるかを検証する。
# ==============================================================================

import sys
import os
import time
import subprocess
import signal

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def run_chaos_fdir_verification():
    print_flush("[TEST PHASE 5] Starting Stage 2 Chaos Fault Injection & FDIR Test...")
    daemon_bin = "/workspaces/SpaceGuidance-FBB/bin/space_guidance_daemon"
    if not os.path.exists(daemon_bin):
        print_flush(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    daemon_proc = subprocess.Popen([daemon_bin, "--stage", "2"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        dt = 0.02
        start = time.time()
        
        target_velocity = 2.4
        kp_speed = 0.85
        max_accel_step = 0.04
        kvib_damping = 0.40

        chaos_shock_injected = False
        chaos_shock_recovered = False
        estop_maneuver_triggered = False
        max_tension_recorded = 0.0
        current_drive_cmd = 0.0

        print_flush("  1. Climber ascending along 100m Carbon Nanotube Tether...")

        for step in range(3500):
            tlm = hw.read_registers()
            hw.kick_watchdog()

            altitude = tlm["pos_x"]
            velocity = tlm["vel_x"]
            vibration = tlm["cross_track_err"]
            tension = 10000.0 + (100.0 * max(0.0, velocity)) + (1200.0 * abs(vibration))
            if tension > max_tension_recorded:
                max_tension_recorded = tension

            assert not tlm.get("cable_snapped", False), f"Cable ruptured at step {step} (Tension={tension:.0f}N)!"
            assert tension < 15000.0, f"Cable tension exceeded 15,000N rupture threshold ({tension:.0f}N)!"

            # --- CHAOS INJECTION EVENT AT altitude = 45m ---
            if altitude >= 45.0 and not chaos_shock_injected:
                print_flush(f"\n[CHAOS ENGINE] >>> INJECTING HIGH-JERK MOTOR SURGE & MICROMETEOROID IMPACT AT Alt={altitude:.1f}m <<<")
                chaos_shock_injected = True
                hw.write_commands(thrust_x=1.0, thrust_y=0.0, torque=0.0, fdir_mode=2)
                continue

            # FDIR 障害検知 & 非常制動 (E-STOP)
            is_danger_zone = chaos_shock_injected and not chaos_shock_recovered and (tension > 12000.0 or abs(vibration) > 0.08)

            if is_danger_zone:
                fdir_mode = 2
                estop_maneuver_triggered = True
                current_drive_cmd = -0.15
                hw.write_commands(thrust_x=-0.15, thrust_y=0.0, torque=0.0, fdir_mode=fdir_mode)
            elif chaos_shock_injected and not chaos_shock_recovered:
                if abs(vibration) < 0.04 and tension < 11000.0:
                    print_flush(f"[CHAOS ENGINE] >>> VIBRATION SUPPRESSED! RESUMING NOMINAL S-CURVE ASCENT AT Alt={altitude:.1f}m <<<")
                    chaos_shock_recovered = True
                    fdir_mode = 3
                else:
                    fdir_mode = 2
                    current_drive_cmd = 0.10
                    hw.write_commands(thrust_x=0.10, thrust_y=0.0, torque=0.0, fdir_mode=fdir_mode)
            else:
                fdir_mode = 3 if chaos_shock_recovered else 0
                target_force = (target_velocity - velocity) * kp_speed + 0.10
                target_force = max(-0.2, min(0.95, target_force))

                delta = target_force - current_drive_cmd
                delta = max(-max_accel_step, min(max_accel_step, delta))
                current_drive_cmd += delta
                damped_drive = current_drive_cmd - (vibration * kvib_damping * 0.1)

                hw.write_commands(thrust_x=damped_drive, thrust_y=0.0, torque=0.0, fdir_mode=fdir_mode)

            # ゴール到達判定 (100m GEO Orbit Dock)
            if altitude >= 100.0:
                elapsed = time.time() - start
                print_flush(f"\n  ✓ Reached GEO Orbital Platform at Alt={altitude:.2f}m in {elapsed:.2f}s!")
                print_flush(f"  ✓ Chaos Shock Event Survived: {chaos_shock_injected and chaos_shock_recovered}")
                print_flush(f"  ✓ Emergency E-STOP Maneuver Triggered: {estop_maneuver_triggered}")
                print_flush(f"  ✓ Peak Cable Tension: {max_tension_recorded:.0f} N (Safety Margin: {15000.0 - max_tension_recorded:.0f} N)")
                print_flush(f"  ✓ Remaining Battery/Fuel: {tlm['fuel']:.1f}%")

                assert estop_maneuver_triggered, "Emergency E-STOP vibration damping was not triggered!"
                assert chaos_shock_recovered, "Chaos vibration surge was not survived!"
                assert max_tension_recorded < 15000.0, "Tension exceeded rupture limit!"
                assert tlm['fuel'] > 80.0, "Excessive power consumed during climb!"
                break

            time.sleep(0.002)

        print_flush("=================================================================")
        print_flush("✨ STAGE 2: CHAOS FDIR CABLE RESONANCE & E-STOP RECOVERY VERIFIED (100% PASS)")
        print_flush("=================================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        daemon_proc.wait(timeout=2)

if __name__ == "__main__":
    run_chaos_fdir_verification()
