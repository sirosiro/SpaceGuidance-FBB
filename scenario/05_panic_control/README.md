# Stage EX: パニックコントロール (Panic Control: Debris Collision & Emergency Recovery)

**難易度: Level 5 (Extra / 最難関) | 物理空間: 完全無重力・無摩擦 ＋ 3軸高速カオスタンブリング ＋ 12基スラスタ欠損連成力学 ＋ 3軸リアクションホイール**

---

## 1. ミッション概要 (Mission Overview)

未探査宇宙デブリ帯を航行中の自律探査機が、突如として漂流スペースデブリの激しい直撃を受けました。

デブリ衝突の巨大な衝撃力積により、探査機は **3軸（ロール・ピッチ・ヨー）にわたる毎秒140度超（$|\vec{\omega}_0| \approx 2.5\text{ rad/s}$）の激しい高速カオスタンブリング（スピン）** に陥り、さらに機体に搭載された **12基の 6-DoF RCS パルススラスタのうち、衝突点近傍のノズル（1〜2基）が物理的に破損・不発** となりました。加えて、推進剤配管の損傷により燃料が時間とともに自然流出（微小リーク）しています。

完全無摩擦の宇宙空間では、何もしなければ探査機は永遠に回転し続け、燃料を失って宇宙の藻屑と化します。プレイヤーはジョイスティックによる手動操作を一切使わず、**自律制御スクリプト（`pilot.py`）** のみを用いて以下の4フェーズのリカバリーを成し遂げなければなりません：

```mermaid
graph TD
    P0["Phase 0: 衝突緊急事態検知 & プロローグ<br/>(4.5秒間の慣性タンブリング観察と角速度計測)"] --> P1["Phase 1: 3軸緊急デタンブル<br/>(3軸RW最大逆トルク & RCSレートダンピング制動)"]
    P1 --> P2["Phase 2: 12チャンネル・オンラインSysID<br/>(マイクロパルス噴射による破損ノズル自動特定)"]
    P2 --> P3["Phase 3: 制御配分 & 6-DoF安全圏脱出<br/>(非対称推力最適化 ＆ 視線誘導によるグリーン安全ゲート通過)"]
```

---

## 2. 機体仕様・12基 6-DoF RCS スラスタ配置 & 3軸リアクションホイール

探査機には、機体全周に対向配置された **12基の RCS パルススラスタ（$F_{\max} = 20.0\text{ N}$）** と、X/Y/Z 各軸の角運動量を電気駆動（燃料消費ゼロ）で吸収する **3軸リアクションホイール・クラスタ** が搭載されています。

![Spacecraft Hardware Layout (12-Thruster 6-DoF & 3-Axis RW)](images/spacecraft_hardware_layout.svg)

### (1) 全12基スラスタの公称発生力・トルク特性

