# SpaceGuidance-FBB

Autonomous Space Guidance and Docking Challenge Plugin for FPGA-BoardlessBench (F-BB).

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
│   ├── space-orbit-viewer/       # 3D サイバー・ワイヤーフレーム描画
│   ├── space-telemetry-gauge/    # テレメトリ＆C&W レッドアラート
│   └── chaos-fdir-console/       # カオス FDIR コンソール＆スコアカード
└── scenario/
    └── 01_asteroid_pipeline/     # Stage 1 自動テスト＆実行スクリプト
```

---

## 3. クイックスタート (Quick Start)

### ① プラグイン仕様の検証
```bash
./bin/fbb plugin validate ~/.fbb/plugins/SpaceGuidance-FBB
```

### ② Stage 1 ミッションの実行 (お手本サンプルの走行)
```bash
bash /workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline/run_mission.sh
```

### ③ カオス障害注入・FDIR 自動検証
```bash
python3 /workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline/test_chaos_fdir.py
```

---

## 4. 初心者ハッキングガイド (Hacker Tutorial)
`examples/mission01_baseline_pilot.py` を開き、以下のコメント領域を書き換えることでスコアが劇的に向上します：
1. **TUNE ZONE 1 (ふらつき抑制)**: `kd = 0.0` を `kd = 0.15` に変更して蛇行を抑制（Grade A 獲得）。
2. **TUNE ZONE 2 (巡航速度最適化)**: `forward_thrust` を調整してクリアタイムを短縮。
3. **TUNE ZONE 3 (カオス耐障害性)**: `carrier_lost` 検知時に逆噴射ホバリングを発動して Grade S を獲得！

---

## 5. Zynq-7000 実機への移植ガイド (Sim-to-Real)
* **PL (FPGA 論理)**: `rtl/*.v` を Vivado IP Integrator に追加し、AXI4-Lite スレーブとして Zynq PS の M_AXI_GP0 (`0x43C00000`) に接続。
* **PS (ARM CPU)**: Linux 上で UIO ドライバ（`/dev/uio0`）をバインドし、`ros2/nodes/guidance_controller.py` をそのまま実行。
