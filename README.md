# SpaceGuidance-FBB

Autonomous Space Guidance and Docking Challenge Plugin for FPGA-BoardlessBench (F-BB).

![SpaceGuidance for F-BB AroundView Dashboard](assets/dashboard.gif)

---

## 1. 概要 (Overview)
`SpaceGuidance-FBB` は、組み込み教育・競技の定番である「ライントレースロボット」を、完全無摩擦・微小重力の「宇宙空間軌道誘導（Space Guidance）」へと昇華させた、F-BB 向けの完全独立型ゲームプラグインです。

* **プレイスタイル**: ゆったり観戦・チューニング型（ゲームパッドや激しいキー操作は不要）。
* **100% Sim-to-Real 透明性**: Verilog RTL（AXI4-Lite MMIO `0x43C00000`）および Python 制御スクリプトは、実機 AMD Xilinx Zynq-7000 (Z-7010) / Kria KV260 にそのまま移植・動作可能。
* **カオス障害注入 & FDIR**: 宇宙放射線 SEU、通信途絶（LOS）、太陽光センサ飽和などのトラブルに対し、ハードウェア保護回路と Python 自律リカバリー（推測航法・逆噴射ホバリング）で対抗。
* **DPPA 3D サイバー・ワイヤーフレーム**: 80年代ベクタースキャン風の軽量 3D 画面と、航空宇宙標準 C&W（Caution & Warning）アナンシエータ計器を搭載。

---

## 2. ディレクトリ構成 (Structure)
```text
SpaceGuidance-FBB/
├── fbb-plugin.json               # PPA/DPPA ハイブリッドプラグインマニフェスト
├── CMakeLists.txt                # C++ ビルド定義
├── README.md                     # 本ドキュメント
├── rtl/                          # Verilog HDL ハードウェア回路
│   ├── space_guidance_top.v      # AXI4-Lite スレーブ＆レジスタマップ (0x43C00000)
│   ├── line_sensor_filter.v      # 光学センサ ADC フィルタ＆Q16.16 重心計算
│   ├── rcs_thruster_pwm.v        # 8ch RCS スラスタ PWM パルス生成
│   └── safety_interlock.v        # ウォッチドッグ、SEU パリティ、E-STOP
├── src/                          # C++ シミュレーションデーモン
│   ├── space_guidance_daemon.cpp # 100Hz 物理・UIO 共有メモリブリッジ
│   └── space_physics.cpp         # 摩擦ゼロ・微小重力剛体物理エンジン
├── include/
│   └── space_physics.hpp
├── ros2/nodes/                   # Python 制御ノード
│   └── guidance_controller.py    # Sim-to-Real UIO/共有メモリ クライアント
├── examples/                     # 初心者向けお手本サンプル
│   └── mission01_baseline_pilot.py # チューニングガイド付きベースライン
├── panes/                        # DPPA Web ダッシュボード動的ペイン
│   ├── sg-orbit-viewer/              # 3D サイバー・ワイヤーフレーム描画
│   ├── sg-telemetry-gauge/        # テレメトリ＆C&W レッドアラート
│   └── sg-chaos-fdir/                # カオス FDIR コンソール＆スコアカード
└── scenario/
    └── 01_asteroid_pipeline/     # Stage 1 自動テスト＆実行スクリプト
```

---

---

## 3. 機体仕様・搭載ハードウェア (Spacecraft Hardware Specs)

本シナリオで運用される自律宇宙探査機は、実機 FPGA（AMD Xilinx Zynq-7000 / Kria KV260）への移植を前提とした本格的なハードウェア・センサ・スラスタ構成を備えています。

### (1) 機体物理諸元
* **乾燥質量 (Mass)**: 10.0 kg
* **慣性モーメント (Inertia)**: 2.5 kg·m²
* **機体寸法**: 全幅 0.4m（翼幅・センサバー基台）, 全長 0.8m
* **力学特性**: 完全無摩擦・微小重力の剛体物理（慣性直進・トルク角加速度積分）

### (2) センサ系 (Sensors)
* **8ch 光学センサアレイバー (8-Channel Optical Line Sensor Array)**:
  * 機首前方 0.5m に搭載（横幅 0.35m〜0.4m、4bit ADC × 8ch）。
  * パイプライン中心線（再帰反射ガイドレール）の光度ピークを検知。
  * **FPGA RTL重心演算回路 (`line_sensor_filter.v`)**: CPUを介さずハードウェア回路がナノ秒単位で幾何学的重心を計算し、中心からの偏差（`ADDR_SENSOR_EDGE`: `0x43C0000C`、Q16.16: -1.0〜+1.0）としてリアルタイム出力。
