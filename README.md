# SpaceGuidance-FBB: 自律宇宙探査・軌道ガイダンス プラグイン
(Autonomous Space Guidance & Docking Challenge Plugin for FPGA-BoardlessBench)

![Dashboard](assets/dashboard.gif)

---

## 1. プロジェクト概要 (Project Overview)

**SpaceGuidance-FBB** は、組み込み教育・制御競技の原点である「ライントレースロボット」の制御概念を、極限環境である **「宇宙探査・軌道誘導（Space Guidance）」** へと昇華させた、FPGA-BoardlessBench (F-BB) 向けの完全独立型ゲームプラグインです。

従来の地上型ロボットが「車輪の機械的摩擦」と「目視リアルタイム操舵」に依存していたのに対し、本プラグインでは **「微小重力・完全無摩擦（Zero Friction）」の宇宙物理空間** を舞台とします。プレイヤーはゲームパッドでのアクション操作ではなく、**「FPGA RTL による超高速ハードウェア安全回路・PWM制御」** と **「Python (ROS 2 `rclpy`) による自律誘導アルゴリズム・FDIR（障害検知・隔離・回復）」** を設計・チューニングし、3Dサイバーワイヤーフレーム画面で宇宙探査機の自律航行を観戦・評価します。

---

## 2. 全4ステージ プログレッシブ・ロードマップ (Progressive Missions)

本プラグインは、基本となる「ハードウェア防護＋自律スラスタ制御」の共通アーキテクチャを土台としながら、物理次元と制御要素を段階的にステップアップできる **4つのミッションステージ** で構成されています。全4ステージとも物理エンジン・自律操縦スクリプト・公式審判システムが実装済みであり、即座にプレイ可能です。

```mermaid
graph LR
    Stage1["Stage 1: 小惑星パイプライン巡回<br/>(2D 平面 + 微小重力ダウンフォース)"] --> Stage2["Stage 2: 宇宙テザークライマー<br/>(1D 超高速昇降 + ケーブル振動抑制)"]
    Stage2 --> Stage3["Stage 3: ISSトラスレール点検機<br/>(3D 軌道レール + 電磁ラッチ把持)"]
    Stage3 --> Stage4["Stage 4: 深宇宙光レーザードッキング<br/>(6-DoF 完全摩擦ゼロ + 十字光軸整定)"]
```

| ステージ | ミッション名 | 難易度 | 物理環境と主要課題 | ハードウェア (RTL) | ソフトウェア (Python) | 専用ドキュメント |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: |
| **Stage 1** | **小惑星パイプライン巡回**<br>(Asteroid Pipeline Inspector) | Level 1<br>(入門) | **2D微小重力・無摩擦**<br>小惑星表面50m S字誘導レール | 光センサ重心演算回路<br>(`line_sensor_filter.v`)、<br>ウォッチドッグ安全遮断 | PDライン追従誘導、<br>リアクションホイール脱飽和、<br>9ゲート通過航法 | [詳細ガイド](scenario/01_asteroid_pipeline/README.md) |
| **Stage 2** | **宇宙テザークライマー**<br>(Orbital Tether Climber) | Level 2<br>(初中級) | **1D直線運動＋弾性弦振動**<br>軌道エレベータ超長大テザー | 高速光学マークカウンタ、<br>共振周波数遮断ノッチフィルタ | ケーブル断裂防止 S字加減速、<br>共振抑制フィードフォワード | [詳細ガイド](scenario/02_tether_climber/README.md) |
| **Stage 3** | **ISSトラスレール点検機**<br>(ISS Truss Inspector) | Level 3<br>(中上級) | **3D立体曲面レール軌道**<br>急カーブ遠心力と反作用連成 | 3軸 IMU 慣性積分器、<br>電磁グリッパー把持力FBラッチ | 3次元レール曲率適応速度計画、<br>4箇所点検把持シーケンス | [詳細ガイド](scenario/03_iss_truss/README.md) |
| **Stage 4** | **深宇宙光レーザードッキング**<br>(Optical Laser Docking) | Level 4<br>(エキスパート) | **6-DoF 完全摩擦ゼロ**<br>オイラー運動方程式、デルタV制限 | 4分割フォトダイオード(QPD)光軸、<br>最小インパルス PWM RCS | 6自由度 Line-of-Sight 誘導、<br>7段階レンジ接近整定 | [詳細ガイド](scenario/04_laser_docking/README.md) |

