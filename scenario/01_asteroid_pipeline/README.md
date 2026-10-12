# Stage 1: 小惑星パイプライン巡回 (Asteroid Pipeline Inspector)

**難易度: Level 1 (入門) | 物理空間: 2D微小重力・無摩擦平面**

---

## 1. ミッション概要 (Mission Overview)

不規則な微小重力小惑星の表面に敷設された燃料輸送パイプライン（反射テープライン）に沿って自律宇宙探査機を航行させ、配管の亀裂や損傷を全9箇所のチェックポイントゲートで検査・通過するミッションです。

完全無摩擦の宇宙空間では、地上ロボットのような車輪の摩擦ブレーキが存在しません。一度加速すると慣性で直進し続けるため、**メインエンジン、ラテラルRCS、姿勢制御RCS、および電気駆動の内蔵リアクションホイール**を巧みに協調させ、S字カーブのパイプラインに沿ってドリフトせずに高精度追従することが求められます。

---

## 2. 機体仕様・搭載ハードウェア (Hardware Specs)

本シナリオで運用される自律宇宙探査機は、実機 FPGA（AMD Xilinx Zynq-7000 / Kria KV260）への移植を前提とした本格的なハードウェア・センサ・アクチュエータ構成を備えています。物理シミュレーションは完全無摩擦・微小重力の真空中剛体として、100Hz（$\Delta t = 0.01\text{s}$）周期で運動方程式を数値積分しています。

### (1) 機体物理諸元 (Physical Properties)
* **乾燥質量 ($M$)**: $100.0\text{ kg}$（中型自律深宇宙探査機クラス）
* **ヨー軸慣性モーメント ($I_{zz}$)**: $25.0\text{ kg}\cdot\text{m}^2$
* **幾何学的回転半径 (Radius of Gyration)**: $r_g = \sqrt{I_{zz} / M} = \sqrt{25.0 / 100.0} = 0.50\text{ m}$
* **機体寸法**: 全長 $3.5\text{m}$（機首センサ端〜テールノズル後端）, 全幅 $3.6\text{m}$（翼端RCSポッド間）
* **力学環境**: 完全無摩擦・微小重力の深宇宙軌道空間（ニュートンの運動方程式に基づく慣性航行）

### (2) 推進・アクチュエータ系出力仕様 & 制御入力換算式
探査機の推進制御レジスタ（MMIO）は、実機FPGA互換の 32-bit 符号付き Q16.16 固定小数点形式（$1.0 = \text{0x00010000} = 65,536$）を採用しています。Python や C 言語で制御器を設計する際は、正規化指令値 $u \in [-1.0, +1.0]$ を書き込むことで、物理エンジンが以下の実世界物理量へ換算して推進力・トルクを発生させます。

#### ① メイン推進スラスタ (Dual Aft Main Engines: `thrust_cmd_x`)
* **配置**: 機体尾部後端にツイン配置（`Nozzle L`, `Nozzle R`）。
* **レジスタ換算式**:
  $$F_x = \frac{\text{thrust\_cmd\_x}}{65,536} \times 50.0\text{ N} \quad (-50.0\text{ N} \le F_x \le +50.0\text{ N})$$
* **最大並進加速度**:
  $$a_{x,\max} = \frac{F_{x,\max}}{M} = \frac{50.0\text{ N}}{100.0\text{ kg}} = 0.50\text{ m/s}^2$$

#### ② ラテラル並進スラスタ (Lateral Translation RCS: `thrust_cmd_y`)
* **配置**: 機首・翼端の4箇所スラスタポッド。
* **レジスタ換算式**:
  $$F_y = \frac{\text{thrust\_cmd\_y}}{65,536} \times 50.0\text{ N} \quad (-50.0\text{ N} \le F_y \le +50.0\text{ N})$$
* **最大横加速度**:
  $$a_{y,\max} = \frac{F_{y,\max}}{M} = \frac{50.0\text{ N}}{100.0\text{ kg}} = 0.50\text{ m/s}^2$$