* **太陽光グレア飽和検知回路 (`line_sensor_filter.v`)**:
  * 直射日光照射による全センサ飽和（Glare Fault）を検知し、即時ステータス・割り込みを発行。
* **宇宙放射線 SEU モニタ & 通信断 (LOS) 監視回路 (`safety_interlock.v`)**:
  * 放射線によるレジスタパリティ異常（SEU）や、地上局との通信途絶（LOS: `sr_status & 0x08`）を常時監視。

### (3) 推進・アクチュエータ系 (Thrusters / Actuators)

#### 機体推進系・センサ系トポロジー配置図 (Hardware & Thruster Architecture)
![Spacecraft Hardware & Thruster Architecture](docs/images/spacecraft_hardware_layout.svg)

* **機体座標系 (Body Reference Frame)**:
  * **$+X$ 軸 (Forward / Heading)**: 機首方向。ロール軸。
  * **$+Y$ 軸 (Port / Left)**: 機体左舷方向。ピッチ軸。
  * **$+Z$ 軸 (Dorsal / Up)**: 機体天頂方向。ヨー軸（画面手前向き $\odot$）。
* **メイン推進スラスタ (Dual Aft Main Engines)**:
  * 機体尾部後端に2基配置（`Nozzle L`, `Nozzle R`）。
  * 最大推力: 50 N（`thrust_cmd_x`）。正値で前進加速、負値で逆噴射制動。
* **内蔵リアクションホイール (Internal Reaction Wheel: RW)**:
  * 機体重心（CoM: $X=-0.4\text{m}, Y=0.0\text{m}$）に搭載された電気駆動フライホイール。
  * **推進剤消費ゼロ**: バッテリー電力のみで駆動し、燃料（Delta-V）を一切消費せずに精密な角運動量制御を実現。
  * **物理特性**: フライホイール慣性モーメント $I_w = 0.02\text{ kg}\cdot\text{m}^2$、最大回転数 $\pm 6,000\text{ RPM}$、最大トルク $5.0\text{ N}\cdot\text{m}$。
  * **作用・反作用（角運動量保存則）**: フライホイールを加減速させることで、機体本体に逆向きのカウンタートルク（$\tau_{\text{body}} = -\tau_{\text{wheel}}$）を発生。
  * **レジスタ I/F**: `ADDR_WHEEL_CMD` (`0x43C0002C`) への書き込み、および `wheel_rpm` (`0x70`) テレメトリ読み出しに対応。
* **RCS 姿勢・並進制御スラスタポッド (Reaction Control System: 4 Pods / 8 Nozzles + Roll Nozzles)**:
  * **Bow Port RCS [Pod 1]** ($X=+0.8\text{m}, Y=-0.65\text{m}$): 機首左舷。外側噴射で$+Y$ラテラル推力および$+Yaw$（左旋回）トルク。
  * **Bow Starboard RCS [Pod 2]** ($X=+0.8\text{m}, Y=+0.65\text{m}$): 機首右舷。外側噴射で$-Y$ラテラル推力および$-Yaw$（右旋回）トルク。
  * **Stern Port RCS [Pod 3]** ($X=-1.3\text{m}, Y=-1.8\text{m}$): 左翼端。ヨー制動に加え、天頂($+Z$)・天底($-Z$)ロールノズルを内蔵。
  * **Stern Starboard RCS [Pod 4]** ($X=-1.3\text{m}, Y=+1.8\text{m}$): 右翼端。ヨー制動に加え、天頂($+Z$)・天底($-Z$)ロールノズルを内蔵。
* **二刀流ハイブリッド姿勢制御 (Hybrid GNC Strategy)**:
  * **通常航行**: リアクションホイールを優先駆動し、燃料消費ゼロで超高精度にラインへ追従。
  * **ホイール脱飽和 (Momentum Desaturation / アンローディング)**: フライホイールが飽和限界（$5,000\text{ RPM}$ 超過）に達した際、RCSスラスタを一瞬噴射して機体姿勢を保持しながらホイール回転数を安全域まで引き戻す宇宙工学シーケンスを実行。
* **3D 空間での姿勢・スラスタエフェクト連動**:
  * **物理正当化インサイドバンク**: 主翼端の天頂・天底ロールノズル偶力噴射により、旋回内側へ自然にバンク（内傾）。メインエンジンの推力ベクトルを旋回中心へ向け求心加速度を生成。
  * **コールドガスパルスジェット描画**: トルク・横推力・ロール噴射時に該当ノズルから鮮やかなパルスプラズマジェットが動的噴射。
  * **フライホイール HUD**: 3Dビューア内およびテレメトリにリアクションホイールのリアルタイム回転数（RPM）を表示。