| ノズル番号 | 機体配置座標 $\vec{r}_i$ [m] | 噴射方向 $\vec{n}_i$ | 発生推力 $\vec{F}$ | 発生トルク $\vec{\tau}$ | 主な役割 |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **T0** | $(-1.3, -1.0, 0.0)$ | $(+1, 0, 0)$ [前進] | $+20.0\text{ N}$ ($+X$) | $\tau_z = -20.0\text{ N}\cdot\text{m}$ (時計回り) | 前進推進 / ヨー右旋回 |
| **T1** | $(-1.3, +1.0, 0.0)$ | $(+1, 0, 0)$ [前進] | $+20.0\text{ N}$ ($+X$) | $\tau_z = +20.0\text{ N}\cdot\text{m}$ (反時計回り) | 前進推進 / ヨー左旋回 |
| **T2** | $(+1.0, -0.6, 0.0)$ | $(-1, 0, 0)$ [後進] | $-20.0\text{ N}$ ($-X$) | $\tau_z = +20.0\text{ N}\cdot\text{m}$ (反時計回り) | 後進制動 / ヨー左旋回 |
| **T3** | $(+1.0, +0.6, 0.0)$ | $(-1, 0, 0)$ [後進] | $-20.0\text{ N}$ ($-X$) | $\tau_z = -20.0\text{ N}\cdot\text{m}$ (時計回り) | 後進制動 / ヨー右旋回 |
| **T4** | $(-1.0, -1.8, 0.0)$ | $(0, +1, 0)$ [左舷] | $+20.0\text{ N}$ ($+Y$) | $\tau_z = -20.0\text{ N}\cdot\text{m}$ (時計回り) | 左舷横移動 / ヨー右旋回 |
| **T5** | $(+0.8, -0.65, 0.0)$| $(0, +1, 0)$ [左舷] | $+20.0\text{ N}$ ($+Y$) | $\tau_z = +20.0\text{ N}\cdot\text{m}$ (反時計回り) | 左舷横移動 / ヨー左旋回 |
| **T6** | $(-1.0, +1.8, 0.0)$ | $(0, -1, 0)$ [右舷] | $-20.0\text{ N}$ ($-Y$) | $\tau_z = +20.0\text{ N}\cdot\text{m}$ (反時計回り) | 右舷横移動 / ヨー左旋回 |
| **T7** | $(+0.8, +0.65, 0.0)$| $(0, -1, 0)$ [右舷] | $-20.0\text{ N}$ ($-Y$) | $\tau_z = -20.0\text{ N}\cdot\text{m}$ (時計回り) | 右舷横移動 / ヨー右旋回 |
| **T8** | $(+1.25, 0.0, +0.5)$| $(0, 0, +1)$ [背面] | $+20.0\text{ N}$ ($+Z$) | $\tau_y = -25.0\text{ N}\cdot\text{m}$ (ピッチダウン) | 垂直上昇 / ピッチ下げ |
| **T9** | $(+1.25, 0.0, -0.5)$| $(0, 0, -1)$ [腹面] | $-20.0\text{ N}$ ($-Z$) | $\tau_y = +25.0\text{ N}\cdot\text{m}$ (ピッチアップ) | 垂直降下 / ピッチ上げ |
| **T10**| $(-1.25, 0.0, +0.5)$| $(0, 0, +1)$ [背面] | $+20.0\text{ N}$ ($+Z$) | $\tau_y = +25.0\text{ N}\cdot\text{m}$ (ピッチアップ) | 垂直上昇 / ピッチ上げ |
| **T11**| $(-1.25, 0.0, -0.5)$| $(0, 0, -1)$ [腹面] | $-20.0\text{ N}$ ($-Z$) | $\tau_y = -25.0\text{ N}\cdot\text{m}$ (ピッチダウン) | 垂直降下 / ピッチ下げ |

### (2) 物理諸元 (Spacecraft Dynamics & Limits)

* **乾燥質量 ($M$)**: $100.0\text{ kg}$
* **主慣性モーメント**:
  * ロール軸慣性モーメント ($I_{xx}$): $15.0\text{ kg}\cdot\text{m}^2$
  * ピッチ軸慣性モーメント ($I_{yy}$): $20.0\text{ kg}\cdot\text{m}^2$
  * ヨー軸慣性モーメント ($I_{zz}$): $25.0\text{ kg}\cdot\text{m}^2$
* **3軸リアクションホイール・クラスタ**:
  * 各軸慣性モーメント ($I_w$): $0.05\text{ kg}\cdot\text{m}^2$
  * 許容限界回転数: $\pm 6,000\text{ RPM}$ (電気駆動・推進剤消費ゼロ)
* **推進剤自然リーク率**: $-0.15\text{ \%/s}$（放置すると約50秒で燃料枯渇失格）
* **安全脱出境界**: $X \ge 35.0\text{ m}$
  * **グリーン安全ゲート判定**: $|Y| \le 6.0\text{ m}$ かつ $|Z| \le 6.0\text{ m}$ の範囲内で脱出ラインを通過すると高額ボーナス獲得。

---

## 3. デブリ衝突力学 & カオスインジェクション (Procedural Chaos Injection)

本ステージでは、カオスシード（乱数シード）に基づき、**完全シミュレートされた 3D 衝突物理** が決定論的に生成されます：

```text
[カオスシード Seed (32-bit)]
          │
          ├──> 飛来方位角 Azimuth: -180° 〜 +180° (全天360度)
          ├──> 飛来仰角 Elevation: -30° 〜 +30°
          ├──> 機体表面衝突点 r_imp: (ix, iy, iz)
          ├──> 衝突速度ベクトル v_deb (~32 m/s)
          │      ├── 並進ドリフト積: ΔV = (m_deb / M) * v_deb
          │      └── 回転角運動量積: J = r_imp × P_deb
          │            └── 3軸初期タンブリング率: Δω = I^(-1) * J
          └──> 衝突点近接スラスタ判定 (最短ユークリッド距離の 1〜2 基が破損・機能停止)
```

### (1) シードの指定方法

* **公式ベースラインシード (`0x1337`)**:
  * Starboard-Aft（右舷後方斜め上）から飛来。
  * **T1（前進右）および T6（右舷後部）の2基が破損**。
  * CI 自動テストおよび基準性能測定で常に再現性 100% を保証します。
