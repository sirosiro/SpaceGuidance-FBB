#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 3 ISS Truss Inspector (Baseline Starter)
# 国際宇宙ステーション (ISS) の立体トラス外壁レールを巡回・スキャンするお手本コードです。

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
    print("[Pilot] Stage 3: ISS Truss Inspector System Online.")
    print("[Pilot] 60m 3D Truss Rail Corridor. 4 Critical Inspection Joints.")
    print("[Pilot] Actuators: 3D Rail Drive + Electromagnetic Gripper Latch.\n")

    # =========================================================================
    # 🎯 TUNE ZONE 1: 巡航速度とコーナー遠心力リミット
    # =========================================================================
    target_velocity = 1.8      # 直線部目標巡航速度 (m/s)
    corner_velocity = 0.8      # 急カーブ手前での減速速度 (m/s)
    kp_drive = 0.90            # 駆動比例ゲイン

    # =========================================================================
    # 🧲 TUNE ZONE 2: 電磁グリッパー把持シーケンス
    # =========================================================================
    latch_settle_time = 0.6    # 点検ポイントでの把持静止待機時間 (秒)

    # 4箇所の点検ジョイント (15m, 30m, 45m, 60m)
    inspection_joints = [15.0, 30.0, 45.0, 60.0]
    joint_scanned = [False] * len(inspection_joints)
    total_score = 0
    start_time = time.time()

    try:
        while True:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            pos_x = tlm["pos_x"]          # レール沿い距離 (m)
            vel_x = tlm["vel_x"]          # 走行速度 (m/s)
            rail_load = tlm["cross_track_err"] # 遠心ラジアル荷重 (N)
            fuel = tlm["fuel"]

            # レール脱線チェック (許容300N)
            if abs(rail_load) > 300.0:
                print(f"\n🚨 [DERAILMENT] Centrifugal rail load exceeded 300N ({abs(rail_load):.1f}N)! Off-track failure.")
                break

            # ゴール完了判定 (60m)
            if pos_x >= 60.0 and all(joint_scanned):
                elapsed = time.time() - start_time
                print(f"\n============================================================")
                print(f"🏁 [MISSION COMPLETE] ISS Truss Survey Complete! (Distance: {pos_x:.2f}m)")
                print(f"⏱️ Clear Time: {elapsed:.2f}s | 🔋 Battery Left: {fuel:.1f}%")

                fuel_bonus = int(fuel * 10.0)
                time_bonus = max(0, int((50.0 - elapsed) * 50.0))
                final_score = total_score + fuel_bonus + time_bonus
                print(f"📊 Final Score: {final_score} pts (Joints: {total_score}, Fuel: +{fuel_bonus}, Time: +{time_bonus})")
                rank = "GRADE S (Master Inspector)" if final_score >= 8000 else ("GRADE A" if final_score >= 6500 else "GRADE B")
                print(f"🏆 Rank: {rank}")
                print(f"============================================================\n")
                break

            # 点検ポイント把持シーケンス
            approaching_joint = False
            for j_idx, j_pos in enumerate(inspection_joints):
                dist_to_joint = j_pos - pos_x
                if not joint_scanned[j_idx]:
                    if -0.2 <= dist_to_joint <= 0.2 and abs(vel_x) < 0.25:
                        print(f"[JOINT {j_idx+1:02d}] At {j_pos:.1f}m -> Latching Electromagnetic Gripper...")
                        hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=1)
                        time.sleep(latch_settle_time)
                        print(f"[JOINT {j_idx+1:02d}] Laser Scan Complete! Gripper unlatched. +1500 pts")
                        joint_scanned[j_idx] = True
                        total_score += 1500
                    elif 0.0 < dist_to_joint < 3.0:
                        approaching_joint = True

            # 速度計画: コーナー(20m, 40m)や点検ポイント手前では減速
            in_corner = (18.0 < pos_x < 25.0) or (38.0 < pos_x < 45.0)
            desired_v = corner_velocity if (in_corner or approaching_joint) else target_velocity

            drive_cmd = max(-0.5, min(0.9, (desired_v - vel_x) * kp_drive + 0.15))
            hw.write_commands(thrust_x=drive_cmd, thrust_y=0.0, torque=0.0)
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
