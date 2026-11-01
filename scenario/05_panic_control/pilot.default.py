#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage EX Panic Control Autopilot (Baseline Starter)
# ==============================================================================
# このスクリプトは、デブリ衝突による高速スピン・一部スラスタ破損の極限状況から
# 機体の制御を自律回復し、安全圏へ脱出するパニックコントロール・アルゴリズムです。
#
# 【3フェーズ・リカバリー・シーケンス】:
#   Phase 1: 緊急デタンブル (Rate Damping + Reaction Wheel 最大逆トルク)
#   Phase 2: オンライン・システム同定 (マイクロパルス噴射による破損ノズル自動特定)
#   Phase 3: 制御配分 & 脱出バーン (生き残りノズルによる推力最適化 & デブリ回避)
# ==============================================================================

import sys
import os
import time
import math
import json

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware, UartTee

def run_pilot():
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    hw.engage() # 公式タイマースタート (ADR #002)

    print("\n======================================================================")
    print("  🚨 STAGE EX: EMERGENCY DEBRIS IMPACT - PANIC CONTROL AUTOPILOT 🚨   ")
    print("======================================================================")
    print("  Status: HIGH-RATE TUMBLING DETECTED | PROPELLANT LEAK ACTIVE")
    print("  Objective: Detumble -> Identify Dead Thrusters -> Escape Safe Orbit")
    print("======================================================================\n")

    dt = 0.02
    panic_start_time = time.time()

    # === TUNE ZONE 1: デタンブル制動ゲイン ===
    kd_detumble = 2.5        # レートダンピングゲイン (RCS)
    rw_gain = 1.0            # リアクションホイール最大トルク比率

    # === TUNE ZONE 2: 脱出巡航パラメータ ===
    escape_speed_target = 1.8 # 目標脱出速度 (m/s)

    # 12基 6-DoF RCS スラスタ公称特性マトリクス
    THRUSTER_PROPERTIES = [
        {"name": "T0:Aft-L (Fwd)",   "fx": +20.0, "fy":   0.0, "fz":   0.0, "tau_z": -20.0},
        {"name": "T1:Aft-R (Fwd)",   "fx": +20.0, "fy":   0.0, "fz":   0.0, "tau_z": +20.0},
        {"name": "T2:Fwd-L (Rev)",   "fx": -20.0, "fy":   0.0, "fz":   0.0, "tau_z": +20.0},
        {"name": "T3:Fwd-R (Rev)",   "fx": -20.0, "fy":   0.0, "fz":   0.0, "tau_z": -20.0},
        {"name": "T4:Aft-P (Lat)",   "fx":   0.0, "fy": +20.0, "fz":   0.0, "tau_z": -20.0},
        {"name": "T5:Fwd-P (Lat)",   "fx":   0.0, "fy": +20.0, "fz":   0.0, "tau_z": +20.0},
        {"name": "T6:Aft-S (Lat)",   "fx":   0.0, "fy": -20.0, "fz":   0.0, "tau_z": +20.0},
        {"name": "T7:Fwd-S (Lat)",   "fx":   0.0, "fy": -20.0, "fz":   0.0, "tau_z": -20.0},
        {"name": "T8:Dor-F (Pitch)", "fx":   0.0, "fy":   0.0, "fz": +20.0, "tau_y": -25.0},
        {"name": "T9:Ven-F (Pitch)", "fx":   0.0, "fy":   0.0, "fz": -20.0, "tau_y": +25.0},
        {"name": "T10:Dor-A(Pitch)", "fx":   0.0, "fy":   0.0, "fz": +20.0, "tau_y": +25.0},
        {"name": "T11:Ven-A(Pitch)", "fx":   0.0, "fy":   0.0, "fz": -20.0, "tau_y": -25.0},
    ]

    healthy_thrusters = set()
    phase = 0 # 0: Panic Prologue Assessment, 1: 3D Detumble, 2: 12-ch SysID, 3: 6-DoF Escape
    detumble_stable_ticks = 0
    last_logged_x = -1

    try:
        while True:
            tlm = hw.read_registers()
            hw.kick_watchdog()

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]
            pos_z = tlm.get("pos_z", 0.0)
            vel_x = tlm["vel_x"]
            vel_y = tlm["vel_y"]
            vel_z = tlm.get("vel_z", 0.0)
            angle = tlm["angle"]
            omega = tlm["omega"]
            omega_x = tlm.get("omega_x", 0.0)
            omega_y = tlm.get("omega_y", 0.0)
            omega_z = tlm.get("omega_z", omega)
            roll = tlm.get("roll", 0.0)
            pitch = tlm.get("pitch", 0.0)
            yaw = tlm.get("yaw", angle)
            fuel = tlm["fuel"]
            wheel_rpm = tlm["wheel_rpm"]

            omega_mag = math.sqrt(omega_x**2 + omega_y**2 + omega_z**2)

            # -------------------------------------------------------------
            # ゴール判定 (X >= 35.0m で安全圏脱出)
            # -------------------------------------------------------------
            if pos_x >= 35.0 or tlm.get("mission_status", 0) == 1:
                time.sleep(0.15)
                hw.print_summary("STAGE 5: PANIC CONTROL")
                break

            if fuel <= 0.0:
                print("\n[EMERGENCY] Propellant depleted! Mission Failed.")
                break

            # -------------------------------------------------------------
            # PHASE 0: 衝突緊急事態検知 & 3Dカオスタンブリング観察 (4.5秒間プロローグ)
            # -------------------------------------------------------------
            if phase == 0:
                elapsed_panic = time.time() - panic_start_time
                hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=0)
                spin_deg = omega_mag * 180.0 / math.pi
                if int(elapsed_panic * 10) % 5 == 0:
                    if omega_mag < 0.1:
                        sys.stdout.write(f"\r  🛰️  [NOMINAL CRUISE] APPROACHING DEBRIS FIELD ({elapsed_panic:3.1f}s)...")
                    else:
                        sys.stdout.write(f"\r  🚨 [3D PANIC ASSESSMENT] P={omega_x*57.3:+4.0f}°/s Q={omega_y*57.3:+4.0f}°/s R={omega_z*57.3:+4.0f}°/s | |ω|={spin_deg:5.1f}°/s ({elapsed_panic:3.1f}/4.5s)...")
                    sys.stdout.flush()

                if elapsed_panic >= 4.5:
                    print(f"\n\n[PHASE 1 ENGAGED] Autonomous 6-DoF Recovery: Engaging 3-Axis Reaction Wheels & RCS Damping!")
                    phase = 1

            # -------------------------------------------------------------
            # PHASE 1: 3D緊急デタンブル (3-Axis Detumble)
            # -------------------------------------------------------------
            elif phase == 1:
                # 3軸リアクションホイールで角運動量を全力吸収（燃料消費ゼロ）
                rw_torque_z = -rw_gain * math.copysign(1.0, omega_z) if abs(omega_z) > 0.02 else 0.0
                rw_torque_x = -rw_gain * math.copysign(1.0, omega_x) if abs(omega_x) > 0.02 else 0.0
                rw_torque_y = -rw_gain * math.copysign(1.0, omega_y) if abs(omega_y) > 0.02 else 0.0

                # RCS レートダンピング逆噴射 (ピッチ・ヨー軸)
                rcs_torque_z = -kd_detumble * omega_z
                rcs_torque_y = -kd_detumble * omega_y

                hw.write_commands(
                    thrust_x=0.0, thrust_y=0.0,
                    torque=rcs_torque_z, wheel_torque=rw_torque_z,
                    fdir_mode=1,
                    torque_y=rcs_torque_y,
                    wheel_torque_x=rw_torque_x, wheel_torque_y=rw_torque_y
                )

                if omega_mag < 0.05:
                    detumble_stable_ticks += 1
                    # 公式審判の制動判定 (0.5秒保持) を確実にラッチ
                    if detumble_stable_ticks >= 26 or tlm.get("is_detumbled", 0) == 1:
                        print(f"\n[PHASE 1 COMPLETE] Spacecraft 3D Detumbled! (|omega|={omega_mag:.4f} rad/s)")
                        print("[PHASE 2 ENGAGED] Starting Online System Identification (12-ch SysID)...")
                        phase = 2
                        detumble_stable_ticks = 0
                else:
                    detumble_stable_ticks = 0

            # -------------------------------------------------------------
            # PHASE 2: 12チャンネル・オンライン・システム同定 (Online SysID)
            # -------------------------------------------------------------
            elif phase == 2:
                hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=2)
                # 全12基のスラスタを1基ずつ微小パルス噴射して健全性を判定
                for idx in range(12):
                    hw.kick_watchdog()
                    tlm_b = hw.read_registers()
                    wb_x = tlm_b.get("omega_x", 0.0)
                    wb_y = tlm_b.get("omega_y", 0.0)
                    wb_z = tlm_b.get("omega_z", tlm_b["omega"])

                    # 25ms 微小パルス噴射
                    hw.write_thruster_pulse(1 << idx)
                    time.sleep(0.025)
                    tlm_a = hw.read_registers()
                    wa_x = tlm_a.get("omega_x", 0.0)
                    wa_y = tlm_a.get("omega_y", 0.0)
                    wa_z = tlm_a.get("omega_z", tlm_a["omega"])
                    hw.write_thruster_pulse(0)

                    delta_w = math.sqrt((wa_x - wb_x)**2 + (wa_y - wb_y)**2 + (wa_z - wb_z)**2)
                    is_ok = delta_w > 0.010
                    name = THRUSTER_PROPERTIES[idx]["name"]
                    if is_ok:
                        healthy_thrusters.add(idx)
                        print(f"  ✓ Thruster {name}: HEALTHY (Response |Δω| = {delta_w:+.4f} rad/s)")
                    else:
                        print(f"  ✗ Thruster {name}: DAMAGED / DEAD (Zero response)")

                    # リアクションホイールで角速度残余を即時相殺（燃料消費ゼロ）
                    hw.write_reaction_wheel(
                        -max(-0.6, min(0.6, 2.0 * wa_z)),
                        wheel_torque_x=-max(-0.6, min(0.6, 2.0 * wa_x)),
                        wheel_torque_y=-max(-0.6, min(0.6, 2.0 * wa_y))
                    )
                    time.sleep(0.015)
                    hw.write_reaction_wheel(0.0, 0.0, 0.0)

                print(f"\n[PHASE 2 COMPLETE] Healthy Thrusters Identified: {sorted(list(healthy_thrusters))}")
                print("[PHASE 3 ENGAGED] Initiating Control Allocation & 6-DoF Escape Burn...")
                phase = 3

            # -------------------------------------------------------------
            # PHASE 3: 制御配分 & 6-DoF脱出バーン (Control Allocation & Escape)
            # -------------------------------------------------------------
            elif phase == 3:
                # 健全スラスタ群からトルクゼロ (tau_z = 0) の最適前進推力ペアを選択
                burn_mask = 0
                target_att = 0.0

                if 0 in healthy_thrusters and 1 in healthy_thrusters:
                    # T0 (Fwd, tau=-20) + T1 (Fwd, tau=+20) -> Fx=+40, Fy=0, tau=0
                    burn_mask = (1 << 0) | (1 << 1)
                    target_att = 0.0
                elif 0 in healthy_thrusters and 5 in healthy_thrusters:
                    # T0 (Fwd, tau=-20) + T5 (Port, tau=+20) -> Fx=+20, Fy=+20, tau=0
                    burn_mask = (1 << 0) | (1 << 5)
                    target_att = -math.pi / 4.0
                elif 0 in healthy_thrusters and 6 in healthy_thrusters:
                    # T0 (Fwd, tau=-20) + T6 (Stbd, tau=+20) -> Fx=+20, Fy=-20, tau=0
                    burn_mask = (1 << 0) | (1 << 6)
                    target_att = math.pi / 4.0
                elif 1 in healthy_thrusters and 4 in healthy_thrusters:
                    # T1 (Fwd, tau=+20) + T4 (Port, tau=-20) -> Fx=+20, Fy=+20, tau=0
                    burn_mask = (1 << 1) | (1 << 4)
                    target_att = -math.pi / 4.0
                elif 1 in healthy_thrusters and 7 in healthy_thrusters:
                    # T1 (Fwd, tau=+20) + T7 (Stbd, tau=-20) -> Fx=+20, Fy=-20, tau=0
                    burn_mask = (1 << 1) | (1 << 7)
                    target_att = math.pi / 4.0
                elif 4 in healthy_thrusters and 5 in healthy_thrusters:
                    # T4 (Port, tau=-20) + T5 (Port, tau=+20) -> Fy=+40, tau=0
                    burn_mask = (1 << 4) | (1 << 5)
                    target_att = -math.pi / 2.0
                elif 6 in healthy_thrusters and 7 in healthy_thrusters:
                    # T6 (Stbd, tau=+20) + T7 (Stbd, tau=-20) -> Fy=-40, tau=0
                    burn_mask = (1 << 6) | (1 << 7)
                    target_att = math.pi / 2.0
                else:
                    burn_mask = (1 << 0) if 0 in healthy_thrusters else (1 << 1)
                    target_att = 0.0

                # 視線誘導 (Line-of-Sight Guidance) による中央コリドー (Y=0, Z=0) への誘導
                vy_desired = max(-0.35, min(0.35, -0.30 * pos_y))
                vy_err = vy_desired - vel_y

                vz_desired = max(-0.35, min(0.35, -0.6 * pos_z))
                vz_err = vz_desired - vel_z

                los_bias = 0.50 * vy_err - 0.25 * pos_y
                steer_target = max(target_att - 0.40, min(target_att + 0.40, target_att + los_bias))

                att_err = steer_target - angle
                while att_err > math.pi: att_err -= 2.0 * math.pi
                while att_err < -math.pi: att_err += 2.0 * math.pi

                tau_rw_z = 1.5 * att_err - 0.8 * omega_z
                wheel_cmd_z = max(-0.8, min(0.8, tau_rw_z))

                # 3軸ホイールによるピッチ・ロールの常時ゼロ位ロック
                wheel_cmd_x = max(-0.8, min(0.8, -1.5 * roll - 0.8 * omega_x))
                wheel_cmd_y = max(-0.8, min(0.8, -1.5 * pitch - 0.8 * omega_y))

                # 垂直Z軸アクティブ制御 (BULLSEYE 確約: Z -> 0, Vz -> 0)
                vert_mask = 0
                if vz_err > 0.08 and 8 in healthy_thrusters and 10 in healthy_thrusters:
                    vert_mask = (1 << 8) | (1 << 10)
                elif vz_err < -0.08 and 9 in healthy_thrusters and 11 in healthy_thrusters:
                    vert_mask = (1 << 9) | (1 << 11)

                is_aligned = abs(att_err) < 0.16
                needs_cross_corr = abs(pos_y) > 0.25 and vel_x < 2.0
                fwd_burn = burn_mask if (is_aligned and (vel_x < escape_speed_target or needs_cross_corr)) else 0
                active_burn = fwd_burn | vert_mask

                hw.write_commands(
                    thrust_x=0.0,
                    thrust_y=0.0,
                    torque=0.0, # ブラインドミキサー干渉を防ぎホイール単独で高精度姿勢維持
                    wheel_torque=wheel_cmd_z,
                    fdir_mode=3,
                    thrust_z=active_burn,
                    wheel_torque_x=wheel_cmd_x,
                    wheel_torque_y=wheel_cmd_y
                )

                if int(pos_x) % 5 == 0 and int(pos_x) != last_logged_x:
                    last_logged_x = int(pos_x)
                    r_c = math.sqrt(pos_y**2 + pos_z**2)
                    print(f"  [CRUISE] X={pos_x:4.1f}m | Y={pos_y:+5.2f}m Z={pos_z:+5.2f}m (r={r_c:4.2f}m) | Vx={vel_x:4.2f} Vy={vel_y:+4.2f} Vz={vel_z:+4.2f} m/s | Yaw={angle*57.3:+5.1f}° | Burn=0x{active_burn:03X}")

            time.sleep(dt)

    except KeyboardInterrupt:
        print("\n[Pilot] Manual abort.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0)
        hw.close()
        if tee:
            tee.close()

if __name__ == "__main__":
    run_pilot()
