#!/usr/bin/env python3
# ==============================================================================
# SpaceGuidance-FBB: Stage 1 Asteroid Pipeline Inspector (Baseline Starter)
# ==============================================================================
# このスクリプトは、Stage 1 の小惑星パイプラインを自律飛行するお手本サンプルです。
# 本機体は以下のハイブリッド姿勢制御アクチュエータを備えています：
#   1. リアクションホイール (Reaction Wheel: RW): 電気駆動・燃料消費ゼロの精密姿勢制御
#   2. RCS 姿勢制御スラスタ (Reaction Control System): 高トルク旋回・ホイール脱飽和 (アンローディング)
#
# 【プレイヤーへの挑戦課題 (Tuning Challenges)】:
#   1. TUNE ZONE 1: 微分ゲイン kd を追加して蛇行（ふらつき）をゼロに抑える！
#   2. TUNE ZONE 2: リアクションホイールを活用して推進剤（燃料）消費を極限までゼロに抑える！
#   3. TUNE ZONE 3: ホイール飽和 (6000 RPM) 時の RCS 脱飽和 (アンローディング) シーケンスを設計する！
# ==============================================================================

import sys
import os
import time
import math

# UIO ハードウェアインターフェースのインポート
# Hardware interface path resolution (handles execution from scenario/ or plugin root)
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "..", "ros2", "nodes")))
sys.path.append(os.path.abspath(os.path.join(script_dir, "..", "ros2", "nodes")))
from guidance_controller import SpaceGuidanceHardware