* **任意シード指定**:
  * CLI 引数 `--seed <HEX>` または環境変数 `FBB_CHAOS_SEED=<HEX>` で任意の飛来方向・衝突条件を指定可能。
  * 引数未指定時は起動毎に動的ランダムシードが自動採番され、全方向からの飛来・破損バリエーションをテストできます。

---

## 4. ハードウェア・レジスタマップ & 制御インターフェース

F-BB 共有メモリ `/tmp/fbb_space_guidance_shm`（実機では AMD Xilinx Zynq UIO デバイス `/dev/uio0`）を介して通信します。

### (1) コマンドレジスタマップ (Host -> Hardware)

| オフセット | レジスタ名 | 型 / 単位 | 説明 |
| :---: | :---: | :---: | :--- |
| `0x10` | `thrust_cmd_x` | Q16.16 [N] | 推進力 X コマンド（前進 / 後進） |
| `0x14` | `thrust_cmd_y` | Q16.16 [N] | 推進力 Y コマンド（ポート / スターボード横移動） |
| `0x18` | `thrust_cmd_z` | `uint32` (Bitmask) | **ノズル直接パルス噴射マスク**（Bit $0 \sim 11$ が T0〜T11 に対応） |
| `0x1C` | `torque_cmd` | Q16.16 [$\text{N}\cdot\text{m}$] | RCS ヨー軸トルク指令 |
| `0x24` | `watchdog_kick`| `uint32` | ウォッチドッグタイマ生存キック（周期的に 1 をライト） |
| `0x28` | `chaos_fault_inj` | `uint32` | カオスインジェクション・シードレジスタ |
| `0x2C` | `wheel_torque_cmd` | Q16.16 [$\text{N}\cdot\text{m}$] | リアクションホイール Z軸（ヨー制動）トルク指令 |
| `0x78` | `fdir_mode` | `uint32` | FDIR 状態通知（0: Panic, 1: Detumble, 2: SysID, 3: Escape） |
| `0x90` | `torque_x` | Q16.16 [$\text{N}\cdot\text{m}$] | 拡張 6-DoF: RCS ロールトルク指令 |
| `0x94` | `torque_y` | Q16.16 [$\text{N}\cdot\text{m}$] | 拡張 6-DoF: RCS ピッチトルク指令 |
| `0x98` | `wheel_torque_x` | Q16.16 [$\text{N}\cdot\text{m}$] | 拡張 6-DoF: リアクションホイール X軸（ロール制動）トルク指令 |
| `0x9C` | `wheel_torque_y` | Q16.16 [$\text{N}\cdot\text{m}$] | 拡張 6-DoF: リアクションホイール Y軸（ピッチ制動）トルク指令 |
| `0xA0` | `thrust_vertical`| Q16.16 [N] | 拡張 6-DoF: 垂直推力 Z コマンド |

### (2) Python 制御 API (`SpaceGuidanceHardware`)

`pilot.py` から標準提供されている高水準 API を呼び出して制御します：

```python
hw = SpaceGuidanceHardware()

# 1. テレメトリ取得 (3D姿勢・角速度・ホイール回転数・健全性マスク含む)
tlm = hw.read_registers()
# tlm["pos_x"], tlm["pos_y"], tlm["pos_z"]
# tlm["roll"], tlm["pitch"], tlm["yaw"]
# tlm["omega_x"], tlm["omega_y"], tlm["omega_z"]
# tlm["wheel_rpm_x"], tlm["wheel_rpm_y"], tlm["wheel_rpm_z"]
# tlm["thruster_health"] (0x0FFF: 全12基正常)

# 2. 3軸リアクションホイール専用指令 (推進剤消費ゼロ)
hw.write_reaction_wheel(wheel_torque_z, wheel_torque_x=0.0, wheel_torque_y=0.0)

# 3. ノズル単発マイクロパルス噴射 (SysID用)
hw.write_thruster_pulse(1 << nozzle_id)

# 4. 複合制御コマンド書き込み
hw.write_commands(
    thrust_x=0.0, thrust_y=0.0, torque=rcs_torque_z,
    wheel_torque=wheel_torque_z, fdir_mode=3,
    thrust_z=active_burn_mask, # 生存ノズルマスク
    wheel_torque_x=wheel_cmd_x, wheel_torque_y=wheel_cmd_y
)

# 5. ウォッチドッグ更新
hw.kick_watchdog()
```

---

## 5. 攻略手順：自律復旧 4大フェーズ (Recovery Sequence Walkthrough)

### Phase 0: 衝突緊急事態検知 & プロローグ観察 (T = 0 〜 4.5s)
衝突直後は巨大な衝撃力積により 3軸タンブリングが発生しています。
* 最初の 4.5 秒間は機体のセンサ値（$\omega_x, \omega_y, \omega_z$）をサンプリングし、回転レートを正確に把握します。
* この間、Orbit Viewer 上では衝突ショックウェーブ、破片火花、ノズル破損を示す赤色ブラケット、燃料蒸気のリーク軌跡が可視化されます。