#### ③ RCS 姿勢制御スラスタ (Attitude RCS Thrusters: `torque_cmd`)
* **配置**: 翼端および機首の対向偶力ノズル群。
* **レジスタ換算式**:
  $$\tau_{\text{rcs}} = \frac{\text{torque\_cmd}}{65,536} \times 20.0\text{ N}\cdot\text{m} \quad (-20.0\text{ N}\cdot\text{m} \le \tau_{\text{rcs}} \le +20.0\text{ N}\cdot\text{m})$$
* **最大角加速度**:
  $$\alpha_{\text{rcs},\max} = \frac{\tau_{\text{rcs},\max}}{I_{zz}} = \frac{20.0\text{ N}\cdot\text{m}}{25.0\text{ kg}\cdot\text{m}^2} = 0.80\text{ rad/s}^2 \approx 45.84^\circ/\text{s}^2$$

#### ④ 内蔵リアクションホイール (Internal Reaction Wheel: `wheel_torque_cmd`)
* **配置**: 機体重心（CoM: $X=0.0\text{m}, Y=0.0\text{m}$）に同軸搭載された電動フライホイール。
* **推進剤消費ゼロ**: バッテリー電力のみで駆動し、燃料（Delta-V）を一切消費せずに精密な角運動量制御を実現。
* **ホイール物理特性**:
  * フライホイール慣性モーメント: $I_w = 0.02\text{ kg}\cdot\text{m}^2$
  * 定格・限界回転数: $\pm 6,000\text{ RPM} \implies \omega_{w,\max} = 6000 \times \frac{2\pi}{60} \approx 628.32\text{ rad/s}$