### (4) 安全保護系 (Safety Interlocks)
* **ハードウェア・ウォッチドッグタイマ (`safety_interlock.v`)**:
  * CPU側プログラムのフリーズを検知し、定期キック（`ADDR_WATCHDOG_KICK`）が途絶えると自動的に推進系を遮断。
* **緊急停止 (E-STOP) ハードウェアインターロック**:
  * 異常検知時にスラスタPWM出力を物理的に遮断（フェイルセーフ）。

## 4. クイックスタート (Quick Start)

### ① プラグイン仕様の検証 (PPA 整合性チェック)
```bash
cd /workspaces/FPGA-BoardlessBench
./bin/fbb plugin validate ~/.fbb/plugins/SpaceGuidance-FBB
```

### ② F-BB 統合ラボ環境での実行 (Web ダッシュボード・3D 観戦モード)
F-BB の Verilator RTL シミュレータ、C-Shim、および Web ダッシュボードと全連動させて、リアルタイム 3D 空間で飛行を観戦・デバッグします。

```bash
cd /workspaces/FPGA-BoardlessBench
./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline
```
* **Web ダッシュボード**: ブラウザで [http://localhost:8080](http://localhost:8080) を開くと、以下の 4 分割画面が自動ロードされます：
  * **SG 3D Cyber Orbit Viewer**: 3D 六角形ポータルトンネルをくぐり抜ける立体ワイヤーフレーム飛行ビュー。マウスドラッグによる自由視点回転、拡大縮小スライダー/ホイール操作、星々のダイナミック・スターフィールド（バンク角・視点連動パララックス）、カメラプリセット（`[CHASE]`後方上、`[FRONT]`正面上、`[HERO]`右下煽り、`[PATROL]`360°巡回）、および一定間隔で自動切り替わる `[CINEMA]` モードを搭載
  * **SG Telemetry & C&W**: 推進剤（燃料）残量バー、Master C&W 警報灯、姿勢角・速度計器
  * **SG Chaos FDIR & Scorecard**: 飛行モード遷移バナー、軌道偏差ベクトル（Δd）ゲージ
  * **Chaos & Fault Injection Engine**: F-BB 標準パネル。**`[Restart Scenario]`** ボタンから何度でもワンクリックで再フライト可能
* **終了方法**: ターミナルで `Ctrl + C` を押すと、全プロセスが安全に停止します。

### ③ スタンドアローン直接実行 (CLI 高速モード)
Web ダッシュボードを立ち上げず、物理デーモンと Python パイロットのみでアルゴリズムやパラメータ変更の結果を数秒で高速検証します。

```bash
cd /workspaces/SpaceGuidance-FBB
bash scenario/01_asteroid_pipeline/run_mission.sh
```

### ④ カオス障害注入・自律復旧 (FDIR) 自動検証
放射線 SEU（ビット反転）、通信途絶（LOS）、およびスラスター固着障害を自動注入し、機体の自己診断・推測航法復旧を CI テストします。

```bash
cd /workspaces/SpaceGuidance-FBB
python3 scenario/01_asteroid_pipeline/test_chaos_fdir.py
```

---

## 5. 初心者ハッキングガイド (Hacker Tutorial)
`examples/mission01_baseline_pilot.py` を開き、以下のコメント領域を書き換えることでスコアが劇的に向上します：
1. **TUNE ZONE 1 (ふらつき抑制)**: `kd = 0.0` を `kd = 0.15` に変更して蛇行を抑制（Grade A 獲得）。
2. **TUNE ZONE 2 (巡航速度最適化)**: `forward_thrust` を調整してクリアタイムを短縮。
3. **TUNE ZONE 3 (カオス耐障害性)**: `carrier_lost` 検知時に逆噴射ホバリングを発動して Grade S を獲得！

---

## 6. Zynq-7000 実機への移植ガイド (Sim-to-Real)
* **PL (FPGA 論理)**: `rtl/*.v` を Vivado IP Integrator に追加し、AXI4-Lite スレーブとして Zynq PS の M_AXI_GP0 (`0x43C00000`) に接続。
* **PS (ARM CPU)**: Linux 上で UIO ドライバ（`/dev/uio0`）をバインドし、`ros2/nodes/guidance_controller.py` をそのまま実行。

---

## ライセンス (License)

本プロジェクトは **MIT License** の下で公開されています。商用・非商用問わず、誰でも自由に改変・再配布・利用することが可能です。