### Phase 1: 3D緊急デタンブル (Rate Damping & 3-Axis RW)
* **3軸リアクションホイール最大トルク制動**:
  各軸の角速度と逆向きに最大トルクを印加し、角運動量をホイールに逃がします（**燃料消費 0%**）。
* **RCS レートダンピング逆噴射**:
  残留スピンに対して逆トルク噴射を行い、**全軸の角速度ノルム $|\vec{\omega}| < 0.05\text{ rad/s}$** を 0.5 秒以上維持することでデタンブル完了マイルストーンを達成します。

### Phase 2: 12チャンネル・オンライン・システム同定 (Online SysID)
静止後、全12基のスラスタを順次 30ms 程度微小パルス噴射（`hw.write_thruster_pulse(1 << i)`）し、IMU の角加速度応答 $\Delta \vec{\omega}$ を計測します：
* 健全ノズル: 明確な回転応答（$|\Delta \vec{\omega}| > 0.012\text{ rad/s}$）が観測される。
* 破損ノズル: **応答ゼロ**。
* 健全と確認できたノズル番号を「生存ノズルセット」として記録します。

### Phase 3: 制御配分 & 6自由度安全圏脱出 (Control Allocation & Escape)
生存ノズルのみを組み合わせて「不要な回転トルクを相殺しつつ $+X$ 前進加速を得る」推力配分を計算します：
* **姿勢アライメント**: 3軸リアクションホイールでロール・ピッチを常にゼロ位ロックしつつ、ヨー姿勢を目標方向に保持。
* **視線誘導 (Line-of-Sight Guidance)**: 脱出ライン通過時にグリーン安全ゲート（$|Y| \le 6.0\text{m}, |Z| \le 6.0\text{m}$）の中心へ向かうよう横方向ドリフトを補正。
* **二次デブリ回避**: 浮遊する周囲のデブリ（半径 1.5m 判定）との再衝突を回避しながら $X \ge 35.0\text{m}$ へ脱出します。

---

## 6. 採点基準 & 公式審判システム (Official Referee SSOT)

物理デーモン内の `OfficialReferee` エンジンが 100Hz 周期でオーソリテーティブに判定します：

$$\text{Final Score} = \text{Checkpoint Score} + \text{Bonus Score}$$

### (1) チェックポイント得点 (Checkpoint Score: 最大 4,000 pts)

| マイルストーン | 判定条件 | 配点 | 備考 |
| :--- | :--- | :---: | :--- |
| **Check 1: デタンブル達成** | $\|\vec{\omega}\| < 0.05\text{ rad/s}$ を 0.5 秒保持 | **最大 $+3,000\text{ pts}$** | $\max(0, (15.0\text{s} - T_{\text{detumble}}) \times 200)$ |
| **Check 2: 巡航ウェイポイント** | 安定姿勢で $X \ge 15.0\text{m}$ 通過 | **$+1,000\text{ pts}$** | SysID 完了および安定加速の確認 |

### (2) ボーナス得点 (Bonus Score: 最大 7,500 pts)

| 評価項目 | 判定条件 | 配点 | 備考 |
| :--- | :--- | :---: | :--- |
| **脱出成功基本点** | 安全境界 $X \ge 35.0\text{m}$ 到達 | **$+1,000\text{ pts}$** | ベースクリア |
| **安全ゲート中心精度ボーナス** | 脱出時の中心軸距離 $r = \sqrt{Y^2 + Z^2}$ | **最大 $+2,500\text{ pts}$** | $r \le 1.0\text{m}$ (BULLSEYE): +2500<br>$r \le 2.5\text{m}$ (EXCELLENT): +1800<br>$r \le 4.5\text{m}$ (GOOD): +1200<br>$r \le 7.0\text{m}$ (MARGINAL): +500 |
| **推進剤残量ボーナス** | 残燃料 $(\%) \times 25.0$ | **最大 $+2,500\text{ pts}$** | RW 併用・無駄なキャンセル噴射削減で高得点 |
| **デブリ回避ボーナス** | 浮遊デブリへの再接触回数 | **最大 $+1,500\text{ pts}$** | 0回: +1500点, 1〜2回: +500点, 3回以上: 0点 |

> **理論最大得点: $11,000\text{ pts}$**

### (3) フライトランク認定基準