* **反作用トルク (Newton's 3rd Law)**:
  $$\tau_{\text{wheel}} = \frac{\text{wheel\_torque\_cmd}}{65,536} \times 20.0\text{ N}\cdot\text{m}, \quad \tau_{\text{body}} = -\tau_{\text{wheel}}$$

#### ⑤ 推進剤（燃料）消費モデル
$$\frac{d(\text{Fuel})}{dt} = - \left( |F_x| + |F_y| + |\tau_{\text{rcs}}| \right) \times 0.0005 \quad [\%/\text{s}]$$

### (3) センサ系
* **8ch 光学センサアレイバー**:
  * 機首前方 0.5m に搭載（4bit ADC × 8ch、各ch間隔 0.05m、全幅 0.35m）。
  * パイプライン中心線（再帰反射ガイドレール）の光度ピークを検知。
* **FPGA RTL重心演算回路 (`line_sensor_filter.v`)**:
  * ハードウェア回路が幾何学的重心をナノ秒で計算し、偏差（`ADDR_SENSOR_EDGE`: `0x43C0000C`、Q16.16: -1.0〜+1.0）として出力。

---

## 3. ゲームプレイループとハッキングガイド

### (1) 編集対象ファイル
プレイヤーがアルゴリズムやパラメータをチューニングする対象ファイル：
```text
/workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline/pilot.py
```

### (2) 即時反映のやり方 (Rapid Re-flight Loop)
1. VS Code で `scenario/01_asteroid_pipeline/pilot.py` を開きます。
2. 後述の **TUNE ZONE 1〜3** のゲインや巡航速度を書き換えて保存（`Ctrl + S`）します。
3. Webダッシュボード（`http://localhost:8080`）の **`Chaos & Fault Injection`** パネルにある **`[Restart Scenario]`** ボタンをクリックします。
4. 新しいパラメータで即座に探査機が発進し、3Dビューアおよびコンソールでスコアの変化を確認できます。

### (3) 初期状態へのリセット方法
```bash
cp /workspaces/SpaceGuidance-FBB/examples/mission01_baseline_pilot.py /workspaces/SpaceGuidance-FBB/scenario/01_asteroid_pipeline/pilot.py
```

---

## 4. アーケード採点・公式審判システム (Official Referee SSOT)

公平な競技性を保証するため、採点および合否判定は Python 側ではなく中央デーモン（`space_guidance_daemon.cpp`）の **`OfficialReferee` エンジン** が 100Hz 周期でオーソリテーティブに実施します。

$$\text{Final Score} = \text{Checkpoint Score} + \text{Fuel Bonus} + \text{Time Bonus}$$

### (1) ゲート通過精度配点 (全9ゲート: X=5m, 10m, ..., 45m)
| 判定レーティング | 許容偏差基準 | 獲得ポイント | 説明 |
| :--- | :--- | :---: | :--- |
| **PASS [PERFECT]** | 偏差 $\le 5.0\text{ cm}$ | **$+1,000 \text{ pts}$** | ゲート中心を完璧に捉えて通過 |
| **PASS [GREAT]** | 偏差 $\le 12.0\text{ cm}$ | **$+800 \text{ pts}$** | わずかなズレで良好に通過 |
| **PASS [GOOD]** | 偏差 $\le 20.0\text{ cm}$ | **$+500 \text{ pts}$** | ゲート枠内を安全に通過 |
| **CLIP [PENALTY]** | 偏差 $\le 40.0\text{ cm}$ | **$-300 \text{ pts}$** | ゲート外枠に接触（減点ペナルティ） |
| **MISS [PENALTY]** | 偏差 $> 40.0\text{ cm}$ | **$-1,000 \text{ pts}$** | ゲート通過失敗・枠外逸脱（大減点） |

### (2) ボーナス配点
* **残燃料ボーナス**: 残推進剤 $\% \times 10.0$（最大 $+1,000\text{ pts}$、リアクションホイール活用で最大化）
* **クリアタイムボーナス**: $50.0\text{s}$ 未満でゴール到達時：
  $$\text{Time Bonus} = \max(0, (50.0 - \text{Elapsed Time}) \times 40.0)$$

### (3) フライトランク認定基準
* 🏆 **GRADE S (Elite Pilot)**: **$8,000 \text{ pts}$ 以上**（全ゲートPERFECT級、ハイスピード巡航、燃料無消費）
* 🥇 **GRADE A (Certified)**: **$6,500 \sim 7,999 \text{ pts}$**（標準クリア）
* 🥈 **GRADE B (Standard)**: **$4,500 \sim 6,499 \text{ pts}$**
* 🥉 **GRADE C (Pass)**: **$4,500 \text{ pts}$ 未満**

---

## 5. 攻略用 3大チューニングゾーン (Tune Zones)

`pilot.py` 内のコメント領域 `=== TUNE ZONE ===` を書き換えてハイスコアを狙います：

### 🎯 TUNE ZONE 1: 姿勢制御・ライン追従ゲイン
```python
kp = 0.90    # 旋回比例ゲイン (ラインからのズレに応じた回頭トルク)
kd = 0.15    # 旋回微分ゲイン (S字カーブ入口・出口でのふらつき・ハンチング抑制)
kw = 0.65    # ジャイロ角速度ダンピング (無摩擦空間特有の回りすぎを抑制)
klat = 0.80  # 横移動 RCS 追従ゲイン (ラインへの横並進補正)
kvlat = 0.60 # 横滑り速度ダンピング (横揺れの収束を早める)
```

### 🚀 TUNE ZONE 2: 目標巡航速度
```python
target_vx = 1.2  # 目標巡航速度 (m/s) [タイム短縮と遠心力制御のトレードオフ]
```

### 🔋 TUNE ZONE 3: ハイブリッド制御 & リアクションホイール脱飽和
```python
# 5200 RPM以上で脱飽和開始、1800 RPM以下で通常復帰
if in_desat:
    if abs(wheel_rpm) < 1800.0:
        in_desat = False
else:
    if abs(wheel_rpm) > 5200.0:
        in_desat = True
```
