# Stage 2: 宇宙テザークライマー (Orbital Tether Climber)

**難易度: Level 2 (初中級) | 物理空間: 1D直線運動 ＋ 弦の弾性波・連成共振力学**

---

## 1. ミッション概要 (Mission Overview)

静止軌道ステーション（GEO: 標高100m）と小惑星採掘基地を結ぶ超長大カーボンナノチューブ・テザーケーブルを昇降機（Climber）が超高速で自律昇降するミッションです。

テザーケーブルは長大かつ軽量であるため、「弾性を持つ弦（String）」として振る舞います。昇降機の加速・減速時の急激な推力変化（Jerk: 加速度の微分）はテザーに縦波・横波の衝撃波として伝播し、昇降機の駆動周波数がケーブルの固有振動数（$f_0 \approx 5.0\text{ Hz}$）に一致すると**激しい共振現象**を引き起こします。

共振振幅が限界を超え、ケーブル張力が破断閾値（$15,000\text{ N}$）を超過すると**ケーブル断裂事故（即時ゲームオーバー・失格）**に至ります。プレイヤーは**「S字加減速ジャーク制限」と「逆位相アクティブ制振ダンピング」**を設計・チューニングし、ケーブル破断を回避しながら最短タイムでGEO静止軌道プラットフォームへドッキングしなければなりません。

---

## 2. 機体・テザー仕様 & 物理連成モデル (Hardware Specs & Coupled Physics)

本シナリオの物理エンジンは、100Hz（$\Delta t = 0.01\text{s}$）周期で昇降機の運動方程式とテザー弦振動方程式を連成数値積分しています。

### (1) クライマー機体 & テザー物理諸元
* **昇降機乾燥質量 ($M$)**: $100.0\text{ kg}$（デュアルピンチモータ・回生バッテリー搭載）
* **テザー全長 ($L$)**: $100.0\text{ m}$（超高強度カーボンナノチューブ連続繊維）
* **臨界共振周波数 ($f_0$)**: $5.0\text{ Hz}$（$\omega_0 = 2\pi f_0 \approx 31.416\text{ rad/s}$）
* **真空空間減衰比 ($\zeta$)**: $0.03$（大気摩擦のない深宇宙微小減衰）
* **公称基準初期張力 ($T_0$)**: $10,000.0\text{ N}$
* **ケーブル許容限界張力 ($T_{\max}$)**: $15,000.0\text{ N}$（破断リミット・即時失格）
* **張力応力換算係数 ($k_{\text{vib}}$)**: $1,200.0\text{ N/m}$（横振動 $1\text{cm}$ あたり $+12\text{N}$ の張力増加）

### (2) 昇降機・テザー連成運動方程式
昇降機の登坂位置 $x(t)$ と、ケーブルの横振動変位 $y_{\text{vib}}(t)$ は以下の連成微分方程式系として振る舞います：

$$M \ddot{x} + F_{\text{drag}} = F_{\text{drive}}(t)$$

$$\ddot{y}_{\text{vib}} + 2\zeta \omega_0 \dot{y}_{\text{vib}} + \omega_0^2 y_{\text{vib}} = K_{\text{jerk}} \cdot \frac{d F_{\text{drive}}}{dt}$$

$$T(t) = T_0 + M \cdot \max(0, \ddot{x}) + k_{\text{vib}} \cdot |y_{\text{vib}}(t)|$$

* **ジャーク励起係数 ($K_{\text{jerk}}$)**: $0.00015\text{ m}/(\text{N/s})$
* 急激な推力ステップ（$\Delta F / \Delta t$ が大）を与えるほど、テザーに大きな横変位が励起され張力 $T(t)$ が跳ね上がります。

### (3) 推進・アクチュエータ出力仕様 & 制御換算式
制御レジスタ（MMIO）は実機FPGA互換の 32-bit 符号付き Q16.16 固定小数点形式（$1.0 = \text{0x00010000} = 65,536$）です。

#### ① デュアル・ピンチローラ駆動モータ (`thrust_cmd_x`)
* **レジスタ換算式**:
  $$F_{\text{drive}} = \frac{\text{thrust\_cmd\_x}}{65,536} \times 50.0\text{ N} \quad (-50.0\text{ N} \le F_{\text{drive}} \le +50.0\text{ N})$$
* **最大登坂加速度**:
  $$a_{x,\max} = \frac{F_{\text{drive},\max}}{M} = \frac{50.0\text{ N}}{100.0\text{ kg}} = 0.50\text{ m/s}^2$$

#### ② 電力量（バッテリー）消費モデル
$$\frac{d(\text{Battery})}{dt} = - |F_{\text{drive}}| \times 0.0003 \quad [\%/\text{s}]$$

### (4) 3D サイバーグラフィックモデル (Cyber Orbit Viewer)
Web ダッシュボードの 3D ビューアでは、Stage 2 専用の立体モデルが自動ロードされます：
1. **テザークライマー機体**: 中央観測ゴンドラポッド、ケーブルを上下から挟み込むデュアルピンチローラー駆動部、左右ソーラーアレイ翼、稼働状態インジケータ LED。
2. **GEO 静止軌道ステーション**: 高度 100m 地点に配置された巨大回転式トーラスドッキングステーション。
3. **小惑星採掘基地**: 高度 0m 起点に配置された 3D ワイヤーフレーム小惑星ロックおよびテザーアンカービーコン。

---

## 3. ハードウェア・レジスタマップ (Memory-Mapped I/O)

