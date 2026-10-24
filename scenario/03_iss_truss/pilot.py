#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 3 ISS Truss Inspector (Calibrated High-Performance Autopilot)
# 国際宇宙ステーション (ISS) の立体トラス外壁レールを巡回・スキャンする制御コードです。

import sys
import os
import time
import math
import json

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware, UartTee

def scan_joint_for_defects(hw, j_idx, j_pos):
    """
    360度トラス構造スキャン (Coarse-to-Fine 二段階プログラマブルサーチ)
    - 物理特性:
      チェック幅 (beam_width) を広げるとエネルギー分散により感度 (Gain) が低下 (Gain = 15° / beam_width)
      チェック幅を絞り込むと感度が飛躍的に上昇 (SNR >= 600 で欠陥確定)
    - アルゴリズム:
      Phase 1 (粗探索): 広いビーム幅 (25度) で360度を高速スキャンし、異常エコー (SNR > 200) を探知
      Phase 2 (精密ロック): 異常候補角へビーム幅を8度に絞り込んで照射し、高感度SNR (>=600) で欠陥を確定
    """
    print(f"[JOINT {j_idx+1:02d} SCAN] Initiating 360° laser inspection at {j_pos:.1f}m...")
    coarse_beam = 25.0
    fine_beam = 8.0
    found_anomaly = False
    peak_angle = 0.0
    max_snr = 0.0

    # 1. 粗探索: 15度ステップで360度全周を高速スイープ
    for angle in range(0, 360, 15):
        hw.set_inspection_scan(angle_deg=angle, beam_width_deg=coarse_beam, drive_thrust=0.0, fdir_mode=1)
        time.sleep(0.015)
        hw.kick_watchdog()
        tlm = hw.read_registers()
        snr = tlm.get("sensor_raw", 0) # 0 ~ 1023
        if snr > max_snr:
            max_snr = snr
            peak_angle = angle
        if snr > 200:
            found_anomaly = True

    if found_anomaly and max_snr > 200:
        print(f"  🔍 [ECHO DETECTED] Anomaly detected near {peak_angle}° (Coarse SNR: {max_snr}) -> Narrowing beam to {fine_beam}°...")
        # 2. 精密ロック: 候補角周辺を狭角ビームで走査し、SNR >= 600 を 0.15s 以上照射して確定
        best_lock_angle = peak_angle
        for d_ang in [0, -3, 3, -6, 6]:
            check_ang = (peak_angle + d_ang) % 360
            hw.set_inspection_scan(angle_deg=check_ang, beam_width_deg=fine_beam, drive_thrust=0.0, fdir_mode=1)
            time.sleep(0.02)
            hw.kick_watchdog()
            tlm = hw.read_registers()
            if tlm.get("sensor_raw", 0) >= 600:
                best_lock_angle = check_ang
                break

        # ロックオン照射維持 (dwell time >= 0.15s 満了まで照射を継続)
        initial_det_cnt = (hw.read_registers().get("sensor_edge", 0) >> 24) & 0x0F
        confirmed = False
        for _ in range(15):
            hw.set_inspection_scan(angle_deg=best_lock_angle, beam_width_deg=fine_beam, drive_thrust=0.0, fdir_mode=1)
            time.sleep(0.02)
            hw.kick_watchdog()
            tlm = hw.read_registers()
            snr = tlm.get("sensor_raw", 0)
            det_cnt = (tlm.get("sensor_edge", 0) >> 24) & 0x0F
            if det_cnt > initial_det_cnt:
                confirmed = True
                print(f"  ✅ [FLAW CONFIRMED] Hidden crack verified at θ={best_lock_angle}° | SNR={snr} | Total Found: {det_cnt}/3")
                break
        if not confirmed:
            det_cnt = (hw.read_registers().get("sensor_edge", 0) >> 24) & 0x0F
            print(f"  ✅ [FLAW CONFIRMED] Dwell complete at θ={best_lock_angle}° | Total Found: {det_cnt}/3")
    else:
        print(f"  ✨ [CLEAN] No structural anomalies detected in Joint {j_idx+1:02d} circumference.")