---

## 3. アーキテクチャと Sim-to-Real (Zynq-7000 / Kria 適合性)

### 技術スタック・責務分担アーキテクチャ全体図 (Full Technology Stack)

SpaceGuidance-FBB では、ベースプラットフォームである **FPGA-BoardlessBench (F-BB)** の基盤機能と、競技プラグインである **SpaceGuidance-FBB (SG-FBB)** の実装機能が明確に疎結合化されています。下図では、各コンポーネントの担当領域を目印（バッジ）および色分けで示しています。

```mermaid
flowchart TB
    %% 凡例 (Legend)
    subgraph LEGEND["凡例 / 責務分担 (Responsibility Separation)"]
        direction LR
        LEG_FBB["[F-BB] ホスト基盤プラットフォーム<br/>(シミュレーション環境・通信バス・基盤UI)"]:::fbb
        LEG_SG["[SG-FBB] 宇宙探査プラグイン<br/>(3D描画・物理力学・公式審判・RTL回路・自律誘導)"]:::sg
    end

    subgraph UI["1. Web Cockpit & Visualization Layer (ブラウザ・表示系)"]
        DASH["[F-BB] Web Dashboard ホスト<br/>(DPPA 動的ペインローダー / React レイアウト)"]:::fbb
        ORBIT["[SG-FBB] 3D Cyber Orbit Viewer<br/>(Three.js ワイヤーフレーム 3D エンジン)"]:::sg
        FDIR_UI["[SG-FBB] Official Referee Scorecard<br/>(公式スコア・ランクバッジ・審判イベント)"]:::sg
        TLM_UI["[SG-FBB] Telemetry & C&W Gauges<br/>(計器盤・レッドアラート警報灯)"]:::sg
    end

    subgraph SW["2. Autopilot & Guidance Layer (Python / 操縦・自律誘導系)"]
        PILOT["[SG-FBB] Autopilot Scripts (pilot.py)<br/>(PD誘導・S字ジャーク制限・6-DoF 視線誘導)"]:::sg
        FDIR_SW["[SG-FBB] FDIR & 自律縮退復旧<br/>(センサ喪失推測航法・SEU検出・安全モード)"]:::sg
        DESAT["[SG-FBB] 脱飽和マネージャー<br/>(リアクションホイール角運動量アンローディング)"]:::sg
        ROS2["[SG-FBB] ハードウェアクライアント<br/>(guidance_controller.py / SpaceGuidanceHardware)"]:::sg
    end

    subgraph SIM["3. Physics Simulation & Referee Engine (C++17 / 物理・公式審判)"]
        PHYS["[SG-FBB] Space Physics Engine (space_physics.cpp)<br/>(100Hz 剛体力学・弾性テザー弦波・3Dレール・6-DoF)"]:::sg
        REF["[SG-FBB] Official Referee Engine (SSOT)<br/>(オーソリテーティブなゲート通過・採点・ランク判定)"]:::sg
        DAEMON["[SG-FBB] Space Guidance Daemon (space_guidance_daemon.cpp)<br/>(100Hz シミュレーションメインループ)"]:::sg
    end

    subgraph IPC["4. Inter-Process Communication & Data Bus (IPC / データバス)"]
        HTTP_WS["[F-BB] WebSocket 統合テレメトリバス<br/>(Node.js Express / Socket.IO :8080)"]:::fbb
        SHM["[F-BB / SG-FBB] POSIX 共有メモリ基盤 (Zero Disk I/O)<br/>(/dev/shm/fbb_space_guidance_shm: 496B MMIO + 6-DoF Seqlock)"]:::sg
    end

    subgraph HW["5. Hardware & Sim-to-Real Layer (FPGA RTL / ハードウェア防護)"]
        UIO["[F-BB] Linux UIO サブシステム<br/>(Sim-to-Real 透過ドライバ /dev/uio0)"]:::fbb
        AXI["[F-BB] AXI4-Lite バス規格<br/>(32-bit MMIO バス相互接続)"]:::fbb
        TOP["[SG-FBB] AXI4-Lite Top IP<br/>(space_guidance_top.v)"]:::sg
        FILTER["[SG-FBB] 光学センサ重心フィルタ<br/>(line_sensor_filter.v)"]:::sg
        PWM["[SG-FBB] RCS 最小インパルス PWM<br/>(rcs_thruster_pwm.v)"]:::sg
        SAFETY["[SG-FBB] インターロック & WDT<br/>(safety_interlock.v)"]:::sg
        SIM_HDL["[F-BB] Verilator シミュレータ / AMD Zynq PL 実機<br/>(周期精度 C++ モデル / 実機シリコン)"]:::fbb
    end

    %% Connections
    UI <-->|"scenario:telemetry (WebSocket)"| HTTP_WS
    HTTP_WS <-->|"メモリ直読 (Zero Disk I/O)"| SHM

    PILOT --> ROS2
    FDIR_SW --> ROS2
    DESAT --> ROS2

    ROS2 <-->|"レジスタ読み出し / 指令書き込み"| SHM
    DAEMON <-->|"100Hz 双方向更新"| SHM

    PHYS <--> DAEMON
    REF <--> DAEMON

    SHM <-->|"透過エミュレーション / 実機 UIO"| UIO
    UIO <-->|"AXI4-Lite バスアクセス"| AXI
    AXI <--> TOP
    TOP --> FILTER
    TOP --> PWM
    TOP --> SAFETY
    TOP <--> SIM_HDL

    %% スタイル定義 (Style Definitions)
    classDef fbb fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef sg fill:#2e1065,stroke:#c084fc,stroke-width:2px,color:#f8fafc;
```


