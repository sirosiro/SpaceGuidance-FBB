#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 4 Deep Space Laser Docking (Calibrated High-Precision Autopilot)
# 6自由度摩擦ゼロ空間で自転するステーションポートへ精密ドッキングする制御コードです。

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
    # 実機互換テレメトリ出力: ターミナル画面と Zynq PS UART1 (/dev/ttyPS1) へ同時複製配信
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    print("[Pilot] Stage 4: Deep Space Optical Laser Docking System Online.")
    print("[Pilot] Range: 50m Approach Corridor. Target: Rotating Port #01.")
    print("[Pilot] Sensors: 4-Quadrant Photodiode (QPD) + Minimum-Impulse RCS.\n")

    kp_los = 1.60              # 光軸中心引き込みゲイン (横並進補正)
    kd_los = 0.95              # 光軸ドリフト速度ダンピング
    kp_att = 3.50              # 姿勢角・回転同期アライメントゲイン
    kd_att = 1.80              # 角速度ダンピング
    v_contact_target = 0.018   # 目標接触速度 (0.005 ~ 0.035 m/s)

    checkpoint_dist = [40.0, 30.0, 20.0, 10.0, 5.0, 2.0, 1.0]
    checked = [False] * len(checkpoint_dist)

    # 4-Phase Flight State Machine (ユーザー仕様準拠 4段階ドッキング誘導)
    # Phase 1: HEADING_ALIGN   - 360度初期方位角の解消・ステーション正面への正対 (Yaw -> 0)
    # Phase 2: SPIN_SYNC       - ステーション遠心自転速度・ロール角の位相同期 (Roll -> Target)
    # Phase 3: AXIS_CENTERING  - QPD レーザー光軸（回廊中心）への並進センタリング (|Y| < 3cm)
    # Phase 4: FINAL_GLIDESLOPE - 50m 回廊進入・減速プロファイル・ソフトドッキング (v <= 0.018m/s)
    PHASE_HEADING_ALIGN = 1
    PHASE_SPIN_SYNC = 2
    PHASE_AXIS_CENTERING = 3
    PHASE_FINAL_GLIDESLOPE = 4
    flight_phase = PHASE_HEADING_ALIGN

    print("[Phase 1/4: HEADING ALIGN] Canceling 360-degree initial attitude tilt...")

    try:
        while True:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            dist = 50.0 - tlm["pos_x"] # ポートまでの残り距離 (m)
            approach_vel = tlm["vel_x"] # 接近速度 (m/s)
            qpd_err = tlm["cross_track_err"] # QPD光軸オフセット (m)
            vel_y = tlm["vel_y"]
            yaw = tlm.get("yaw", tlm.get("angle", 0.0))
            omega_yaw = tlm.get("omega_z", tlm.get("omega", 0.0))
            rel_angle = tlm.get("rel_angle", 0.0)
            rel_omega = tlm.get("rel_omega", 0.0)

            # チェックポイント通過報告 (Phase 4 進入後)
            for c_idx, c_d in enumerate(checkpoint_dist):
                if not checked[c_idx] and dist <= c_d:
                    checked[c_idx] = True
                    align_cm = abs(qpd_err) * 100.0
                    ang_err_deg = abs(rel_angle) * (180.0 / math.pi)
                    print(f"[NAV RANGE {c_d:4.1f}m] Align Err: {align_cm:4.1f}cm | Att Err: {ang_err_deg:3.1f}deg | Vel: {approach_vel:.3f}m/s")

            # ドッキング接触判定
            if dist <= 0.05:
                time.sleep(0.15)
                hw.print_summary("STAGE 4: DEEP SPACE LASER DOCKING (ISS HARMONY PMA-2)")
                break

            # -------------------------------------------------------------
            # 1. 姿勢・ステーション自転同期制御 (Yaw正対 & Roll自転同期)
            # -------------------------------------------------------------
            # Yaw Heading Control (ドッキング回廊 +X 軸への正対)
            yaw_err = math.atan2(math.sin(yaw), math.cos(yaw))
            tau_yaw = - (yaw_err * kp_att + omega_yaw * kd_att)
            tau_yaw = max(-1.0, min(1.0, tau_yaw))

            # Roll Spin Tracking Control (ステーション自転への位相同期)
            roll_err = math.atan2(math.sin(rel_angle), math.cos(rel_angle))
            tau_roll = - (roll_err * kp_att + rel_omega * kd_att)
            tau_roll = max(-1.0, min(1.0, tau_roll))

            # -------------------------------------------------------------
            # 2. 状態遷移マシン (4-Phase FSM)
            # -------------------------------------------------------------
            if flight_phase == PHASE_HEADING_ALIGN:
                # フェーズ1: 360度初期方位角の解消・ステーション正面への正対
                if abs(yaw_err) < 0.06 and abs(omega_yaw) < 0.04:
                    flight_phase = PHASE_SPIN_SYNC
                    print(f"[Phase 2/4: SPIN SYNC] Heading locked! Tracking station centrifugal spin (Omega={tlm.get('target_omega', 0.02):.3f} rad/s)...")

            elif flight_phase == PHASE_SPIN_SYNC:
                # フェーズ2: ステーションの回転速度および角度同期
                if abs(roll_err) < 0.035 and abs(rel_omega) < 0.025 and abs(yaw_err) < 0.06:
                    flight_phase = PHASE_AXIS_CENTERING
                    print(f"[Phase 3/4: AXIS CENTERING] Spin synchronized! Aligning with ISS laser glideslope corridor (|Y| < 3cm)...")

            elif flight_phase == PHASE_AXIS_CENTERING:
                # フェーズ3: ドッキング回廊中心への並進引き込み (Xは静止維持)
                if abs(qpd_err) < 0.030 and abs(vel_y) < 0.025 and abs(yaw_err) < 0.05 and abs(roll_err) < 0.035:
                    flight_phase = PHASE_FINAL_GLIDESLOPE
                    print("[Phase 4/4: FINAL GLIDESLOPE] Corridor locked! Initiating forward approach to ISS PMA-2...")

            # -------------------------------------------------------------
            # 3. フェーズに応じた並進推力生成 (ワールド座標系)
            # -------------------------------------------------------------
            fy_world = - (qpd_err * kp_los + vel_y * kd_los)

            if flight_phase in (PHASE_HEADING_ALIGN, PHASE_SPIN_SYNC, PHASE_AXIS_CENTERING):
                # 接近前待機: 回廊軸と回転が同期するまで前進せず静止
                fx_world = - approach_vel * 2.5
            else:
                # フェーズ4: 50m アプローチ・減速プロファイル
                if dist < 3.0:
                    desired_vel = max(v_contact_target, dist * 0.18)
                    fx_world = (desired_vel - approach_vel) * 3.5
                else:
                    desired_vel = max(v_contact_target, min(2.5, math.sqrt(dist * 0.28)))
                    fx_world = (desired_vel - approach_vel) * 2.0

            # -------------------------------------------------------------
            # 4. 座標変換: ワールド座標系推力 -> 機体座標系スラスタ推力
            # -------------------------------------------------------------
            cos_a = math.cos(yaw)
            sin_a = math.sin(yaw)
            f_forward = fx_world * cos_a + fy_world * sin_a
            f_lateral = -fx_world * sin_a + fy_world * cos_a

            f_forward = max(-1.0, min(1.0, f_forward))
            f_lateral = max(-0.8, min(0.8, f_lateral))

            hw.write_commands(thrust_x=f_forward, thrust_y=f_lateral, torque=tau_yaw, torque_x=tau_roll)
            time.sleep(0.01)

    except KeyboardInterrupt:
        print("\n[Pilot] User aborted mission.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0, torque_x=0.0)
        hw.close()
        if tee:
            tee.close()

if __name__ == "__main__":
    run_pilot()