* 🏆 **GRADE S (Elite Astronaut)**: **8,000 pts 以上**（超高速デタンブル、残燃料70%以上、安全ゲート中央通過、デブリ完全回避）
* 🥇 **GRADE A (Certified)**: 6,500 〜 7,999 pts
* 🥈 **GRADE B (Standard)**: 5,000 〜 6,499 pts
* 🥉 **GRADE C (Pass)**: 5,000 pts 未満
* 💀 **FAILED**: 推進剤枯渇（燃料 0% 到達）または脱出不能

---

## 7. ゲームプレイ・攻略チューニングガイド (Gameplay & Pilot Tuning Guide)

プレイヤーは、Web ダッシュボード右側の専用エディタペイン（**SG Pilot Code Editor**）またはローカルエディタで `pilot.py` 内のパラメータを書き換え、ハイスコア（GRADE S: 8,000 pts 以上）を目指してチューニングを行います。

### (1) チューニングの基本ループ (Rapid Tune Loop)
1. Web ダッシュボード（`http://localhost:8080`）を開きます。
2. **SG Pilot Code Editor** ペインの `[🎯 Jump to Zone...]` ドロップダウンから調整したいゾーンを選択します。
3. パラメータの数値を書き換えて **`[💾 Save]`（または `Ctrl + S`）** を押します（`Saved ✓` が点灯）。
4. ダッシュボード上部の **`[Restart Scenario]`** ボタンをクリックして、新しい制御則で再発進させます。
5. パラメータ変更で挙動が破綻した場合は、いつでも **`[↩ Revert Original]`** ボタンを押せば、公式ベースライン設定へ即座に完全復元できます。

---

### (2) TUNE ZONE 1: デタンブル制動ゲイン (激スピン制振フェーズ)

被弾直後の高速カオスタンブリング（毎秒140度超のスピン）を静止させるための制御パラメータです（`pilot.py` 40〜43行目）：

```python
# === TUNE ZONE 1: デタンブル制動ゲイン ===
kd_detumble = 2.5        # レートダンピングゲイン (RCS スラスタ)
rw_gain = 1.0            # リアクションホイール最大トルク比率
```

| パラメータ | 調整方向 | 機体の物理的反応 | メリット | デメリット・リスク |
| :--- | :---: | :--- | :--- | :--- |
| **`kd_detumble`**<br>(RCS 逆噴射) | **大きくする**<br>($2.5 \to 5.0 \sim 8.0$) | RCS スラスタが激しく逆噴射し、巨大な制動力が発生。 | **爆速でスピン停止（1〜2秒）**。<br>デタンブル達成速度点（最大 +3,000 pts）が最大化。 | 推進剤（燃料）を大量浪費し残燃料ボーナス激減。<br>停止直前にスラスタが微振動（チャタリング）。 |
| | **小さくする**<br>($2.5 \to 0.5 \sim 0.0$) | RCS をほぼ吹かず、電気駆動のリアクションホイール（RW）中心で静かに制動。 | **推進剤消費ゼロ**。<br>残燃料ボーナス（最大 +2,500 pts）を狙える。 | 制動時間が大幅に増加。<br>ホイール限界回転数（$\ge 5,000\text{ RPM}$）に達して **`[RW SATURATED]`** を引き起こすと、スピンを止めきれず漂流失格。 |
| **`rw_gain`**<br>(ホイール比率) | **$1.0$ (推奨)** | 3軸ホイールのモータートルクを 100% フル活用。 | 燃料消費ゼロで角運動量を最速吸収。 | ハードウェア上限（$\pm 1.0$）でクランプされます。 |

> 💡 **攻略のスイートスポット**:  
> `kd_detumble = 1.4 〜 1.8` 付近に調整すると、「リアクションホイールで角運動量を限界まで吸い取りつつ、ホイールが飽和する直前だけ RCS で最小限叩く」という高効率なプロ級制動が成立し、デタンブル点と残燃料点の両取りが可能になります。

---

### (3) TUNE ZONE 2: 脱出巡航パラメータ (安全ゲート突破フェーズ)

健全スラスタ群を使った脱出バーンの目標前進巡航速度です（`pilot.py` 44〜46行目）：

```python
# === TUNE ZONE 2: 脱出巡航パラメータ ===
escape_speed_target = 1.8 # 目標脱出速度 (m/s)
```

