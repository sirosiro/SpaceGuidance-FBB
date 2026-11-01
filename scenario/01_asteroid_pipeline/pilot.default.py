#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage 1 Asteroid Pipeline Inspector (3D Bank-to-Translate)
# ==============================================================================
# このスクリプトは、Stage 1 の小惑星パイプラインを自律飛行するお手本サンプルです。
# 本機体は以下のハイブリッド姿勢制御アクチュエータを備えています：
#   1. リアクションホイール (Reaction Wheel: RW): 電気駆動・燃料消費ゼロの精密姿勢制御
#   2. RCS 姿勢制御スラスタ (Reaction Control System): 高トルク旋回・ホイール脱飽和 (アンローディング)
#   3. 3D Bank-to-Translate 制御: ロールバンク角 (φ = ±31.0°) と横移動スラスタ (Fy) の
#      連動による 3D 空間機動（全9ゲート完全クリア）
#
# 【プレイヤーへの挑戦課題 (Tuning Challenges)】:
#   1. TUNE ZONE 1: 微分ゲイン kd を追加して蛇行（ふらつき）をゼロに抑える！
#   2. TUNE ZONE 2: リアクションホイールを活用して推進剤（燃料）消費を極限までゼロに抑える！
#   3. TUNE ZONE 3: 3D向心力フィードフォワードと先行バンキングによる全ゲート PERFECT 通過！
#   ※ 制御ループの全体論理フロー図は README.md (Section 3.4) を参照してください。
# ==============================================================================

import sys
import os
import time
import math
import json

# UIO ハードウェアインターフェースのインポート
# Hardware interface path resolution (handles execution from scenario/ or plugin root)
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware, UartTee

