# Stage 3: ISSトラスレール点検機 (ISS Truss Inspector)

**難易度: Level 3 (中上級) | 物理空間: 3次元立体曲面レール軌道 ＋ 遠心力・把持連成力学**

---

## 1. ミッション概要 (Mission Overview)

国際宇宙ステーション（ISS）の複雑な立体トラス構造の外壁レール（全長60m）を這うように巡回し、指定された全4箇所の高重要度点検ポイント（トラスジョイント部）で電磁グリッパーによりレールを把持・固定して高精度レーザースキャンを実行するミッションです。

3次元空間での急カーブ走行では、速度の2乗に比例する強大な遠心力（$F_c = M v^2 / R$）が発生します。トラスレールの許容ラジアル荷重（$300.0\text{ N}$）を超えると機体がレールから弾き飛ばされ、宇宙空間へ**脱線・漂流（即時失格・ゲームオーバー）**します。プレイヤーは**「コーナー手前での曲率適応型ブレーキ」**と**「点検ジョイント到着時の静止・把持ラッチ・スキャンシーケンス」**を設計・チューニングしなければなりません。

---

## 2. 機体仕様・レール物理モデル (Hardware Specs & Rail Physics)

物理エンジンは 100Hz（$\Delta t = 0.01\text{s}$）周期で機体のレール沿面運動と遠心力・把持ラッチ状態を計算します。

### (1) 機体物理諸元
* **点検機乾燥質量 ($M$)**: $100.0\text{ kg}$
* **レール総延長 ($L$)**: $60.0\text{ m}$
* **許容最大レール荷重 ($F_{\text{rail},\max}$)**: $300.0\text{ N}$（脱線破断リミット）
* **点検ジョイント位置**: 全4箇所（$X = 15.0\text{m}, 30.0\text{m}, 45.0\text{m}, 60.0\text{m}$）
* **ジョイント把持許容範囲**: ジョイント位置から $\pm 0.35\text{m}$ かつ 速度 $|v_x| < 0.35\text{ m/s}$

### (2) 遠心力および脱線・破損判定式
1. **カーブ遠心荷重限界（脱線）**:
   $$F_c = M \frac{v_x^2}{R(x)} \quad (R \approx 5.0\text{ m})$$
   遠心荷重が $300.0\text{ N}$ を超過した場合（$v_x > 3.87\text{m/s}$）、C字クランプがパイプから外れて軌道離脱失格（`DISQUALIFIED (CENTRIFUGAL OVERLOAD)`）となります。
2. **直線部チャタリング脱線（脱輪）**:
   直線を抱え込んで走行していても、速度が過大（$|v_x| > 3.50\text{m/s}$）になると高周波振動（チャタリング）によってクランプが跳ねて脱輪（`DISQUALIFIED (OVER-SPEED CHATTER)`）。
3. **高速クランプによるラッチピン剪断破壊（メカ破損）**:
   ジョイント停止時にカウンタースラスタで十分に減速せず、速度 $|v_x| > 0.40\text{m/s}$ のまま電磁クランプ（`fdir_mode = 1`）を作動させると、ピンが剪断破壊されミッション失格（`DISQUALIFIED (CLAMP PIN SHEAR)`）。

---

## 3. 360度トラス欠陥探査システム (360° Flaw Inspection Radar)

本ステージでは、4箇所のジョイントのうちランダムに選ばれた3箇所の円周上角度 $\theta \in [30^\circ, 330^\circ]$ に微細クラック（構造欠陥）が潜伏しています。

### (1) ビーム幅と感度の物理トレードオフ (Energy Dilution Law)
レーザー/超音波スキャナの受光感度ゲインは、ビーム幅（チェック幅）に反比例します：
$$\text{Gain} = \frac{15^\circ}{\Delta\theta}$$
* **広角ビーム ($\Delta\theta = 25^\circ$)**: 全周スイープが高速に行えますが、エネルギー分散により感度が低下（$\text{SNR} \approx 200 \sim 500$）。欠陥候補の発見（粗探索）に最適。
* **狭角ビーム ($\Delta\theta = 8^\circ$)**: 指向性を絞ることでエネルギーが集中し高感度（$\text{SNR} = 1023 \ge 600$）。欠陥確定に必要な $\text{SNR} \ge 600$ を満たす精密ロックに最適。
* **欠陥確定条件**: $\text{SNR} \ge 600$ を $0.15\text{s}$ 以上照射維持（Dwell Time 満了）することで公式審判に記録されます。