本プラグインのハードウェア（PL論理）およびソフトウェア（PS CPU）のフットプリントは、AMD Xilinx Zynq-7000 (Z-7010 / Zybo, Cora) や Kria KV260 実機において、**1行のコード変更もなしにそのまま動作する設計（100% Sim-to-Real 透明性）** を保証しています。

```
+-----------------------------------------------------------------------+
|  PS (Processing System): Linux + ROS 2 (Python rclpy)                 |
|  - 軌道追従・誘導制御アルゴリズム (PD / S字加減速 / 6-DoF LOS 誘導)    |
|  - 状態遷移管理 (Behavior Tree / 巡回ステートマシン)                  |
|  - FDIR (障害検知・隔離・回復・推測航法フォールバック)                |
+-----------------------------------------------------------------------+
                                   ||  UIO / mmap (/dev/uio0 or /tmp/vfpga_reg)
                                   \/  AXI4-Lite バス (32-bit MMIO)
+-----------------------------------------------------------------------+
|  PL (Programmable Logic): Verilog HDL / FPGA IP Core                  |
|  - 光学センサ / IMU / QPD フィルタ・エッジ検出回路 (ナノ秒応答)       |
|  - ハードウェア・インターロック & ウォッチドッグ (異常時即時スラスタ遮断)|
|  - RCS スラスタ PWM パルスジェネレータ (符号付き Q16.16 デューティ変換)|
|  - SEU パリティ監視 (ハードウェアレジスタ保護 & E-STOP 連動)           |
+-----------------------------------------------------------------------+
```

### 3.1 Sim-to-Real 二層検証設計 (Dual-Track Validation Philosophy)
本プロジェクトは、航空宇宙・組込み制御分野で標準的な **MIL/SIL（ソフトウェア検証）と HIL/実機（ハードウェア論理合成）の階層分離** に基づき、目的の異なる 2 つの具象化トラック（Dual-Track）を並行して維持しています：

1. **Track A: 高速 SIL（Software-in-the-Loop）リアルタイム開発環境**
   * **実装**: C++ 物理シミュレーションデーモン（`space_guidance_daemon.cpp` / `space_physics.cpp`）
   * **役割**: ホスト PC 上で 100Hz の 6 自由度剛体力学演算、外乱・カオス障害、および Web3D ダッシュボードへのリアルタイム配信を、実機 FPGA なし（Boardless）で軽快に成立させます。
   * **価値**: 開発者は EDA ツールの重厚なクロック遅延シミュレーションに待たされることなく、自律航行アルゴリズムや FDIR の試行錯誤・反復学習を瞬時に行えます。