class UartTee:
    """Terminal (stdout) と F-BB 仮想 UART (/dev/ttyPS1) へログを複製出力するハンドラ"""
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
                # \r\n を単一の \n に正規化（PTY 側での二重改行 \n\n を防止）
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
    print("[Pilot] Space Guidance System Online. Engaging Stage 1 Autopilot...")
    print("[Pilot] 9 Checkpoint Gates active along 50m asteroid pipeline corridor.")
    print("[Pilot] Actuators Active: Dual Main Engines + 8ch RCS Thrusters + Internal Reaction Wheel.\n")

    # 制御周期: 50Hz (20ms)
    dt = 0.02
    prev_error = 0.0
    start_time = time.time()

    # === TUNE ZONE 1: 制御ゲインのチューニング ===
    kp = 0.90    # 旋回比例ゲイン
    kd = 0.15    # 旋回微分ゲイン
    kw = 0.65    # ジャイロ角速度ダンピング
    klat = 0.80  # 横移動 RCS 追従ゲイン
    kvlat = 0.60 # 横滑り速度ダンピング (無重力・無摩擦空間の横揺れ抑制)

    # === TUNE ZONE 2: 巡航速度の設定 ===
    target_vx = 1.2  # 目標巡航速度 (m/s)

    # チェックポイント（枠）定義: 全長50m中に 5m 刻みで計9箇所配置
    gate_x_list = [5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0]
    passed_gates = set()
    stats = {"perfect": 0, "great": 0, "good": 0, "clip": 0, "miss": 0}
    total_gate_score = 0
    desat_count = 0
    in_desat = False

    try:
        while True:
            # 1. ハードウェアから現在のテレメトリを読み出し
            tlm = hw.read_registers()
            hw.kick_watchdog() # ハードウェア安全停止（E-STOP）を防ぐために定期キック

            pos_x = tlm["pos_x"]
            pos_y = tlm["pos_y"]
            vel_x = tlm["vel_x"]
            vel_y = tlm["vel_y"]
            angle = tlm["angle"]
            omega = tlm["omega"]
            fuel = tlm["fuel"]
            wheel_rpm = tlm["wheel_rpm"]
            carrier_lost = (tlm["sr_status"] & 0x08) != 0 # 通信途絶フラグ

            # 2. センサエッジ（ライン重心位置）の取得とロバスト処理
            sensor_raw = tlm["sensor_raw"]
            if sensor_raw != 0:
                raw_edge = tlm["sensor_edge"]
                if raw_edge >= 0x80000000:
                    raw_edge -= 0x100000000
                error = raw_edge / 65536.0 # RTL幾何重心偏差 (-3.5 ~ +3.5)
                d_error = (error - prev_error) / dt
                prev_error = error
            else:
                error = 0.0
                d_error = 0.0
                prev_error = 0.0

            # 3. 各チェックポイント（枠）の通過判定とスコア計測
            for gate_x in gate_x_list:
                if gate_x not in passed_gates and pos_x >= gate_x:
                    passed_gates.add(gate_x)
                    gate_idx = int(gate_x / 5.0)

                    # パイプライン中心線からの物理横ズレ量 (m)
                    dev_m = tlm["cross_track_err"]
                    dev_cm = dev_m * 100.0

                    # 枠サイズ: 機体幅0.4mの2倍（内径0.8m, 半径R=0.40m, 機体半幅r=0.20m）
                    if dev_m <= 0.05:
                        pts = 1000
                        rating = "PASS [PERFECT]"
                        stats["perfect"] += 1
                    elif dev_m <= 0.12:
                        pts = 800
                        rating = "PASS [GREAT]  "
                        stats["great"] += 1
                    elif dev_m <= 0.20:
                        pts = 500
                        rating = "PASS [GOOD]   "
                        stats["good"] += 1
                    elif dev_m <= 0.40:
                        pts = -300
                        rating = "CLIP [PENALTY]"
                        stats["clip"] += 1
                    else:
                        pts = -1000
                        rating = "GATE [MISSED] "
                        stats["miss"] += 1

                    total_gate_score += pts
                    sign = "+" if pts >= 0 else ""
                    print(f"[GATE {gate_idx:02d}] X={gate_x:4.1f}m | Dev: {dev_m:5.2f}m ({dev_cm:5.1f}cm) | RW: {wheel_rpm:5.0f} RPM | {rating} {sign}{pts:5d} pts | Total: {total_gate_score:5d} pts")

            # 4. ゴール到達判定 (Stage 1 は 50m パイプライン)
            if pos_x >= 48.0:
                elapsed = time.time() - start_time
                fuel_bonus = int(fuel * 10.0)
                time_bonus = max(0, int((50.0 - elapsed) * 40.0))
                final_score = total_gate_score + fuel_bonus + time_bonus

                if final_score >= 8000 and stats["miss"] == 0 and stats["clip"] == 0:
                    grade = "S"
                elif final_score >= 6500 and stats["miss"] == 0:
                    grade = "A"
                elif final_score >= 4500:
                    grade = "B"
                else:
                    grade = "C"

                print("\n======================================================================")
                print(" [MISSION ACCOMPLISHED: STAGE 1 ASTEROID PIPELINE EVALUATION]")
                print("======================================================================")
                print(f"  Clear Time       : {elapsed:.2f} s")
                print(f"  Remaining Fuel   : {fuel:.1f}%")
                print(f"  Flywheel RPM     : {wheel_rpm:.0f} RPM (Limit: 6,000 RPM)")
                print(f"  Gate Clearance   : {len(passed_gates)} / {len(gate_x_list)} Gates")
                print(f"  Gate Breakdown   : Perfect: {stats['perfect']}, Great: {stats['great']}, Good: {stats['good']}, Clip: {stats['clip']}, Miss: {stats['miss']}")
                print(f"  Gate Total Score : {total_gate_score:,} pts")
                print(f"  Fuel Bonus       : {fuel_bonus:,} pts (Fuel% x 10)")
                print(f"  Time Bonus       : {time_bonus:,} pts")
                print(f"  FINAL SCORE      : {final_score:,} pts")
                print(f"  FLIGHT RANK      : GRADE {grade}")
                print("======================================================================\n")
                break

            # 5. カオス障害（通信途絶）のハンドリング
            fdir_mode = 0 # 0: Nominal
            if carrier_lost:
                fdir_mode = 1 # 1: LOS / Recovery

            # 6. 機体座標系 (Body Frame) 速度成分の計算
            cos_a = math.cos(angle)
            sin_a = math.sin(angle)
            v_lat = -vel_x * sin_a + vel_y * cos_a # 機体左右横滑り速度
            v_fwd =  vel_x * cos_a + vel_y * sin_a # 機体進行方向速度

            # 7. PD 姿勢制御指令値
            target_torque = +(kp * error + kd * d_error) - (kw * omega)

            # 8. ハイブリッド姿勢制御 (リアクションホイール優先 + RCS脱飽和アンローディング)
            # リアクションホイールは電気駆動で推進剤消費ゼロ！
            # 8. ハイブリッド姿勢制御 (リアクションホイール優先 + RCS脱飽和アンローディング)
            # リアクションホイールは電気駆動で推進剤消費ゼロ！
            # 作用・反作用: 機体に+トルクを加えるには、ホイールに-トルクを印加 (tau_body = -tau_wheel)
            # ヒステリシス脱飽和シーケンス: 5200 RPM以上で脱飽和開始、1800 RPM以下で通常復帰
            if in_desat:
                if abs(wheel_rpm) < 1800.0:
                    in_desat = False
            else:
                if abs(wheel_rpm) > 5200.0:
                    in_desat = True

            if not in_desat:
                # 正常域: リアクションホイールが姿勢制御を100%担当。RCS姿勢スラスタは完全停止！
                wheel_torque_cmd = -target_torque
                rcs_torque_cmd = 0.0
            else:
                # 【宇宙工学アンローディング(脱飽和)シーケンス】:
                # RCSスラスタが機体姿勢の維持を肩代わりしつつ、ホイールに逆向きの制動トルクをかけて減速
                desat_count += 1
                # ホイール回転数と逆向きのブレーキトルクを印加してゼロへ引き戻す
                wheel_brake = -0.15 if wheel_rpm > 0 else +0.15
                wheel_torque_cmd = wheel_brake
                rcs_torque_cmd = target_torque + wheel_brake

            # 9. 横移動 (ラテラル) RCS スラスタ (ライン追従 + 横滑りダンピング)
            # 微小なノイズによるスラスタ過剰噴射（ふかしすぎ）を防ぐため、不感帯（デッドバンド 6cm）を設定
            lat_cmd = +(klat * error) - (kvlat * v_lat)
            lat_thrust = lat_cmd if abs(error) > 0.03 else 0.0

            # 10. 進行方向の速度レギュレータ
            thrust_x = max(-0.20, min(0.25, 0.20 * (target_vx - v_fwd)))

            # 11. ハードウェアへ推進コマンドを出力
            hw.write_commands(
                thrust_x=thrust_x,
                thrust_y=lat_thrust,
                torque=rcs_torque_cmd,
                wheel_torque=wheel_torque_cmd,
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
        sys.stdout = sys.__stdout__

if __name__ == "__main__":
    run_pilot()
