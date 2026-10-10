#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage 1 Asteroid Pipeline Inspector (Baseline Starter)
# ==============================================================================
# このスクリプトは、Stage 1 の小惑星パイプラインを自律走行するお手本サンプルです。
# 初期状態でもゆっくり完走できますが、P制御のみのため蛇行し、推進剤消費は Grade C です。
#
# 【プレイヤーへの挑戦課題 (Tuning Challenges)】:
#   1. TUNE ZONE 1: 微分ゲイン kd を追加して蛇行（ふらつき）をゼロに抑える！
#   2. TUNE ZONE 2: 直線区間で前進推力をブーストし、クリアタイムを短縮する！
#   3. TUNE ZONE 3: 通信途絶（カオス LOS）時に逆噴射ホバリングで踏みとどまる！
# ==============================================================================

import sys
import os
import time

# UIO ハードウェアインターフェースのインポート
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "ros2", "nodes"))
from guidance_controller import SpaceGuidanceHardware

def run_pilot():
    hw = SpaceGuidanceHardware()
    print("[Pilot] Space Guidance System Online. Engaging Stage 1 Autopilot...")

    # 制御周期: 50Hz (20ms)
    dt = 0.02
    prev_error = 0.0
    start_time = time.time()

    # === TUNE ZONE 1: 制御ゲインのチューニング ===
    # ヒント: kp=0.6 だけだと機体が行き過ぎて蛇行します。kd を 0.12 付近に設定してみよう！
    kp = 0.6
    kd = 0.0  # <--- 初心者チューニングポイント: 0.12 に変更してみよう！

    # === TUNE ZONE 2: 巡航速度の設定 ===
    # ヒント: target_thrust_x を上げると速くなりますが、カーブで曲がりきれなくなるリスクがあります！
    forward_thrust = 0.4 # 前進推力 (0.1 ~ 1.0)

    try:
        while True:
            # 1. ハードウェアから現在のテレメトリを読み出し
            tlm = hw.read_registers()
            hw.kick_watchdog() # ハードウェア安全停止（E-STOP）を防ぐために定期キック

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]
            fuel = tlm["fuel"]
            carrier_lost = (tlm["sr_status"] & 0x08) != 0 # 通信途絶フラグ

            # ゴール判定 (Stage 1 は 50m パイプライン)
            if pos_x >= 48.0:
                elapsed = time.time() - start_time
                print(f"\n[MISSION ACCOMPLISHED!] Goal Reached!")
                print(f"  Clear Time: {elapsed:.2f} s")
                print(f"  Remaining Fuel: {fuel:.1f}%")
                grade = "A" if (kd > 0.05 and fuel > 80.0) else "C"
                print(f"  Flight Evaluation: GRADE {grade}")
                break

            # 2. センサエッジ（ライン重心位置）の取得 (-1.0: 左偏り, 0.0: 中央, +1.0: 右偏り)
            raw_edge = tlm["sensor_edge"]
            # 符号付き 32bit へ変換
            if raw_edge >= 0x80000000:
                raw_edge -= 0x100000000
            error = raw_edge / 65536.0

            # 3. カオス障害（通信途絶）のハンドリング
            fdir_mode = 0 # 0: Nominal
            if carrier_lost:
                fdir_mode = 1 # 1: LOS / Recovery
                # === TUNE ZONE 3: 通信途絶時のフェイルセーフ ===
                # 通信が切れたら逆噴射で急制動して踏みとどまる！
                # hw.write_commands(thrust_x=-0.5, thrust_y=0.0, torque=0.0, fdir_mode=fdir_mode)
                pass

            # 4. PD ライントレース姿勢制御計算
            d_error = (error - prev_error) / dt
            prev_error = error

            # 旋回トルク指令値の計算
            torque_cmd = -(kp * error + kd * d_error)

            # 5. ハードウェアへ推進コマンドを出力
            hw.write_commands(thrust_x=forward_thrust, thrust_y=0.0, torque=torque_cmd, fdir_mode=fdir_mode)

            # 進行状況の表示
            if int(pos_x) % 5 == 0 and int(pos_x) > 0:
                print(f"Progress: {pos_x:.1f}m / 50m | Deviation: {tlm['cross_track_err']:.2f}m | Fuel: {fuel:.1f}%")

            time.sleep(dt)

    except KeyboardInterrupt:
        print("\n[Pilot] Manual abort.")
    finally:
        hw.write_commands(0.0, 0.0, 0.0)
        hw.close()

if __name__ == "__main__":
    run_pilot()
