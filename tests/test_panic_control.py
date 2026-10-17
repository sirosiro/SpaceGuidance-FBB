#!/usr/bin/env python3
import sys
import os
import time
import subprocess
import signal
import math

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def test_stage_ex_panic_control():
    print("======================================================================")
    print(" [TEST STAGE EX] Autonomous Panic Control & Emergency Recovery Test   ")
    print("======================================================================")

    daemon_bin = "/workspaces/SpaceGuidance-FBB/bin/space_guidance_daemon"
    if not os.path.exists(daemon_bin):
        print(f"Error: Daemon binary not found at {daemon_bin}")
        sys.exit(1)

    # Clean up previous instances
    subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)
    time.sleep(0.2)

    # Launch simulation daemon for Stage 5 with deterministic baseline seed (0x1337)
    daemon_proc = subprocess.Popen([daemon_bin, "--stage", "5", "--seed", "0x1337"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(0.5)

    try:
        hw = SpaceGuidanceHardware()
        dt = 0.02
        start = time.time()

        print("  [Step 1] Verifying Pre-Impact Stability and Collision Impact Tumbling State...")
        initial_tlm = hw.read_registers()
        hw.kick_watchdog()
        assert initial_tlm["stage_id"] == 5, f"Expected stage_id 5, got {initial_tlm['stage_id']}"

        # Wait for collision impact event at T = 0.6s
        impact_detected = False
        for _ in range(50):
            tlm = hw.read_registers()
            hw.kick_watchdog()
            if abs(tlm["omega"]) > 1.5:
                impact_detected = True
                initial_tlm = tlm
                break
            time.sleep(0.02)

        assert impact_detected, f"Expected high-rate spin (|omega| > 1.5) after impact, got {initial_tlm['omega']}"
        print(f"  ✓ Stage ID verified: {initial_tlm['stage_id']}")
        print(f"  ✓ Debris Collision Impact Verified at T=0.6s: omega = {initial_tlm['omega']:+.3f} rad/s")

        print("  [Step 2] Executing Phase 1: 3D Detumble (3-Axis Wheels & RCS Rate Damping)...")
        detumble_done = False
        detumble_stable_count = 0

        for step in range(400): # max 8.0 seconds
            tlm = hw.read_registers()
            hw.kick_watchdog()
            omega_z = tlm.get("omega_z", tlm["omega"])
            omega_x = tlm.get("omega_x", 0.0)
            omega_y = tlm.get("omega_y", 0.0)

            rw_torque_z = -1.0 * math.copysign(1.0, omega_z) if abs(omega_z) > 0.02 else 0.0
            rw_torque_x = -1.0 * math.copysign(1.0, omega_x) if abs(omega_x) > 0.02 else 0.0
            rw_torque_y = -1.0 * math.copysign(1.0, omega_y) if abs(omega_y) > 0.02 else 0.0

            rcs_torque_z = -0.85 * omega_z
            rcs_torque_y = -0.85 * omega_y

            hw.write_commands(0.0, 0.0, torque=rcs_torque_z, wheel_torque=rw_torque_z,
                              fdir_mode=1, torque_y=rcs_torque_y,
                              wheel_torque_x=rw_torque_x, wheel_torque_y=rw_torque_y)

            omega_mag = math.sqrt(omega_x**2 + omega_y**2 + omega_z**2)
            if omega_mag < 0.05:
                detumble_stable_count += 1
                if detumble_stable_count >= 15:
                    detumble_done = True
                    detumble_duration = time.time() - start
                    print(f"  ✓ Spacecraft 3D Detumbled successfully in {detumble_duration:.2f}s (|omega| = {omega_mag:.4f} rad/s)!")
                    break
            else:
                detumble_stable_count = 0

            time.sleep(0.01)

        assert detumble_done, "Failed to achieve 3D detumble (|omega| < 0.05) within 8 seconds!"

        # Zero out all torque and thruster commands before entering SysID
        hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=2)
        time.sleep(0.05)

        print("  [Step 3] Executing Phase 2: Online System Identification (12-ch SysID)...")
        healthy_thrusters = set()
        damaged_thrusters = set()

        for idx in range(12):
            hw.kick_watchdog()
            tlm_b = hw.read_registers()
            wb_x, wb_y, wb_z = tlm_b.get("omega_x", 0.0), tlm_b.get("omega_y", 0.0), tlm_b.get("omega_z", tlm_b["omega"])
            hw.write_thruster_pulse(1 << idx)
            time.sleep(0.045)
            tlm_a = hw.read_registers()
            wa_x, wa_y, wa_z = tlm_a.get("omega_x", 0.0), tlm_a.get("omega_y", 0.0), tlm_a.get("omega_z", tlm_a["omega"])
            hw.write_thruster_pulse(0)

            delta_w = math.sqrt((wa_x - wb_x)**2 + (wa_y - wb_y)**2 + (wa_z - wb_z)**2)
            if delta_w > 0.012:
                healthy_thrusters.add(idx)
            else:
                damaged_thrusters.add(idx)
            if abs(wa_z) > 0.008 or abs(wa_x) > 0.008 or abs(wa_y) > 0.008:
                hw.write_reaction_wheel(-0.8 * wa_z,
                                        wheel_torque_x=-0.8 * wa_x,
                                        wheel_torque_y=-0.8 * wa_y)
                time.sleep(0.02)
                hw.write_reaction_wheel(0.0, 0.0, 0.0)
            time.sleep(0.01)

        print(f"  ✓ Healthy Thrusters Identified (out of 12): {sorted(list(healthy_thrusters))}")
        print(f"  ✓ Damaged Thrusters Identified: {sorted(list(damaged_thrusters))}")
        assert len(healthy_thrusters) == 10, f"Expected 10 healthy thrusters, got {len(healthy_thrusters)}"
        assert len(damaged_thrusters) == 2, f"Expected 2 damaged thrusters (T1, T6), got {len(damaged_thrusters)}"
        assert 1 in damaged_thrusters and 6 in damaged_thrusters, f"Expected T1 and T6 damaged, got {damaged_thrusters}"

        print("  [Step 4] Executing Phase 3: Escape Burn to Safe Orbit Line (X >= 35.0m)...")
        escaped = False
        target_att = -math.pi / 4.0 # -45 deg body orientation for forward escape vector

        for step in range(5000): # max 50 seconds
            tlm = hw.read_registers()
            hw.kick_watchdog()

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]
            vel_x = tlm["vel_x"]
            vel_y = tlm["vel_y"]
            angle = tlm["angle"]
            omega = tlm["omega"]
            roll = tlm.get("roll", 0.0)
            pitch = tlm.get("pitch", 0.0)
            omega_x = tlm.get("omega_x", 0.0)
            omega_y = tlm.get("omega_y", 0.0)

            if pos_x >= 35.0:
                escaped = True
                total_duration = time.time() - start
                print(f"  ✓ Reached Safe Orbit boundary at X={pos_x:.2f}m, Y={pos_y:+.2f}m in {total_duration:.2f}s!")
                print(f"  ✓ Remaining Propellant: {tlm['fuel']:.1f}%")
                print(f"  ✓ Official Score: {tlm['official_score']} pts")
                assert tlm['fuel'] > 40.0, "Propellant consumption exceeded budget!"
                assert tlm['official_score'] >= 5000, "Official score below passing grade!"
                assert abs(pos_y) <= 6.0, f"Failed gate: Y={pos_y:.2f}m is outside green gate (|Y| <= 6.0m)!"
                print(f"  ✓ Passed cleanly through Green Safe Orbit Gate (|Y| <= 6.0m)!")
                break

            # Line-of-Sight Guidance towards Gate Center (X=35, Y=0)
            vy_desired = max(-1.2, min(1.2, -0.6 * pos_y))
            vy_err = vy_desired - vel_y
            los_bias = 0.40 * vy_err - 0.25 * pos_y
            steer_target = max(target_att - 0.55, min(target_att + 0.55, target_att + los_bias))

            # Attitude control via 3-Axis Reaction Wheels
            att_err = steer_target - angle
            while att_err > math.pi: att_err -= 2.0 * math.pi
            while att_err < -math.pi: att_err += 2.0 * math.pi

            tau_rw = 1.2 * att_err - 0.9 * omega
            wheel_cmd = max(-0.8, min(0.8, tau_rw))
            wheel_cmd_x = max(-0.8, min(0.8, -1.2 * roll - 0.9 * omega_x))
            wheel_cmd_y = max(-0.8, min(0.8, -1.2 * pitch - 0.9 * omega_y))

            # Fire paired zero-torque thrusters T0 and T5 once attitude is within corridor window
            is_aligned = abs(att_err) < 0.25 # within 14 degrees
            burn_mask = ((1 << 0) | (1 << 5)) if (is_aligned and vel_x < 2.5) else 0

            # When not burning, assist attitude slew with RCS torque
            rcs_cmd = max(-0.8, min(0.8, tau_rw * 0.7)) if burn_mask == 0 else 0.0

            hw.write_commands(
                thrust_x=0.0,
                thrust_y=0.0,
                torque=rcs_cmd,
                wheel_torque=wheel_cmd,
                fdir_mode=3,
                thrust_z=burn_mask,
                wheel_torque_x=wheel_cmd_x,
                wheel_torque_y=wheel_cmd_y
            )
            time.sleep(0.01)

        assert escaped, f"Spacecraft failed to escape into safe orbit corridor (reached X={pos_x:.2f}m)!"

        print("======================================================================")
        print("✨ STAGE EX PANIC CONTROL INTEGRATION TEST VERIFIED (100% PASS)")
        print("======================================================================")

    finally:
        daemon_proc.send_signal(signal.SIGINT)
        daemon_proc.wait(timeout=2)
        subprocess.run(["pkill", "-9", "-f", "space_guidance_daemon"], stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    test_stage_ex_panic_control()