2. **Track B: 論理合成対応 RTL IP コア（Synthesizable Hardware & Verilator Co-Sim）**
   * **実装**: ピュア Verilog HDL（`rtl/space_guidance_top.v`, `line_sensor_filter.v`, `rcs_thruster_pwm.v`, `safety_interlock.v`）
   * **役割**: AMD Xilinx Vivado で論理合成（Synthesis）し、Zynq / Kria KV260 の実機 FPGA ファブリック（PL）にそのまま書き込み可能なハードウェア IP です。
   * **高信頼性安全アーキテクチャ**:
     * **真の 100% PWM 連続出力**: カウンタ飽和判定により 255/256（99.61%）のドロップアウトを排除し、最大指令時の正真正銘 100.00% 連続全開噴射（Continuous Full Burn）を担保。
     * **多軸双方向符号付き安全リミッター**: X軸推進力・Y軸ラテラル推力の両チャンネルに対し、符号を維持したまま設定限界値への厳格なクランプを実施（トップ階層テストポートで実測検証）。
     * **動的パリティ書き込みストローブ**: CPU による AXI レジスタ正常更新と、放射線等による自発的ビット反転（SEU）を正確に識別する動的奇数パリティ監視。
   * **包括的自動テスト体系**:
     * `tests/test_rtl_top.cpp`: 全 7 項目の RTL 単体テスト（真の 100% PWM 連続性、X/Y 軸のビットレベル合否アサート、SEU 動的保護、WDT タイムアウト）。
     * `tests/test_physics_sim.cpp`: 無摩擦慣性航行、センサ ADC エッジ検出、および「光学センサ ADC $	o$ RTL 重心演算 $	o$ PWM スラスタ噴射 $	o$ 6 自由度剛体物理推進」のクローズドループ Co-Sim 統合検証を自動アサートで 100% 保証。
3. **100% Sim-to-Real 透過性の保証 (Single Source of Truth)**
   * Track A（PC 上の SIL）で開発した自律操縦スクリプト（`pilot.py`）は、実機 FPGA（Track B）に移植した際も、`/dev/uio0` の 32-bit MMIO レジスタマップ仕様が完全に一致しているため、**1 行のコード変更もなしにそのまま実機で動作**します。

### 公式審判システム (Official Referee: Single Source of Truth)
本システムでは公平な競技性・シミュレーションの信頼性を担保するため、スコア計算・ゲート通過判定・ペナルティ判定・合否判定（Grade S/A/B/C）を各プレイヤーのスクリプトから完全に分離し、中央シミュレーションデーモン（`space_guidance_daemon.cpp`）内の **`OfficialReferee` エンジン** が 100Hz 周期でオーソリテーティブに判定します。

* **改ざん防止**: パイロットコード側の書き換えによるスコア偽装を原理的に排除。
* **高精度判定**: 100Hz の剛体力学ループ内でチェックポイント通過時の偏差や接触速度をミリ秒単位で正確に計測。
* **全方位配信**: 共有メモリ（SHM: 144バイト）および `/tmp/space_guidance_telemetry.json` を通じて Web ダッシュボードとパイロットへリアルタイム配信。