### (2) 制御API
```python
# スキャナ角度・ビーム幅制御
hw.set_inspection_scan(angle_deg=theta, beam_width_deg=beam_w, drive_thrust=0.0, fdir_mode=1)
```

---

## 4. ゲームプレイループとハッキングガイド

### (1) 編集対象ファイル
```text
~/.fbb/plugins/SpaceGuidance-FBB/scenario/03_iss_truss/pilot.py
（※ローカル開発環境の場合は /workspaces/SpaceGuidance-FBB/scenario/03_iss_truss/pilot.py）
```
（原本への初期化・リセットは `examples/mission03_baseline_truss.py` からコピー可能）

### (2) 攻略用 TUNE ZONE
```python
# 巡航速度・減速設定
cruise_velocity = 2.0      # 直線区間目標速度 (m/s) [脱線限界 3.5m/s に対し十分なマージン]
corner_velocity = 1.1      # カーブ区間目標速度 (m/s) [遠心荷重 < 30N << 300N 限界]
decel_accel = 0.26         # 減速加速度 (m/s^2, カウンタースラスタ逆推力制動)
```

---

## 5. 採点基準 & 公式審判システム (Official Referee SSOT)

全4箇所のジョイントスキャンを完了し、60m地点でアンラッチした際に公式審判（`OfficialReferee`）により採点されます：

$$\text{Final Score} = \text{Joints Score} + \text{Defects Score} + \text{Time Bonus} + \text{Battery Bonus}$$

### (1) 配点内訳
1. **ジョイント把持配点 (全4箇所: 15m, 30m, 45m, 60m)**:
   * 正常把持（誤差 $\le 0.35\text{m}$ かつ 速度 $< 0.35\text{m/s}$）: **各 1,000 pts（最大 4,000 pts）**
2. **微細欠陥検出配点 (ランダム潜伏 3箇所)**:
   * 360度探査による欠陥特定・確定: **1箇所につき +1,500 pts（最大 4,500 pts）**
3. **タイムボーナス**:
   $$\text{Time Bonus} = \max(0, (75.0 - \text{Clear Time}) \times 50.0)$$
4. **バッテリー残量ボーナス**:
   $$\text{Battery Bonus} = \text{Battery}(\%) \times 10.0$$

### (2) フライトランク認定基準
* 🏆 **GRADE S (Master Inspector)**: **8,000 pts 以上 かつ 欠陥全3箇所検出**
* 🥇 **GRADE A (Certified)**: 6,500 pts 以上 かつ 欠陥2箇所以上検出
* 🥈 **GRADE B (Standard)**: 4,500 pts 以上
* 🥉 **GRADE C (Pass)**: 4,500 pts 未満

1. **カーブ区間遠心力限界と事前減速制御**:
   - 2箇所の急カーブ（20-25m, 40-45m）は曲率半径 $R=5.0\text{m}$（曲率 $0.20\text{m}^{-1}$）として計算されます。
   - 遠心荷重 $F_c = M v^2 / R = 20 v^2$ に対し、許容リミットは $300.0\text{ N}$（脱線限界速度 $\approx 3.87\text{m/s}$）。
   - 推奨旋回速度 $v \approx 1.1 \sim 1.3\text{m/s}$ に事前減速することで、遠心力 $F_c < 35\text{N}$（負荷わずか 11%）の極めて安全なマージンを維持します。
2. **電磁グリッパー吸着力学 (Rail Clamp Dynamics)**:
   - ジョイント近傍（$\pm 0.5\text{m}$）で `fdir_mode = 1` が書き込まれると、ハードウェア吸着力（$1,000\text{N}$ の強力制動抵抗）が働き、スキャン中の機体をガタつきなく定点に強力ロックします。
3. **60.0m 終端安全エンドストッパー (Terminal Endstop)**:
   - レール終端（$X=60.0\text{m}$）には物理的ダンパーが備わっており、万が一のオーバーラン時も機体を安全に受け止めます。

---

## 6. クイックスタート

```bash
# Web 3D 観戦モード (F-BB 統合ラボ)
# F-BB 統合 CLI による起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/03_iss_truss

# （ローカル開発環境の場合）
# ./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/03_iss_truss

# CLI 高速実行モード
bash scenario/03_iss_truss/run_mission.sh
```
