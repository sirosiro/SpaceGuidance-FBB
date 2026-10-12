#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 4 Deep Space Laser Docking (Baseline Starter)
# 6自由度摩擦ゼロ空間で自転するステーションポートへ精密ドッキングするお手本コードです。

import sys
import os
import time
import math

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware

class UartTee:
    def __init__(self, uart_dev="/dev/ttyPS1"):
        self.stdout = sys.__stdout__
        self.uart_fd = None
        try:
            self.uart_fd = os.open(uart_dev, os.O_RDWR | os.O_NOCTTY)
        except Exception:
            self.uart_fd = None

    def write(self, data):
        self.stdout.write(data)
        if self.uart_fd is not None:
            try:
                formatted = data.replace("\r\n", "\n").replace("\r", "")
                os.write(self.uart_fd, formatted.encode("utf-8"))
            except Exception:
                pass

    def flush(self):
        self.stdout.flush()

    def close(self):
        if self.uart_fd is not None:
            try:
                os.close(self.uart_fd)
            except Exception:
                pass
            self.uart_fd = None

def run_pilot():
    tee = UartTee()
    sys.stdout = tee
    hw = SpaceGuidanceHardware()
    print("[Pilot] Stage 4: Deep Space Optical Laser Docking System Online.")
    print("[Pilot] Range: 50m Approach Corridor. Target: Rotating Port #01.")
    print("[Pilot] Sensors: 4-Quadrant Photodiode (QPD) + Minimum-Impulse RCS.\n")

    # =========================================================================
    # 🎯 TUNE ZONE 1: 6-DoF 視線誘導 (Line-of-Sight) ゲイン
    # =========================================================================
    kp_los = 0.85              # 光軸中心引き込みゲイン (横並進補正)
    kd_los = 0.45              # 光軸ドリフト速度ダンピング
    kp_roll = 0.60             # 自転ステーション同期ロール追従ゲイン

    # =========================================================================
    # 🛑 TUNE ZONE 2: 最終ドッキング減速カーブ
    # =========================================================================
    v_contact_target = 0.015   # 目標接触速度 (0.005 ~ 0.020 m/s の極小速度)

    start_time = time.time()
    checkpoint_dist = [40.0, 30.0, 20.0, 10.0, 5.0, 2.0, 1.0]
    checked = [False] * len(checkpoint_dist)
    total_score = 0

    try:
        while True:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            dist = 50.0 - tlm["pos_x"] # ポートまでの残り距離 (m)
            approach_vel = tlm["vel_x"] # 接近速度 (m/s)
            qpd_err = tlm["cross_track_err"] # QPD光軸オフセット (m)
            fuel = tlm["fuel"]

            # チェックポイント通過報告
            for c_idx, c_d in enumerate(checkpoint_dist):
                if not checked[c_idx] and dist <= c_d:
                    checked[c_idx] = True
                    align_cm = abs(qpd_err) * 100.0
                    pts = 1000 if align_cm < 1.0 else (800 if align_cm < 3.0 else 400)
                    total_score += pts
                    print(f"[RANGE {c_d:4.1f}m] Align Err: {align_cm:4.1f}cm | Vel: {approach_vel:.3f}m/s | Alignment: +{pts} pts | Total: {total_score} pts")

            # ドッキング接触判定
            if dist <= 0.05:
                elapsed = time.time() - start_time
                print(f"\n============================================================")
                print(f"🏁 [DOCKING CONTACT] Port Latch Engaged!")
                print(f"⏱️ Contact Speed: {approach_vel:.4f} m/s (Target: 0.005-0.020 m/s)")
                print(f"🎯 Final Alignment Offset: {abs(qpd_err)*100.0:.2f} cm")
                print(f"🔋 Delta-V / Fuel Left: {fuel:.1f}% | Elapsed Time: {elapsed:.2f}s")

                speed_ok = (0.005 <= approach_vel <= 0.025)
                align_ok = (abs(qpd_err) <= 0.02)
                if speed_ok and align_ok:
                    bonus = 3000
                    print("✅ SOFT DOCKING SUCCESSFUL! [PERFECT CONTACT] +3000 pts")
                elif speed_ok:
                    bonus = 1500
                    print("⚠️ DOCKED with slight angular stress. +1500 pts")
                else:
                    bonus = 0
                    print("❌ HARD CONTACT! Docking ring velocity over limits.")

                fuel_bonus = int(fuel * 10.0)
                final_score = total_score + bonus + fuel_bonus
                print(f"📊 Final Score: {final_score} pts (Corridor: {total_score}, Contact: +{bonus}, Fuel: +{fuel_bonus})")
                rank = "GRADE S (Elite Astronaut)" if final_score >= 8000 else ("GRADE A" if final_score >= 6500 else "GRADE B")
                print(f"🏆 Rank: {rank}")
                print(f"============================================================\n")
                break

            # 誘導制御: 距離に応じた理想接近速度 (根号プロファイル)
            desired_vel = max(v_contact_target, min(1.5, math.sqrt(max(0.01, dist * 0.15))))
            f_forward = (desired_vel - approach_vel) * 0.8
            f_forward = max(-0.5, min(0.8, f_forward))

            # 横光軸引き込み
            f_lateral = - (qpd_err * kp_los + tlm["vel_y"] * kd_los)
            f_lateral = max(-0.5, min(0.5, f_lateral))

            hw.write_commands(thrust_x=f_forward, thrust_y=f_lateral, torque=0.0)
            time.sleep(0.02)

    except KeyboardInterrupt:
        print("\n[Pilot] User aborted mission.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0)
        hw.close()
        if tee:
            tee.close()
        sys.stdout = sys.__stdout__

if __name__ == "__main__":
    run_pilot()