### MMIO レジスタマップ仕様 (UIO 0x43C0_0000 / 共有メモリ 144バイト)
| オフセット | レジスタ名 | 属性 | 説明 |
| :--- | :--- | :---: | :--- |
| `0x00` | `CR_CTRL` | R/W | システム制御（Bit 0: Enable, Bit 1: E-STOP, Bit 2: FDIR Reset） |
| `0x04` | `SR_STATUS` | R | ステータス（Bit 0: Active, Bit 1: Interlock, Bit 2: SEU Alert, Bit 3: LOS） |
| `0x08` | `SENSOR_RAW` | R | センサ受光強度 ADC 生データ（Stage 1: 8ch 光学 / Stage 4: QPD） |
| `0x0C` | `SENSOR_EDGE`| R | ハードウェア幾何重心偏差（符号付き Q16.16: -3.5〜+3.5 素子ピッチ単位、0.0が中心） |
| `0x10` | `THRUST_CMD_X` | R/W | X軸（メイン推進 / 登坂）推力指令値（Q16.16: -50N〜+50N） |
| `0x14` | `THRUST_CMD_Y` | R/W | Y軸（ラテラル横移動）推力指令値（Q16.16: -50N〜+50N） |
| `0x18` | `THRUST_CMD_Z` | R/W | Z軸推力指令値（Q16.16） |
| `0x1C` | `TORQUE_CMD` | R/W | RCS 姿勢回転トルク指令値（Q16.16: -20Nm〜+20Nm） |
| `0x20` | `SAFETY_LIMIT` | R/W | ハードウェア最大推力・加速度リミッター設定値 |
| `0x24` | `WATCHDOG_KICK` | W | ハードウェア監視タイマークリア（100ms 未更新で自動安全遮断） |
| `0x28` | `CHAOS_FAULT_INJ` | R/W | F-BB カオス障害注入レジスタ（SEU, LOS, スラスタ固着） |
| `0x2C` | `WHEEL_TORQUE_CMD` | R/W | リアクションホイール電気駆動トルク指令値（Q16.16: -20Nm〜+20Nm） |
| `0x30`〜`0x74` | `TELEMETRY_EXPORT` | R | 8バイト整列倍精度浮動小数点（`pos_x`, `pos_y`, `vel_x`, `vel_y`, `angle`, `omega`, `fuel`, `cross_track_err`, `wheel_rpm`） |
| `0x78` | `FDIR_MODE` | R/W | 現在のアクティブ FDIR 制御モード（0: NOMINAL, 1: DEGRADED, 2: SAFE） |
| `0x7C` | `STAGE_ID` | R | アクティブミッションステージ番号（1, 2, 3, 4） |
| `0x80` | `OFFICIAL_SCORE` | R | 公式審判確定スコア（符号付き 32-bit int: 点数 pts） |
| `0x84` | `PASSED_GATES` | R | 通過済チェックポイント累積カウント |
| `0x88` | `MISSION_STATUS`| R | ミッション状態（0: ACTIVE, 1: COMPLETE, 2: FAILED） |
| `0x8C` | `TOTAL_GATES` | R | 当該ステージの総チェックポイント数 |

---

## 4. クイックスタート (Quick Start)

SpaceGuidance-FBB は、F-BB（FPGA-BoardlessBench）の公式プラグイン規格（PPA 5.1 / DPPA v1.0）に準拠したハイブリッド拡張パッケージです。F-BB 統合 CLI（`fbb`）を用いてワンステップで導入・検証・起動できます。

### ① プラグインのインストール (Plugin Installation)
F-BB 環境のターミナルにて、以下の統合 CLI コマンドを実行してインストールします（自動的に `~/.fbb/plugins/SpaceGuidance-FBB` 配下へクローンされ、C++ 物理シミュレーションデーモンが自動コンパイルされます）：

```bash
# GitHub からワンショット導入（推奨）
fbb plugin install https://github.com/sirosiro/SpaceGuidance-FBB
```

導入後、プラグインの登録状況と仕様の健全性を確認します：
```bash
# 登録済みプラグイン一覧の確認（Hybrid: SpaceGuidance-FBB として検出）
fbb plugin list

# PPA / DPPA プラグイン仕様の整合性検証 (100% VALID チェック)
fbb plugin validate ~/.fbb/plugins/SpaceGuidance-FBB
```

### ② F-BB 統合ラボ環境での実行 (Web ダッシュボード・3D 観戦モード)
F-BB の Verilator RTL シミュレータ、C-Shim、および Web ダッシュボードと全連動させて実行します。

```bash
# Stage 1: 小惑星パイプライン巡回の起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/01_asteroid_pipeline

# Stage 2: 宇宙テザークライマーの起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/02_tether_climber

# Stage 3: ISS トラスレール点検機の起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/03_iss_truss

# Stage 4: 深宇宙光レーザードッキングの起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/04_laser_docking
```

> **ローカル開発環境（`/workspaces` 等で直接作業している場合）**:
> 相対パスまたは直接パスを指定して起動することも可能です：
> ```bash
> ./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline
> ```