| 設定値 | 機体の物理的反応 | メリット | デメリット・リスク |
| :--- | :--- | :--- | :--- |
| **高速化**<br>($1.8 \to 3.0 \sim 4.5\text{ m/s}$) | 生存スラスタがロングバーンを継続し、高速ロケットのようにデブリ帯を突き抜ける。 | **最速脱出によるタイムボーナス大**。<br>配管からの燃料リーク被爆時間を最小化。 | スピード過多で横方向（Y/Z軸）の微調整が効かず、出口ゲート枠に激突して **`CLIP [PENALTY] (-300 pts)`** を食らうリスク急増。 |
| **低速化**<br>($1.8 \to 0.8 \sim 1.2\text{ m/s}$) | ゆったりと慎重に巡航。 | 視線誘導（Line-of-Sight）が完璧に機能し、ゲート中心 $r \le 1.0\text{m}$ の **`BULLSEYE (+2,500 pts)`** を確実に射抜ける。 | 脱出までに時間がかかるため、時間経過に伴う燃料自然流出（$-0.15\%/\text{s}$）で残燃料ボーナスが目減りする。 |

> 💡 **攻略のスイートスポット**:  
> `escape_speed_target = 2.0 〜 2.4 m/s` 付近が、「ゲート中央通過の精密性」と「燃料リーク損失の抑制」のバランスが最も優れた高得点ゾーンです。

---

### (4) 上級者向け隠しチューニングパラメータ (Advanced Flight Mechanics)

コード（245〜268 行目付近）を直接書き換えることで、さらに高度なフライトチューニングが可能です：

```python
# 1. コリドー中心 (Y=0, Z=0) への視線誘導引き戻しゲイン (245行目)
los_bias = 0.50 * vy_err - 0.25 * pos_y

# 2. リアクションホイールによる 3軸姿勢水平ロック PD ゲイン (252, 256, 257行目)
tau_rw_z = 1.5 * att_err - 0.8 * omega_z
wheel_cmd_x = max(-0.8, min(0.8, -1.5 * roll - 0.8 * omega_x))
wheel_cmd_y = max(-0.8, min(0.8, -1.5 * pitch - 0.8 * omega_y))

# 3. メイン推進の噴射許可「機首正対判定しきい値」 (266行目)
is_aligned = abs(att_err) < 0.16  # (約 9.1度)
```

* **`is_aligned` のしきい値変更**:
  * 緩める（`< 0.35` / 約20度）: 多少機首がブレていても構わず前進噴射するため、加速レスポンスが向上しますが、船体が斜めにドリフトします。
  * 厳しくする（`< 0.05` / 約2.8度）: 完全に正面を向いた瞬間だけ精密に噴射し、無駄な横滑りがゼロになります。
* **`los_bias` の係数変更**:
  * 横方向偏差（`pos_y`）の係数を `-0.40` などに強めると、デブリ直撃で大きく横へ吹き飛ばされた際の中心復帰力が強力になります。

---

### (5) カオスシードを変えて遊ぶ（多彩な被弾パターンの攻略）

本ステージは、シード値によって **「デブリ飛来角度」** と **「破壊されるスラスタの組み合わせ」** が決定論的に変化します：

* **公式ベースラインシード (`0x1337`)**:
  * Starboard-Aft（右舷後方斜め上）から被弾。**T1（前進右）と T6（右舷後部横）が破壊**。
  * 前進推力ペア（T0 + T5 等）を活用する標準攻略パターン。
* **シード `0xABCD`**:
  * 横スラスタ（ポート側）が集中的に被弾。姿勢制御トルクの非対称性が顕著に。
* **シード `0xCAFE`**:
  * ピッチ軸垂直ノズルが被弾。Z軸方向の姿勢乱れを 3軸リアクションホイールで抑え込む技量が試される。

ダッシュボード左側の **Chaos パネル** でシード値を変更してリスタートするか、CLI 引数 `--seed <HEX>` で未知の被弾シナリオへ挑戦できます！

---

## 8. 実行方法 & CLI オプション (Execution & Options)

### (1) Web 3D 統合ラボ (F-BB 統合環境)

```bash
# F-BB 統合ラボを起動 (ブラウザで http://localhost:8080 を開く)
./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/05_panic_control
```

* **Orbit Viewer**:
  * 3D チェイスカメラで宇宙船を追従。
  * デブリ飛来角・方位角 HUD 表示 (`SEED: 0xXXXX`, `INC: BOW/PORT/STBD/STERN (AZ°)`).
  * 破損ノズルの赤色ブラケット強調 & 推進剤白煙リークエフェクト。
  * 目標グリーン安全ゲートリング ($X = 35.0\text{m}, R = 6.0\text{m}$).
* **Chaos FDIR コンソール**:
  * リアルタイム角速度グラフ、12基スラスタの健全性ステータスマトリクス、審判スコアボードを表示。

### (2) CLI スタンドアロン実行