def run_pilot():
    # 実機互換テレメトリ出力: ターミナル画面と Zynq PS UART1 (/dev/ttyPS1) へ同時複製配信
    tee = UartTee("/dev/ttyPS1")
    hw = SpaceGuidanceHardware()
    print("[Pilot] Space Guidance System Online. Engaging Stage 1 Autopilot...")
    print("[Pilot] 9 Checkpoint Gates active along 50m asteroid corridor.")
    print("[Pilot] Actuators Active: Dual Main Engines + 8ch RCS Thrusters + Internal Reaction Wheel.\n")

    # 制御周期: 50Hz (20ms)
    dt = 0.02
    prev_error = 0.0

    # === TUNE ZONE 1: 制御ゲインのチューニング (3D Bank-to-Translate 最適化) ===
    kp = 1.20      # 機首方位 (Yaw) 安定化比例ゲイン
    kd = 0.60      # 機首方位 (Yaw) 角速度ダンピング
    kp_roll = 2.80 # 3D ロールバンク比例ゲイン (Ix = 15.0 kg*m^2)
    kd_roll = 3.20 # 3D ロール角速度ダンピング (臨界減衰)
    klat = 1.40    # 横移動 RCS 追従ゲイン
    kvlat = 2.80   # 3D 軌道相対横滑りダンピング

    # === TUNE ZONE 2: 巡航速度の設定 ===
    target_vx = 1.15  # 目標巡航速度 (m/s)

    # === 3D 起伏回廊バンク角スケジューラ (先行プリバンキング付き) ===
    # 機体のロール慣性 (Ix=15 kg*m^2) に対応するため、直線区間から先行してバンクを開始
    def calc_target_bank(x):
        BANK_MAX = 0.5404 # 31.0° (arctan(1.5m / 2.5m))
        if x < 5.2:
            return 0.0
        elif x < 9.0:
            # ゲート01通過直後から第1カーブ突入前に向け先行バンキング
            t = (x - 5.2) / 3.8
            return BANK_MAX * math.sin(t * math.pi * 0.5)
        elif x < 19.5:
            return BANK_MAX
        elif x < 24.5:
            # ゲート04通過後からゲート05に向けスムーズにバンク反転 (31° -> -31°)
            t = (x - 19.5) / 5.0
            return BANK_MAX * math.cos(t * math.pi)
        elif x < 35.0:
            return -BANK_MAX
        elif x < 39.5:
            # ゲート07通過後、ゲート08に向けて水平姿勢へ復帰
            t = (x - 35.0) / 4.5
            return -BANK_MAX * math.cos(t * math.pi * 0.5)
        else:
            return 0.0

    # === ミッションブリーフィング情報（事前飛行計画 / パイロットのウェイポイント記憶） ===
    # パイロットがあらかじめブリーフィングで把握しているコース情報（50m 中の 5m 刻みゲート位置）。
    gate_x_list = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0]
    passed_gates = set()

    # 脱飽和ステータス管理
    in_desat = False
    desat_count = 0

    try:
        while True:
            # 1. テレメトリの取得
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
            roll = tlm.get("roll", 0.0)
            omega_x = tlm.get("omega_x", 0.0)
            fuel = tlm["fuel"]
            wheel_rpm = tlm["wheel_rpm"]
            cross_track_err = tlm["cross_track_err"]
            dev = abs(cross_track_err)
            carrier_lost = (tlm["sr_status"] & 0x08) != 0 # 通信途絶フラグ

            # 2. センサエッジ（ライン重心位置）の取得とロバストFDIR処理
            nom_y = 0.0
            nom_z = 0.0
            v_lat_nom = 0.0
            v_z_nom = 0.0
            ff_ay = 0.0
            ff_az = 0.0
            k_w = math.pi / 15.0
            if 10.0 <= pos_x <= 25.0:
                ph = (pos_x - 10.0) * k_w
                nom_y = 2.5 * math.sin(ph)
                nom_z = 1.5 * math.sin(ph)
                v_lat_nom = 2.5 * k_w * math.cos(ph) * vel_x
                v_z_nom = 1.5 * k_w * math.cos(ph) * vel_x
                ff_ay = -2.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
                ff_az = -1.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
            elif 25.0 < pos_x <= 40.0:
                ph = (pos_x - 25.0) * k_w
                nom_y = -2.5 * math.sin(ph)
                nom_z = 1.5 * math.sin(ph)
                v_lat_nom = -2.5 * k_w * math.cos(ph) * vel_x
                v_z_nom = 1.5 * k_w * math.cos(ph) * vel_x
                ff_ay = +2.5 * (k_w**2) * math.sin(ph) * (vel_x**2)
                ff_az = -1.5 * (k_w**2) * math.sin(ph) * (vel_x**2)

            sensor_raw = tlm["sensor_raw"]
            if sensor_raw != 0:
                raw_edge = tlm["sensor_edge"]
                if raw_edge >= 0x80000000:
                    raw_edge -= 0x100000000
                error = raw_edge / 65536.0
                prev_error = error
            else:
                dy = pos_y - nom_y
                dz = pos_z - nom_z
                error = - (dy * math.cos(roll) + dz * math.sin(roll))
                prev_error = error

            # 3. 機上ナビゲーション（オンボード航法によるゲート接近・通過把握）
            for gate_x in gate_x_list:
                if gate_x not in passed_gates and pos_x >= gate_x:
                    passed_gates.add(gate_x)
                    gate_idx = int(gate_x / 5.0)
                    dev_m = abs(cross_track_err)
                    print(f"[NAV GATE {gate_idx:02d}] Reached X={gate_x:4.1f}m | Dev: {dev_m*100:4.1f}cm | Bank: {roll*180/math.pi:+5.1f}° | RW-Z: {wheel_rpm:5.0f} RPM")

            # 4. ゴール到達判定 (Stage 1 は 50m パイプライン)
            if pos_x >= 49.0:
                time.sleep(0.15)
                hw.print_summary("STAGE 1: ASTEROID PIPELINE")
                break

            # 5. カオス障害（通信途絶）のハンドリング
            fdir_mode = 0 # 0: Nominal
            if carrier_lost:
                fdir_mode = 1 # 1: LOS / Recovery

            # 6. 機体姿勢・3D起伏回廊の先読みとバンク角目標の計算 (Bank-to-Translate)
            lookahead_x = pos_x + max(0.4, vel_x * 0.6)
            target_bank = calc_target_bank(lookahead_x)

            # ロールPD姿勢制御 (電気駆動ロールリアクションホイール)
            roll_err = target_bank - roll
            target_torque_x = (kp_roll * roll_err) - (kd_roll * omega_x)
            wheel_torque_x = -target_torque_x

            # 7. 機体座標系 (Body Frame) 速度成分の計算
            cos_a = math.cos(angle)
            sin_a = math.sin(angle)
            v_lat = -vel_x * sin_a + vel_y * cos_a # 機体左右横滑り速度
            v_fwd =  vel_x * cos_a + vel_y * sin_a # 機体進行方向速度

            # 8. 機首方位 (Yaw) 安定化制御
            target_torque = -(kp * angle + kd * omega)

            # 9. ハイブリッド姿勢制御 (リアクションホイール優先 + RCS脱飽和アンローディング)
            if in_desat:
                if abs(wheel_rpm) < 1800.0:
                    in_desat = False
            else:
                if abs(wheel_rpm) > 5200.0:
                    in_desat = True

            if not in_desat:
                wheel_torque_cmd = -target_torque
                rcs_torque_cmd = 0.0
            else:
                desat_count += 1
                wheel_brake = -0.15 if wheel_rpm > 0 else +0.15
                wheel_torque_cmd = wheel_brake
                rcs_torque_cmd = target_torque + wheel_brake

            # 10. 3D Bank-to-Translate 向心力フィードフォワード + 横移動スラスタ
            cos_p = math.cos(roll)
            sin_p = math.sin(roll)
            ff_thrust_lat = (100.0 * (ff_ay * cos_p + ff_az * sin_p)) / 50.0

            lat_cmd = ff_thrust_lat + (klat * error) - kvlat * (v_lat - v_lat_nom)
            lat_thrust = max(-1.0, min(1.0, lat_cmd))

            # 垂直 RCS サーボトリム (高度補正)
            z_err = nom_z - pos_z
            ff_thrust_vert = (100.0 * (-ff_ay * sin_p + ff_az * cos_p)) / 50.0
            vert_cmd = ff_thrust_vert + 2.50 * z_err - 2.50 * (vel_z - v_z_nom)
            vert_thrust = max(-1.0, min(1.0, vert_cmd))

            # 11. 進行方向の速度レギュレータ
            thrust_x = max(-0.25, min(0.35, 0.35 * (target_vx - v_fwd)))

            # 12. ハードウェアへ推進コマンドを出力 (3D Bank-to-Translate)
            hw.write_commands(
                thrust_x=thrust_x,
                thrust_y=lat_thrust,
                torque=rcs_torque_cmd,
                wheel_torque=wheel_torque_cmd,
                wheel_torque_x=wheel_torque_x,
                thrust_vertical=vert_thrust,
                fdir_mode=fdir_mode
            )

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