* **Web ダッシュボード**: ブラウザで [http://localhost:8080](http://localhost:8080) を開くと、以下の分割画面が自動ロードされます：
  * **SG 3D Cyber Orbit Viewer**: 立体ワイヤーフレーム飛行ビュー（自由視点回転、ズーム、カメラプリセット CHASE/FRONT/HERO/PATROL/CINEMA）。Stage 1 の探査機、Stage 2 のピンチローラー式昇降ポッド＆GEOトーラスステーション＆小惑星基地、Stage 3 の立体トラス、Stage 4 の自転ドッキングポートを完全3D描画。
  * **Official Referee Scorecard & Chaos FDIR**: リアルタイム公式スコア、確定フライトランク（Grade S/A/B/C）、チェックポイント通過進捗、審判イベントログを表示。カオス障害注入および `[Restart Scenario]` による即時再フライトが可能。
  * **SG Telemetry & C&W**: 推進剤残量バー、Master C&W 警報灯、姿勢角・速度計器。
  * **Registers & Tracer**: 全レジスタのリアルタイム16進数監視および時系列波形プロット。
  * **UART: serial**: 探査機がシリアル出力する航法テレメトリログ。

### ③ スタンドアローン直接実行 (CLI 高速モード)
Web ダッシュボードを介さず、コンソールのみで物理シミュレーションと自律航法スクリプトを高速実行する場合：

```bash
cd ~/.fbb/plugins/SpaceGuidance-FBB

# 各ステージの直接実行
bash scenario/01_asteroid_pipeline/run_mission.sh
bash scenario/02_tether_climber/run_mission.sh
bash scenario/03_iss_truss/run_mission.sh
bash scenario/04_laser_docking/run_mission.sh
```

---

## 5. ディレクトリ構成 (Structure)

```text
SpaceGuidance-FBB/
├── fbb-plugin.json               # PPA/DPPA ハイブリッドプラグインマニフェスト
├── CMakeLists.txt                # C++ ビルド定義
├── README.md                     # ポータル: プロジェクト総合ガイド（本ドキュメント）
├── rtl/                          # Verilog HDL ハードウェア回路
│   ├── space_guidance_top.v      # AXI4-Lite IP コアトップ
│   ├── line_sensor_filter.v      # Stage 1: 8ch 光学センサ重心検出回路
│   ├── rcs_thruster_pwm.v        # RCS パルス幅変調ジェネレータ
│   └── safety_interlock.v        # ウォッチドッグタイマ & 安全遮断
├── src/                          # C++ 物理シミュレータ & デーモン
│   ├── space_physics.cpp         # 剛体力学・弾性テザー・レール・6-DoF 力学エンジン
│   └── space_guidance_daemon.cpp # 100Hz 物理デーモン & 公式審判エンジン (OfficialReferee)
├── ros2/nodes/                   # Python ハードウェアドライバ
│   └── guidance_controller.py    # Sim-to-Real UIO クライアント (SpaceGuidanceHardware)
├── scenario/                     # ステージ別独立シナリオ
│   ├── 01_asteroid_pipeline/     # 【Stage 1】小惑星回廊シナリオ (稼働中)
│   ├── 02_tether_climber/        # 【Stage 2】宇宙テザークライマー (稼働中)
│   ├── 03_iss_truss/             # 【Stage 3】ISS トラス点検機 (稼働中)
│   └── 04_laser_docking/         # 【Stage 4】深宇宙レーザードッキング (稼働中)
├── examples/                     # 原本・リセット用お手本テンプレート
│   ├── mission01_baseline_pilot.py   # Stage 1 原本
│   ├── mission02_baseline_climber.py # Stage 2 原本
│   ├── mission03_baseline_truss.py   # Stage 3 原本
│   └── mission04_baseline_docker.py  # Stage 4 原本
└── panes/                        # DPPA Web ダッシュボード動的ペイン
    ├── sg-orbit-viewer/          # 3D サイバー・ワイヤーフレーム描画
    ├── sg-telemetry-gauge/       # テレメトリ＆C&W レッドアラート
    └── sg-chaos-fdir/            # 公式審判スコアカード＆カオス FDIR コンソール
```

---

## 6. ライセンス (License)

本プロジェクトは **MIT License** の下で公開されています。商用・非商用問わず、誰でも自由に改変・再配布・利用することが可能です。