```bash
# 1. デフォルト実行 (起動毎に動的ランダムシードが生成されるモード)
bash scenario/05_panic_control/run.sh

# 2. 公式ベースラインシード (0x1337) で決定論的テスト (T1 & T6 破損)
bash scenario/05_panic_control/run.sh --seed 0x1337

# 3. 任意のカオスシードで未知の衝突方向・破損パターンをストレステスト
bash scenario/05_panic_control/run.sh --seed 0xCAFE

# 4. ヘッドレス・高速ミッション実行スクリプト
bash scenario/05_panic_control/run_mission.sh --seed 0x1337
```

---

## 9. 発展課題：他言語 (C++ / Rust) による自律操縦チャレンジ (Multi-Language Flight Software Challenge)

本プラグインでは標準の自律制御スクリプトとして Python（`pilot.py`）を提供していますが、**SG-FBB の本体エンジン（物理デーモン、公式審判 SSOT、Three.js 3D ダッシュボード）側には一切変更を加えることなく、C++ や Rust などのコンパイル言語で自作 pilot を開発して挑むことが可能**です。

これは、宇宙航空分野で実際に求められる **「GC（ガベージコレクション）によるジッターのない、マイクロ秒精度の高信頼性フライトソフトウェア（FSW）」** の開発体験をそのまま実践できる設計となっています。

### (1) なぜ本体無変更で他言語対応できるのか？（疎結合 ABI アーキテクチャ）

SG-FBB の通信基盤は、特定言語の RPC やフレームワークに依存せず、**OS の POSIX 共有メモリ（`/dev/shm/fbb_space_guidance_shm`）上に配置された 496 バイトの C 構造体（`ShmSpaceGuidance`）** のみを共通規格（ABI）としています。

```mermaid
flowchart LR
    subgraph SG_ENGINE["SG-FBB 共通コア (変更一切不要)"]
        DAEMON["C++17 物理・審判デーモン<br/>(100Hz 剛体力学 & 公式スコアリング)"]
        DASHBOARD["Web 3D ダッシュボード<br/>(Three.js Orbit Viewer / Scorecard)"]
    end

    SHM[("POSIX 共有メモリ (496 B)<br/>/dev/shm/fbb_space_guidance_shm<br/>(struct ShmSpaceGuidance)")]

    DAEMON <-->|Seqlock 100Hz| SHM
    DASHBOARD <---|WebSocket 30Hz| SHM

    subgraph PILOT_OPTIONS["自律操縦 Pilot (自由な言語を選択可能)"]
        PY["標準: Python (pilot.py)<br/>・初心者向けプロトタイピング<br/>・SpaceGuidanceHardware クラス"]
        CPP["C++20 (pilot.cpp)<br/>・STL / Eigen 行列演算<br/>・ポインタ直読による超低遅延"]
        RUST["Rust (src/main.rs)<br/>・型安全 & ゼロコスト抽象化<br/>・GCジッター完全排除 (航空宇宙標準)"]
    end

    SHM <-->|MMIO Direct Map| PY
    SHM <-->|MMIO Direct Map| CPP
    SHM <-->|MMIO Direct Map| RUST

    classDef core fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef shm fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#fff;
    classDef pilot fill:#14532d,stroke:#4ade80,stroke-width:2px,color:#fff;
    class SG_ENGINE core;
    class SHM shm;
    class PILOT_OPTIONS pilot;
```

---

### (2) 共有メモリ仕様 (C 構造体インターフェース)

パイロット側は、プロジェクト共通ヘッダー [include/space_guidance_shm.h](include/space_guidance_shm.h) の `struct ShmSpaceGuidance` をメモリマップするだけで、全テレメトリの取得と推力指令の書き込みが完了します。

