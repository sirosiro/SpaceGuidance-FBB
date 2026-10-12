# Stage 4: 深宇宙光レーザードッキング (Optical Laser Docking)

**難易度: Level 4 (エキスパート) | 物理空間: 6自由度 (6-DoF) 完全無重力・無摩擦剛体力学**

---

## 1. ミッション概要 (Mission Overview)

推進剤（Delta-V）残量の極めて乏しい無人深宇宙補給船が、自転運動する宇宙ステーションのドッキングポートへ向けて最終アプローチ（50m回廊）を行い、誘導レーザーの十字光軸をターゲットの中心に合致させながら、接触速度ほぼゼロ（$0.005 \sim 0.035\text{ m/s}$）でソフトドッキングを果たす最高難易度ミッションです。

完全摩擦ゼロの空間では、姿勢を回転させると主ノズルの噴射方向が変わり、並進運動と回転運動が複雑に連成します。限られた推進剤を節約しながら、7段階の接近レンジゲートを通過し、ポート直前で安全なソフトコンタクトを成立させることが求められます。

---

## 2. 機体仕様・ドッキング物理モデル (Hardware Specs & Docking Physics)

物理エンジンは 100Hz（$\Delta t = 0.01\text{s}$）周期で機体の運動方程式を数値積分します。

### (1) 機体物理諸元
* **補給船乾燥質量 ($M$)**: $100.0\text{ kg}$
* **アプローチ回廊長**: $50.0\text{ m}$
* **接近チェックポイント**: 全7箇所（残り距離 $40\text{m}, 30\text{m}, 20\text{m}, 10\text{m}, 5\text{m}, 2\text{m}, 1\text{m}$）
* **ソフトドッキング接触許容速度**: $0.005\text{ m/s} \le v_{\text{contact}} \le 0.035\text{ m/s}$
* **光軸整定許容偏差**: $|\Delta y| \le 0.02\text{ m}$ ($2.0\text{cm}$ 以内)

---

## 3. ゲームプレイループとハッキングガイド

### (1) 編集対象ファイル
```text
/workspaces/SpaceGuidance-FBB/scenario/04_laser_docking/pilot.py
```
（原本への初期化・リセットは `/workspaces/SpaceGuidance-FBB/examples/mission04_baseline_docker.py` からコピー可能）

### (2) 攻略用 TUNE ZONE
```python
# 視線誘導 (Line-of-Sight) & 姿勢安定化ゲイン
kp_los = 1.2             # 光軸引き込み比例ゲイン
kd_los = 0.8             # 横速度ダンピングゲイン
kp_att = 0.6             # 姿勢角復元ゲイン
kd_att = 0.4             # 角速度ダンピングゲイン
v_contact_target = 0.018 # 目標最終接触速度 (m/s) [0.005〜0.035m/s に整定]
```

---

## 4. 採点基準 & 公式審判システム (Official Referee SSOT)

ドッキングポート接触時（残り距離 $\le 0.05\text{m}$）に公式審判（`OfficialReferee`）により総合判定されます：

$$\text{Final Score} = \text{Approach Score} + \text{Soft Contact Bonus} + \text{Fuel Bonus}$$

### (1) 配点内訳
1. **7段階レンジ接近整定精度 (40m, 30m, 20m, 10m, 5m, 2m, 1m)**:
   * 光軸偏差 $< 1.0\text{cm}$: **$+1,000 \text{ pts}$**
   * 光軸偏差 $< 3.0\text{cm}$: **$+800 \text{ pts}$**
   * 光軸偏差 $\ge 3.0\text{cm}$: **$+500 \text{ pts}$**
   * *(全7ゲート高精度通過で最大 7,000 pts)*
2. **ソフトコンタクトボーナス**:
   * 速度 $0.005 \sim 0.035\text{ m/s}$ かつ 光軸偏差 $\le 2\text{cm}$: **$+3,000 \text{ pts}$**（PERFECT CONTACT）
   * 速度 $0.005 \sim 0.035\text{ m/s}$ のみ適合: **$+1,500 \text{ pts}$**
   * 速度超過または粗い接触: **$+500 \text{ pts}$**
3. **推進剤残量ボーナス**:
   $$\text{Fuel Bonus} = \text{Fuel}(\%) \times 10.0$$

### (2) フライトランク認定基準
* 🏆 **GRADE S (Elite Astronaut)**: **8,000 pts 以上**（光軸偏差1cm以内かつ完全ソフトドッキング）
* 🥇 **GRADE A (Certified)**: 6,500 pts 以上
* 🥈 **GRADE B (Standard)**: 5,000 pts 以上
* 🥉 **GRADE C (Pass)**: 5,000 pts 未満

---

## 5. クイックスタート

```bash
# Web 3D 観戦モード (F-BB 統合ラボ)
cd /workspaces/FPGA-BoardlessBench
./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/04_laser_docking

# CLI 高速実行モード
/workspaces/SpaceGuidance-FBB/scenario/04_laser_docking/run_mission.sh
```
