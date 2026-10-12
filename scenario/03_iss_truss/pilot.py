#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 3 ISS Truss Inspector (Calibrated High-Performance Autopilot)
# 国際宇宙ステーション (ISS) の立体トラス外壁レールを巡回・スキャンする制御コードです。

import sys
import os
import time
import math

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware, UartTee

def run_pilot():
    # 実機互換テレメトリ出力: ターミナル画面と Zynq PS UART1 (/dev/ttyPS1) へ同時複製配信
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    print("[Pilot] Stage 3: ISS Truss Inspector System Online.")
    print("[Pilot] 60m 3D Truss Rail Corridor. 4 Critical Inspection Joints.")
    print("[Pilot] Actuators: 3D Rail Drive + Electromagnetic Gripper Latch.\n")

    target_velocity = 2.4      # 直線部目標巡航速度 (m/s)
    corner_velocity = 1.0      # 急カーブ手前での減速速度 (m/s)
    kp_drive = 1.80            # 駆動比例ゲイン
    latch_settle_time = 0.3    # 点検ポイントでの把持静止待機時間 (秒)

    inspection_joints = [15.0, 30.0, 45.0, 60.0]
    joint_scanned = [False] * len(inspection_joints)
    start_time = time.time()
    last_print_dist = 0.0

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

            # 次の未点検ジョイント検索
            next_j_idx = -1
            dist_to_next = 999.0
            for j_idx, j_pos in enumerate(inspection_joints):
                if not joint_scanned[j_idx]:
                    next_j_idx = j_idx
                    dist_to_next = j_pos - pos_x
                    break

            # ジョイント把持判定
            if next_j_idx != -1 and -0.35 <= dist_to_next <= 0.35 and abs(vel_x) < 0.35:
                j_pos = inspection_joints[next_j_idx]
                print(f"[JOINT {next_j_idx+1:02d}] At {j_pos:.1f}m -> Latching Electromagnetic Gripper...")
                hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=1)
                time.sleep(latch_settle_time)
                print(f"[JOINT {next_j_idx+1:02d}] Laser Scan Complete! Gripper unlatched.")
                joint_scanned[next_j_idx] = True
                continue

            # ゴール完了判定 (全ジョイントスキャン完了かつ60m到達)
            if pos_x >= 59.8 and all(joint_scanned):
                elapsed = time.time() - start_time
                print(f"\n============================================================")
                print(f"🏁 [MISSION COMPLETE] ISS Truss Survey Complete! (Distance: {pos_x:.2f}m)")
                print(f"⏱️ Clear Time: {elapsed:.2f}s | 🔋 Battery Left: {fuel:.1f}%")

                time.sleep(0.15)
                print("\n======================================================================")
                print("      STAGE 3 CLEAR - OFFICIAL REFEREE EVALUATION (DAEMON SSOT)       ")
                print("======================================================================")
                print(f"  Inspection Time      : {elapsed:.2f} s")
                print(f"  Remaining Battery    : {fuel:.1f}%")
                if os.path.exists("/tmp/space_guidance_telemetry.json"):
                    try:
                        with open("/tmp/space_guidance_telemetry.json", "r") as jf:
                            t = json.load(jf)
                        print(f"  Official Score       : {t.get('score', 0):,} pts")
                        print(f"  Joints Score         : {t.get('checkpoint_score', 0):,} pts")
                        print(f"  Bonus Score          : {t.get('bonus_score', 0):,} pts")
                        print(f"  Joints Inspected     : {t.get('passed_checkpoints', 0)} / {t.get('total_checkpoints', 4)}")
                        print(f"  Official Grade       : {t.get('official_grade', 'N/A')}")
                        print(f"  Referee Event        : {t.get('last_event', '')}")
                    except Exception as e:
                        print(f"  Telemetry Read Err   : {e}")
                print("======================================================================\n")
                break
                break

            # 進捗ログ表示 (5m毎)
            if pos_x - last_print_dist >= 5.0:
                last_print_dist = pos_x
                print(f"[PROGRESS] Pos: {pos_x:5.1f}m / 60m | Vel: {vel_x:4.2f}m/s | Load: {rail_load:5.1f}N | Battery: {fuel:4.1f}%")

            # 速度計画
            in_corner = (18.5 < pos_x < 24.5) or (38.5 < pos_x < 44.5)

            if next_j_idx != -1 and 0.0 < dist_to_next <= 5.0:
                desired_v = max(0.15, dist_to_next * 0.35)
            elif in_corner:
                desired_v = corner_velocity
            else:
                desired_v = target_velocity

            drive_cmd = max(-1.0, min(1.0, (desired_v - vel_x) * kp_drive))
            hw.write_commands(thrust_x=drive_cmd, thrust_y=0.0, torque=0.0)
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