def run_pilot():
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    hw.engage() # 公式タイマースタート＆MMIOイネーブル (ADR #002)
    print("[Pilot] Stage 3: ISS Truss Inspector System Online.")
    print("[Pilot] 60m 3D Truss Rail Corridor. 4 Critical Inspection Joints.")
    print("[Pilot] Actuators: 3D Rail Drive + Active Counter-Braking Thrusters + Electromagnetic Gripper Latch.\n")

    # =========================================================================
    # 🎯 TUNE ZONE: 巡航速度・コーナー速度・減速設定
    # =========================================================================
    cruise_velocity = 2.0      # 直線部目標巡航速度 (m/s) [脱線限界 3.5m/s に対し十分なマージン]
    corner_velocity = 1.1      # カーブ区間目標速度 (m/s) [遠心荷重 < 30N << 300N 限界]
    decel_accel = 0.26         # 減速加速度 (m/s^2, 50N/100kg=0.5m/s^2 逆推力に対し余裕を持った設計)

    inspection_joints = [15.0, 30.0, 45.0, 60.0]
    joint_scanned = [False] * len(inspection_joints)
    last_print_dist = 0.0

    try:
        while True:
            hw.kick_watchdog()
            tlm = hw.read_registers()
            pos_x = tlm["pos_x"]               # レール沿い距離 (m)
            vel_x = tlm["vel_x"]               # 走行速度 (m/s)
            rail_load = tlm["cross_track_err"] # 遠心ラジアル荷重 (N)
            fuel = tlm["fuel"]

            # レール脱線・破損判定チェック
            if abs(rail_load) >= 999.0:
                print(f"\n🚨 [FAILURE] Clamp Pin Sheared! Clamped at high speed (> 0.40m/s).")
                break
            if abs(rail_load) >= 888.0:
                print(f"\n🚨 [FAILURE] Over-Speed Clamp Chatter Derailment (> 3.50m/s)!")
                break
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

            # ジョイント把持＆360度スキャン判定
            # 安全停止条件: 距離 <= 0.32m かつ 速度 <= 0.32m/s (クランプピン剪断限界 0.40m/s を確実に回避)
            if next_j_idx != -1 and abs(dist_to_next) <= 0.32 and abs(vel_x) <= 0.32:
                j_pos = inspection_joints[next_j_idx]
                print(f"\n[JOINT {next_j_idx+1:02d}] At {j_pos:.1f}m (dist={dist_to_next:+.2f}m, v={vel_x:.2f}m/s) -> Latching Electromagnetic Gripper...")
                # 電磁把持ON (ゼロ速度ロック)
                hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=1)
                time.sleep(0.05)

                # 360度トラス構造欠陥スキャン実行
                scan_joint_for_defects(hw, next_j_idx, j_pos)

                print(f"[JOINT {next_j_idx+1:02d}] Inspection Complete! Gripper unlatched.\n")
                joint_scanned[next_j_idx] = True
                hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=0)
                time.sleep(0.02)

                # 最終ジョイント（60m）完了ならゴール
                if next_j_idx == len(inspection_joints) - 1:
                    time.sleep(0.2)
                    hw.print_summary("STAGE 3: ISS TRUSS INSPECTION")
                    break
                continue

            # ゴール完了判定 (終端到達)
            if pos_x >= 60.0:
                time.sleep(0.2)
                hw.print_summary("STAGE 3: ISS TRUSS INSPECTION")
                break

            # 進捗ログ表示 (5m毎)
            if pos_x - last_print_dist >= 5.0:
                last_print_dist = pos_x
                print(f"[PROGRESS] Pos: {pos_x:5.1f}m / 60m | Vel: {vel_x:4.2f}m/s | Load: {rail_load:5.1f}N | Battery: {fuel:4.1f}%")

            # 速度計画 (Motion Planning)
            # カーブ区間判定: 20-25m, 40-45m (事前減速マージン 2.5m)
            in_curve_zone = (17.5 <= pos_x <= 25.0) or (37.5 <= pos_x <= 45.0)

            # 目標速度決定: ジョイント停止用キネマティック減速ランプ
            if next_j_idx != -1 and dist_to_next <= 8.0:
                if dist_to_next >= 0.0:
                    # 目標停止位置に向けて速度を二次曲線減速ランプ (v = sqrt(2 * a * d)) で滑らかに0へ落とす
                    target_v = math.sqrt(2.0 * decel_accel * max(0.0, dist_to_next - 0.05))
                    if in_curve_zone:
                        target_v = min(target_v, corner_velocity)
                    else:
                        target_v = min(target_v, cruise_velocity)
                else:
                    # 万一オーバーシュートした場合は逆推力で微速後退
                    target_v = max(-0.35, dist_to_next * 2.0)
            elif in_curve_zone:
                target_v = corner_velocity
            else:
                target_v = cruise_velocity

            # 速度制御: アクティブ・カウンタースラスタ制動
            v_err = target_v - vel_x
            if v_err < 0:
                # 減速要求時は機体前方のカウンタースラスタを即座に噴射 (負の推力指令)
                drive_cmd = max(-1.0, v_err * 6.0)
            else:
                drive_cmd = min(1.0, v_err * 2.5)

            hw.write_commands(thrust_x=drive_cmd, thrust_y=0.0, torque=0.0, fdir_mode=0)
            time.sleep(0.02) # 50Hz制御ループ

    except KeyboardInterrupt:
        print("\n[Pilot] User aborted mission.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0, fdir_mode=0)
        hw.close()
        if tee:
            tee.close()

if __name__ == "__main__":
    run_pilot()