* **初動トリガー (ADR #002)**: `cr_ctrl |= 0x08` を書き込んだ瞬間、公式タイマーが自動始動します。
* **テレメトリ直読 (8バイト浮動小数点)**: `ext.omega_x`, `ext.omega_y`, `ext.omega_z`, `pos_x`, `vel_x`, `fuel` など
* **制御コマンド直書 (Q16.16 固定小数点 / 整数)**: `torque_x_cmd`, `torque_y_cmd`, `torque_cmd`, `wheel_torque_x_cmd`, `thrust_cmd_x` など

---

### (3) C++ による Pilot 実装案

C++ では、標準の POSIX `mmap` を用いてポインタを取得するだけで、最小限のオーバーヘッドで 100Hz 制御ループを構築できます。

```cpp
// pilot.cpp
#include "../../include/space_guidance_shm.h"
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <iostream>
#include <cmath>

int main() {
    int fd = open(SPACE_GUIDANCE_SHM_PATH, O_RDWR);
    if (fd < 0) {
        std::cerr << "Failed to open shared memory: " << SPACE_GUIDANCE_SHM_PATH << std::endl;
        return 1;
    }
    auto* regs = static_cast<volatile ShmSpaceGuidance*>(
        mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));

    // 1. 初動トリガー送信 (公式審判タイマー始動)
    regs->cr_ctrl |= 0x08;
    std::cout << "[C++ Pilot] Mission Engaged! Starting Rate Damping..." << std::endl;

    // 2. 100Hz 制御ループ
    while (regs->pos_x < 35.0 && regs->fuel > 0.0) {
        regs->watchdog_kick = 1; // WDT クリア

        // 3軸角速度の直読
        double wx = regs->ext.omega_x;
        double wy = regs->ext.omega_y;
        double wz = regs->ext.omega_z;

        // レートダンピング指令 (PD逆トルク / Q16.16)
        regs->torque_x_cmd = static_cast<int32_t>(-wx * 0.85 * 65536.0);
        regs->torque_y_cmd = static_cast<int32_t>(-wy * 0.85 * 65536.0);
        regs->torque_cmd   = static_cast<int32_t>(-wz * 0.85 * 65536.0);

        usleep(10000); // 10ms (100Hz)
    }

    std::cout << "[C++ Pilot] Safe orbit reached or mission ended." << std::endl;
    munmap(const_cast<ShmSpaceGuidance*>(regs), 4096);
    close(fd);
    return 0;
}
```

> **ビルド方法 (Makefile / CMake)**:
> ```bash
> g++ -O3 -std=c++17 pilot.cpp -lpthread -o pilot_cpp
> ```

---

### (4) Rust による Pilot 実装案

Rust では、`memmap2` クレートを用いて共有メモリを安全にラップすることで、宇宙機フライトソフトウェアに不可欠な **メモリ安全性** と **GCレスの決定論的リアルタイム性能** を両立できます。

```toml
# Cargo.toml
[package]
name = "panic_pilot_rust"
version = "0.1.0"
edition = "2021"

[dependencies]
memmap2 = "0.9"
```

```rust
// src/main.rs
use std::fs::OpenOptions;
use std::thread::sleep;
use std::time::Duration;
use memmap2::MmapMut;

// C言語構造体のアライメント整合
#[repr(C, packed(4))]
struct PilotBridge {
    cr_ctrl: u32,
    _pad1: [u8; 12],
    thrust_cmd_x: u32,
    _pad2: [u8; 8],
    torque_cmd: u32,
    _pad3: [u8; 4],
    watchdog_kick: u32,
    _pad4: [u8; 8],
    pos_x: f64,
    // (必要に応じて include/space_guidance_shm.h と一致させる)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/shm/fbb_space_guidance_shm")?;

    let mut mmap = unsafe { MmapMut::map_mut(&file)? };
    let bridge = unsafe { &mut *(mmap.as_mut_ptr() as *mut PilotBridge) };

    // 公式タイマー始動
    bridge.cr_ctrl |= 0x08;
    println!("[Rust Pilot] Autonomous Mission Started (Zero-GC Realtime).");

    loop {
        bridge.watchdog_kick = 1;
        if bridge.pos_x >= 35.0 {
            println!("[Rust Pilot] Safe corridor escaped successfully!");
            break;
        }
        sleep(Duration::from_millis(10));
    }
    Ok(())
}
```

> **ビルド方法**:
> ```bash
> cargo build --release
> ```

---

### (5) 起動スクリプト（`run.sh`）のハイブリッド自動認識化

[run.sh](scenario/05_panic_control/run.sh) のパイロット起動部を以下のように拡張することで、**「コンパイル済みバイナリ（C++ / Rust）が存在すれば優先起動し、無ければ標準の Python スクリプトを実行する」** という完全透過な運用が可能です：

```bash
# バイナリ優先起動ロジックの例
if [ -x "$SCRIPT_DIR/pilot_cpp" ]; then
    echo "[SpaceGuidance] Executing High-Performance C++ Pilot..."
    "$SCRIPT_DIR/pilot_cpp" "$@"
elif [ -x "$SCRIPT_DIR/target/release/panic_pilot_rust" ]; then
    echo "[SpaceGuidance] Executing High-Assurance Rust Pilot..."
    "$SCRIPT_DIR/target/release/panic_pilot_rust" "$@"
else
    echo "[SpaceGuidance] Executing Baseline Python Autopilot..."
    python3 "$PILOT_SCRIPT" "$@"
fi
```

このように、受講生やチャレンジャーは **「アルゴリズム先行で素早く試す Python」** から、**「実機宇宙機FSWを見据えた C++ / Rust による極限の制御周期・低遅延化」** へと、同一ステージ・同一レギュレーションのままシームレスにステップアップできます。

