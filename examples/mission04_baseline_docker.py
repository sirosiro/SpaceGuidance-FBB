#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 4 Deep Space Laser Docking (Baseline Starter)
# 6自由度摩擦ゼロ空間で自転するステーションポートへ精密ドッキングするお手本コードです。

import sys
import os
import time
import math
import json

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware, UartTee

def run_pilot():
    # 実機互換テレメトリ出力: ターミナル画面と Zynq PS UART1 (/dev/ttyPS1) へ同時複製配信
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    print("[Pilot] Stage 4: Deep Space Optical Laser Docking System Online.")
    print("[Pilot] Range: 50m Approach Corridor. Target: Rotating Port #01.")
    print("[Pilot] Sensors: 4-Quadrant Photodiode (QPD) + Minimum-Impulse RCS.\n")

    kp_los = 1.40              # 光軸中心引き込みゲイン (横並進補正)
    kd_los = 0.85              # 光軸ドリフト速度ダンピング
    kp_att = 2.00              # 姿勢角アライメントゲイン
    kd_att = 1.20              # 角速度ダンピング
    v_contact_target = 0.018   # 目標接触速度 (0.005 ~ 0.035 m/s)

    checkpoint_dist = [40.0, 30.0, 20.0, 10.0, 5.0, 2.0, 1.0]
    checked = [False] * len(checkpoint_dist)

    try:
        while True:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            dist = 50.0 - tlm["pos_x"] # ポートまでの残り距離 (m)
            approach_vel = tlm["vel_x"] # 接近速度 (m/s)
            qpd_err = tlm["cross_track_err"] # QPD光軸オフセット (m)
            angle = tlm["angle"]
            omega = tlm["omega"]
            fuel = tlm["fuel"]

            # チェックポイント通過報告
            for c_idx, c_d in enumerate(checkpoint_dist):
                if not checked[c_idx] and dist <= c_d:
                    checked[c_idx] = True
                    align_cm = abs(qpd_err) * 100.0
                    print(f"[NAV RANGE {c_d:4.1f}m] Align Err: {align_cm:4.1f}cm | Vel: {approach_vel:.3f}m/s")

            # ドッキング接触判定
            if dist <= 0.05:
                time.sleep(0.15)
                hw.print_summary("STAGE 4: DEEP SPACE LASER DOCKING")
                break

            # 誘導制御
            if dist < 3.0:
                desired_vel = max(v_contact_target, dist * 0.18)
                f_forward = (desired_vel - approach_vel) * 3.5
            else:
                desired_vel = max(v_contact_target, min(2.5, math.sqrt(dist * 0.25)))
                f_forward = (desired_vel - approach_vel) * 1.8
            f_forward = max(-1.0, min(1.0, f_forward))

            # 横光軸引き込み
            f_lateral = - (qpd_err * kp_los + tlm["vel_y"] * kd_los)
            f_lateral = max(-0.8, min(0.8, f_lateral))

            # 姿勢制御
            tau_cmd = - (angle * kp_att + omega * kd_att)
            tau_cmd = max(-0.6, min(0.6, tau_cmd))

            hw.write_commands(thrust_x=f_forward, thrust_y=f_lateral, torque=tau_cmd)
            time.sleep(0.01)

    except KeyboardInterrupt:
        print("\n[Pilot] User aborted mission.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0)
        hw.close()
        if tee:
            tee.close()

if __name__ == "__main__":
    run_pilot()
