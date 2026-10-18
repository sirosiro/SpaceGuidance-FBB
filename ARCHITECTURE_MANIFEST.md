# ARCHITECTURE_MANIFEST: SpaceGuidance-FBB

## 1. 存在意義と設計原則 (Core Value & Principles)

**SpaceGuidance-FBB** は、組み込み教育・制御競技の原点である「ライントレースロボット」の制御概念を、極限環境である「宇宙探査・軌道誘導（Space Guidance）」へと昇華させた、FPGA-BoardlessBench (F-BB) 向けの完全独立型ゲームプラグインである。

### 設計原則
1. **実機透過性と Sim-to-Real 100%**:
   - アプリケーション・自律航行スクリプト（Python / ROS 2）は、ホスト上のエミュレーション（`/dev/shm` / UIO）と AMD Xilinx Zynq 実機（`/dev/uio0`）で全く同一のバイナリ・コードで動作する。
2. **Decoupled Observability & Zero Disk I/O (非侵襲的ゼロディスク観測)**:
   - 100Hz の物理シミュレーションループにおいて、ディスク I/O（`std::ofstream` による一時ファイル書き出しや `rename`）を完全に排除する。
   - すべての観測情報・6-DoF テレメトリは POSIX 共有メモリ（`/dev/shm/fbb_space_guidance_shm`）に Seqlock 方式で直接書き込み、Web ダッシュボードやコントローラがメモリ直読でゼロ遅延観測を行う。
3. **Single Source of Truth (公式審判 SSOT)**:
   - スコアリング、チェックポイント通過判定、ミッション合否、公式グレード判定は、C++ 物理デーモン内部の `OfficialReferee` が唯一の真実（SSOT）として決定し、共有メモリ経由で全ペイン・スクリプトへ配信する。
4. **Fair Engagement Timing & Zero Preparation Penalty (初動トリガーによる準備時間と競技時間の完全分離)**:
   - AI モデル（PyTorch / ONNX）のロード、重み展開、事前軌道生成等の「準備時間」は飛行時間およびタイムボーナス減点から完全に除外する。
   - 公式審判（`OfficialReferee`）のタイマースタートは、プレイヤーがハードウェアへ最初の有効な制御コマンド（推力またはホイールトルク）を発行した瞬間（First Control Engagement）に自動発火させる。
5. **Learner-Centric Purity in Autopilot (自律操縦スクリプトの完全ピュア化)**:
   - `pilot.py` は純粋な誘導・航法・制御（GNC: Guidance, Navigation, Control）ロジックおよびゴール時の安全停止（スラストゼロ & `break`）のみに専念する。自前のタイマー計測（`time.time()`）や 20行超のプレゼンテーション用 ASCII バナー整形コードの配置を禁止し、公式審判リザルトの表示は `SpaceGuidanceHardware` の 1 行ヘルパー（`hw.print_summary()`）へ完全にカプセル化する。

---

## 2. 共有メモリ・テレメトリ仕様 (Shared Memory Architecture: space_guidance_shm.h)

### 2.1 メモリ配置とアラインメント規約
共有メモリは 4096 バイト（1 ページ）で確保され、下表の通り厳格にオフセット分割される：

| オフセット範囲 | サイズ | 区分 | 説明 |
| :--- | :--- | :--- | :--- |
| `0x00` - `0x2F` | 48 B | **MMIO レジスタ** | UIO 互換ハードウェア制御レジスタ（CR, SR, センサ値, PWM, トルク, カオスシード等） |
| `0x30` - `0x7F` | 80 B | **基本 2D テレメトリ** | レガシー互換 2D 座標・速度・姿勢角・燃料・ホイール RPM・FDIR モード |
| `0x80` - `0x8F` | 16 B | **公式審判スコア** | 公式スコア、通過ゲート数、ミッションステータス（Active/Complete/Failed） |
| `0x90` - `0xA7` | 24 B | **多軸指令 (Ext Cmd)** | 自律操縦スクリプトから書き込まれる 3 軸トルク・垂直推力指令 |
| `0xA8` - `0xAF` | 8 B | **同期ヘッダー** | `magic`: `0x53504731` ('SPG1')、`seq_num`: Seqlock シーケンスカウンタ |
| `0xB0` - `0x1EF` | 320 B | **拡張 6-DoF テレメトリ** | 3D 位置・オイラー角・角速度・3軸ホイール・テザー張力・デブリ衝突幾何・文字列表現 |
| `0x1F0` - `0xFFF` | 3584 B | **予約領域** | 将来の拡張用空き領域 |