| オフセット | レジスタシンボル | R/W | 幅 | 物理的意味 / Stage 2 固有機能 |
| :---: | :--- | :---: | :---: | :--- |
| `0x00` | `CR_CTRL` | R/W | 32-bit | 制御レジスタ（Bit 0: シミュレーション実行イネーブル `1`） |
| `0x04` | `SR_STATUS` | RO | 32-bit | ステータス（Bit 0: 実行中, Bit 1: ケーブル破断フラグ） |
| `0x08` | `SENSOR_RAW` | RO | 32-bit | 振動光度センサ ADC 値 |
| `0x0C` | `SENSOR_EDGE` | RO | 32-bit | **1mピッチ高度光学マーク通過累積カウント** |
| `0x10` | `THRUST_CMD_X` | R/W | 32-bit | **ピンチモータ昇降推力指令 (Q16.16: -50N〜+50N)** |
| `0x20` | `SAFETY_LIMIT` | R/W | 32-bit | 過大張力安全保護リミット設定 (Q16.16) |
| `0x24` | `WATCHDOG_KICK`| WO | 32-bit | ハードウェア・ウォッチドッグキック（`1` 書き込みでリセット） |
| `0x28` | `CHAOS_FAULT_INJ`| R/W | 32-bit | FDIR 状態 / カオス障害注入コード |
| `0x80` | `OFFICIAL_SCORE` | RO | 32-bit | 公式審判確定スコア (pts) |
| `0x84` | `PASSED_GATES` | RO | 32-bit | 通過済ビーコン数 (0〜9) |
| `0x88` | `MISSION_STATUS`| RO | 32-bit | 状態 (0: ACTIVE, 1: COMPLETE, 2: FAILED) |

---

## 4. テレメトリ JSON 構造仕様 (`/tmp/space_guidance_telemetry.json`)

物理デーモンから 50Hz で配信される JSON ファイルには公式審判フィールドが含まれます：

```json
{
  "stage_id": 2,
  "pos_x": 45.2,
  "vel_x": 2.25,
  "cross_track_err": 0.015,
  "cable_tension": 10243.5,
  "cable_vibration": 0.015,
  "cable_snapped": 0,
  "fuel": 99.4,
  "score": 4000,
  "checkpoint_score": 4000,
  "bonus_score": 0,
  "passed_checkpoints": 4,
  "total_checkpoints": 9,
  "mission_status": "ACTIVE",
  "official_grade": "IN_FLIGHT",
  "last_event": "[BEACON 04] Alt=40.0m | Vib= 1.5cm | Tension=10244N | PERFECT +1000 pts | Score: 4000 pts",
  "elapsed_time": 21.4
}
```

---

## 5. ゲームプレイループと攻略ガイド

### (1) 編集対象ファイル
```text
~/.fbb/plugins/SpaceGuidance-FBB/scenario/02_tether_climber/pilot.py
（※ローカル開発環境の場合は /workspaces/SpaceGuidance-FBB/scenario/02_tether_climber/pilot.py）
```
（原本への初期化・リセットは `examples/mission02_baseline_climber.py` からコピー可能）

### (2) 攻略の核心
1. **S字加減速 (Jerk Limiting)**: 推力変化幅 `max_accel_step` を制限し、テザーの 5.0Hz 共振モード励起を抑止。
2. **逆位相ダンピング (Active Damping)**: 横振動変位 `vibration` を打ち消す逆位相フィードバック。

### (3) TUNE ZONE チューニング
```python
target_velocity = 2.4      # 目標登坂巡航速度 (m/s) [推奨: 2.0 〜 2.6]
kp_speed = 0.85            # 速度追従比例ゲイン
max_accel_step = 0.04      # S字加減速ジャーク制限 (1ステップあたりの最大推力変化幅)
kvib_damping = 0.40        # テザー横振動ダンピングゲイン [推奨: 0.30 〜 0.60]
```

---

## 6. 採点基準 & 公式審判システム (Official Referee SSOT)

標高 100m 地点の GEO Orbital Platform 到達時に公式審判によって総合判定されます：

$$\text{Final Score} = \text{Beacon Score} + \text{Time Bonus} + \text{Stability Bonus} + \text{Battery Bonus}$$

### (1) 配点内訳
1. **ビーコン通過精度 (全9箇所: 10m 〜 90m)**:
   * 横変位 $|y_{\text{vib}}| \le 0.02\text{m}$: **PERFECT (+1,000 pts)**
   * 横変位 $|y_{\text{vib}}| \le 0.06\text{m}$: **GREAT (+800 pts)**
   * 横変位 $|y_{\text{vib}}| \le 0.12\text{m}$: **GOOD (+500 pts)**
   * 横変位 $> 0.12\text{m}$: **SHAKE (-200 pts)**
2. **タイムボーナス**:
   $$\text{Time Bonus} = \max(0, (55.0 - \text{Clear Time}) \times 50.0)$$
3. **張力安定性ボーナス**:
   $$\text{Stability Bonus} = \max(0, (15,000.0 - T_{\text{peak}}) \times 0.1)$$
4. **バッテリー残量ボーナス**:
   $$\text{Battery Bonus} = \text{Battery}(\%) \times 10.0$$
5. **ケーブル断裂失格**: 張力が $15,000\text{ N}$ を超えた瞬間に即座に失格・スコア 0 点。

### (2) フライトランク認定基準
* 🏆 **GRADE S (Master Climber)**: **8,000 pts 以上**（9ゲートほぼPERFECTかつ安定登坂）
* 🥇 **GRADE A (Certified)**: 6,500 pts 以上
* 🥈 **GRADE B (Standard)**: 5,000 pts 以上
* 🥉 **GRADE C (Pass)**: 5,000 pts 未満

---

## 7. クイックスタート

```bash
# Web 3D 観戦モード (F-BB 統合ラボ)
# F-BB 統合 CLI による起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/02_tether_climber

# （ローカル開発環境の場合）
# ./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/02_tether_climber

# CLI 高速実行モード
bash scenario/02_tether_climber/run_mission.sh
```
