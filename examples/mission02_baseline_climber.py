#!/usr/bin/env python3
# SpaceGuidance-FBB: Stage 2 Orbital Tether Climber (Baseline Starter)
# このスクリプトは、Stage 2 の軌道エレベータ・テザーを昇降するお手本サンプルです。

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
    print("[Pilot] Stage 2: Orbital Tether Climber System Online.")
    print("[Pilot] 100m Carbon Nanotube Cable active. Destination: GEO Orbital Dock.")
    print("[Pilot] Drive Actuators: Dual Pinch Motor Drive + Resonance Notch Filter.\n")

    # =========================================================================
    # 🎯 TUNE ZONE 1: 目標昇降速度と加減速ゲイン
    # =========================================================================
    target_velocity = 2.2      # 目標登坂速度 (m/s)
    kp_speed = 0.85            # 速度追従比例ゲイン
    max_accel_step = 0.04      # S字加減速ジャーク制限 (1ステップあたりの最大推力変化量)

    # =========================================================================
    # ⚡ TUNE ZONE 2: テザー振動アクティブ抑制ゲイン
    # =========================================================================
    kvib_damping = 0.40        # テザー横振動速度ダンピング (弦の共振波抑制)

    # ビーコン通過判定用
    beacon_spacing = 10.0
    total_beacons = 9
    checked_beacons = [False] * total_beacons
    start_time = time.time()
    current_drive_cmd = 0.0

    try:
        while True:
            # 1. ハードウェアウォッチドッグキック
            hw.kick_watchdog()

            # 2. テレメトリ読み出し
            tlm = hw.read_registers()
            altitude = tlm["pos_x"]          # テザー登坂高度 (m)
            velocity = tlm["vel_x"]          # 登坂速度 (m/s)
            vibration = tlm["cross_track_err"]# ケーブル横振動変位 (m)
            tension = 10000.0 + (100.0 * max(0.0, velocity)) + (1200.0 * abs(vibration))
            fuel = tlm["fuel"]

            # 3. ケーブル断裂チェック
            if tension > 15000.0:
                print(f"\n🚨 [CABLE RUPTURE] Tension exceeded limit ({tension:.0f} N > 15000 N)! Mission Failed.")
                break

            # 4. ゴール到達判定 (100m GEO Dock)
            if altitude >= 100.0:
                elapsed = time.time() - start_time
                print(f"\n============================================================")
                print(f"🏁 [MISSION COMPLETE] Docked at GEO Orbital Platform! (Alt: {altitude:.2f}m)")
                print(f"⏱️ Clear Time: {elapsed:.2f}s | 🔋 Battery/Fuel Left: {fuel:.1f}%")

                time.sleep(0.15)
                print("\n======================================================================")
                print("      STAGE 2 CLEAR - OFFICIAL REFEREE EVALUATION (DAEMON SSOT)       ")
                print("======================================================================")
                print(f"  Climb Flight Time    : {elapsed:.2f} s")
                print(f"  Remaining Battery    : {fuel:.1f}%")
                print(f"  Cable Tension        : {tension:.0f} N (Limit: 15,000 N)")
                if os.path.exists("/tmp/space_guidance_telemetry.json"):
                    try:
                        with open("/tmp/space_guidance_telemetry.json", "r") as jf:
                            t = json.load(jf)
                        print(f"  Official Score       : {t.get('score', 0):,} pts")
                        print(f"  Beacon Score         : {t.get('checkpoint_score', 0):,} pts")
                        print(f"  Bonus Score          : {t.get('bonus_score', 0):,} pts")
                        print(f"  Beacons Reached      : {t.get('passed_checkpoints', 0)} / {t.get('total_checkpoints', 9)}")
                        print(f"  Official Grade       : {t.get('official_grade', 'N/A')}")
                        print(f"  Referee Event        : {t.get('last_event', '')}")
                    except Exception as e:
                        print(f"  Telemetry Read Err   : {e}")
                print("======================================================================\n")
                break
                break

            # 5. 10mおきのビーコン通過スコアリング
            for b_idx in range(total_beacons):
                target_alt = (b_idx + 1) * beacon_spacing
                if not checked_beacons[b_idx] and altitude >= target_alt:
                    checked_beacons[b_idx] = True
                    dev = abs(vibration)
                    print(f"[NAV BEACON {b_idx+1:02d}] Alt={target_alt:4.1f}m | Vib={dev*100:4.1f}cm | Tension={tension:5.0f}N")

            # 6. 昇降モータ制御 (S字ジャーク制限付き)
            target_force = (target_velocity - velocity) * kp_speed + 0.10
            target_force = max(-0.2, min(0.95, target_force))

            # ジャーク制限 (急激な推力変化をクランプして共振防止)
            delta = target_force - current_drive_cmd
            delta = max(-max_accel_step, min(max_accel_step, delta))
            current_drive_cmd += delta

            # 振動減衰補正 (逆位相微小ブレーキ)
            damped_drive = current_drive_cmd - (vibration * kvib_damping * 0.1)

            # 7. コマンド書き込み
            hw.write_commands(thrust_x=damped_drive, thrust_y=0.0, torque=0.0, wheel_torque=0.0)

            time.sleep(0.02) # 50Hz制御ループ

    except KeyboardInterrupt:
        print("\n[Pilot] User aborted mission.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0, 0.0)
        hw.close()
        if tee:
            tee.close()

if __name__ == "__main__":
    run_pilot()