### 2.2 Seqlock (ロックフリー同期) プロトコル
テレメトリ読み書きにおけるデータの整合性（Torn Read 防止）を担保するため、Seqlock パターンを採用する：
- **書込側 (Daemon)**:
  1. `seq_num` をインクリメント（奇数: 書込中フラグ）。
  2. メモリバリア（`atomic_signal_fence(memory_order_release)`）。
  3. `ShmSpaceGuidance.ext` の全フィールドを更新。
  4. メモリバリア。
  5. `seq_num` をインクリメント（偶数: 書込完了）。
- **読取側 (Node.js / Python)**:
  1. `s1 = seq_num` を読取。`s1 & 1`（書込中）なら即時スキップまたは再試行。
  2. 全データを一括読取。
  3. `s2 = seq_num` を読取。`s1 == s2` であれば有効データとして確定。

---

## 3. 通信・可視化アーキテクチャ (Unified Telemetry Bus)

1. **統合 WebSocket バス (`scenario:telemetry`)**:
   - `dashboard/server.js` は、毎秒 30 回（33ms 周期）共有メモリバッファを走査し、`seq_num` が更新されていれば即座にバイナリを展開して WebSocket `scenario:telemetry` イベントとしてブラウザへプッシュ配信する。
   - 個別ペインが HTTP GET（`/api/file?path=...`）を連打するポーリングは完全に禁止とする。
2. **DPPA プラグインペイン群**:
   - `sg-orbit-viewer`: Three.js / Canvas による 3D ワイヤーフレーム宇宙空間・軌道・デブリ描画。
   - `sg-chaos-fdir`: FDIR 縮退運用ステータス、公式スコアカード、カオス障害発生ログ。
   - `sg-telemetry-gauge`: 計器盤、推進薬残量、C&W アナンシエータ（警報灯）。

---

## 4. アーキテクチャ決定の記録 (ADR)

- **2026-10-17: ADR #001 共有メモリ直結型テレメトリ（Zero Disk I/O）の導入**
  - **Decision**: 毎秒 100 回のディスク一時ファイル書き込み（`/tmp/space_guidance_telemetry.json`）を完全撤廃し、`include/space_guidance_shm.h` で定義される 496 バイトの POSIX 共有メモリ構造体（Seqlock 制御）へと完全移行した。
  - **Rationale**: 外部 PC（MacBook M4 等）からの接続時におけるマイクロスタッターやファイル I/O 詰まりを根絶し、シミュレーション全体の CPU 使用率・ディスク負荷を劇的に低減するため。

- **2026-10-18: ADR #002 初動トリガー方式（First Action Timing Protocol）とパイロットコードの完全ピュア化**
  - **Decision**:
    1. C++ 物理デーモン内の `OfficialReferee` において、デーモン起動時からの無条件タイマースタートを廃止し、最初の推力/トルク制御コマンド受信（またはスタートライン通過）を検知して公式タイマーを始動する「初動トリガー方式」を導入。ゴール到達時に公式タイマーを自動停止・確定する。
    2. 全ステージ（01〜05）の `pilot.py` 内に散乱していた自前の `start_time` / `elapsed` 計測および 20行超のスコア print バナーを一掃。`SpaceGuidanceHardware` 側に公式審判 SSOT から確定値を整形出力する `hw.print_summary(stage_name)` を新設し、`pilot.py` 側は 1 行の呼び出しへ集約。
  - **Rationale**:
    - AI や事前最適化アルゴリズムを導入したプレイヤーが、モデル読込やデータ準備時間を理由に理不尽なタイムペナルティを受ける構造的欠陥を排除し、公平な競技環境を確立するため。
    - プレイヤーの自己申告計測によるチート（`elapsed` 改ざん）を物理的に排除し、100% 公式審判 SSOT による決定論的公正性を担保するため。
    - 学習者・開発者が余計なインフラや表示整形コードに惑わされず、制御工学の本質に 100% 集中できる Learner-Centric Purity を確立するため。
