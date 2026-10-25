# Stage 4: 深宇宙光レーザードッキング (Optical Laser Docking)

**難易度: Level 4 (エキスパート) | 物理空間: 6自由度 (6-DoF) 完全無重力・無摩擦剛体力学**

---

## 1. ミッション概要 (Mission Overview)

推進剤（Delta-V）残量の極めて乏しい無人深宇宙補給船が、自転運動する宇宙ステーションのドッキングポートへ向けて最終アプローチ（50m回廊）を行い、誘導レーザーの十字光軸をターゲットの中心に合致させながら、接触速度ほぼゼロ（$0.005 \sim 0.035\text{ m/s}$）でソフトドッキングを果たす最高難易度ミッションです。

完全摩擦ゼロの空間では、姿勢を回転させると主ノズルの噴射方向が変わり、並進運動と回転運動が複雑に連成します。限られた推進剤を節約しながら、7段階の接近レンジゲートを通過し、ポート直前で安全なソフトコンタクトを成立させることが求められます。

---

## 2. 機体仕様・ドッキング物理モデル (Hardware Specs & Docking Physics)

物理エンジンは 100Hz（$\Delta t = 0.01\text{s}$）周期で機体の運動方程式を数値積分します。

### (1) 機体物理諸元 & 光学ターゲット仕様
* **補給船乾燥質量 ($M$)**: $100.0\text{ kg}$
* **アプローチ回廊長**: $50.0\text{ m}$
* **接近チェックポイント**: 全7箇所（残り距離 $40\text{m}, 30\text{m}, 20\text{m}, 10\text{m}, 5\text{m}, 2\text{m}, 1\text{m}$）
* **初期姿勢不一致（カオス不確実性）**: 360度全方位ランダム方位角 $\psi_0 \in [-\pi, +\pi]$（基準シード 0x1337 では $+135.0^\circ$、後方左向きから開始）
* **ステーション自転角速度**: $\Omega_{\text{station}} \approx 0.065 \sim 0.085\text{ rad/s}$ ($3.7^\circ \sim 4.9^\circ/\text{s}$、遠心力人工重力発生のためステーション全体が回転)
* **VBN (Vision Based Navigation) 光学センサフィードバック**:
  - `yaw`: 自機の水平方位角 (rad、0.0でポート回廊+X軸に正対)
  - `omega_z`: 自機の水平旋回角速度 (rad/s)
  - `roll`: 自機のロール自転角 (rad)
  - `omega_x`: 自機のロール自転角速度 (rad/s)
  - `target_angle`: ステーション全体のリアルタイム自転角 (rad)
  - `target_omega`: ステーション自転角速度 (rad/s)
  - `rel_angle`: 自機とステーションの相対ロール位相偏差 $\Delta\theta = \text{roll} - \text{target\_angle}$ (rad)
  - `rel_omega`: 自機とステーションの相対自転角速度偏差 $\Delta\omega = \omega_x - \text{target\_omega}$ (rad/s)
  - `cross_track_err`: QPD十字レーザー光軸偏差 $\Delta y$ (m)
* **ソフトドッキング接触許容速度**: $0.005\text{ m/s} \le v_{\text{contact}} \le 0.035\text{ m/s}$
* **光軸整定許容偏差**: $|\Delta y| \le 0.02\text{ m}$ ($2.0\text{cm}$ 以内)
* **姿勢角・自転角速度許容偏差**: $|\Delta\theta| \le 0.03\text{ rad}$ ($1.7^\circ$ 以内), $|\Delta\omega| \le 0.02\text{ rad/s}$
* **正面正対角許容偏差**: $|\psi| \le 0.05\text{ rad}$ ($2.9^\circ$ 以内)

---

## 3. ゲームプレイループとハッキングガイド

### (1) 編集対象ファイル
```text
~/.fbb/plugins/SpaceGuidance-FBB/scenario/04_laser_docking/pilot.py
（※ローカル開発環境の場合は /workspaces/SpaceGuidance-FBB/scenario/04_laser_docking/pilot.py）
```

### (2) 攻略用 TUNE ZONE
```python
# 視線誘導 (Line-of-Sight) & 姿勢・回転同期制御ゲイン
kp_los = 1.60              # 光軸中心引き込み比例ゲイン
kd_los = 0.95              # 光軸ドリフト速度ダンピング
kp_att = 3.50              # 姿勢角・回転同期アライメントゲイン
kd_att = 1.80              # 角速度ダンピング
v_contact_target = 0.018   # 目標最終接触速度 (m/s) [0.005〜0.035m/s に整定]
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
   * 速度・光軸・姿勢・自転完全適合 ($v \in [0.005, 0.035]\text{m/s}$, $|\Delta y| \le 2\text{cm}$, $|\Delta\theta| \le 1.7^\circ$, $|\Delta\omega| \le 0.02\text{rad/s}$): **$+3,000 \text{ pts}$**（PERFECT CONTACT）
   * 速度・光軸適合 ($v \in [0.005, 0.035]\text{m/s}$, $|\Delta y| \le 2\text{cm}$): **$+2,000 \text{ pts}$**
   * 速度のみ適合: **$+1,500 \text{ pts}$**
   * 粗い接触 ($0.035 < v \le 0.08\text{ m/s}$ または $v < 0.005\text{ m/s}$, $|\Delta y| \le 6\text{cm}$): **$+500 \text{ pts}$**
3. **推進剤残量ボーナス**:
   $$\text{Fuel Bonus} = \text{Fuel}(\%) \times 10.0$$
4. **ステーション激突大破判定（Docking Crash Disqualification）**:
   * 以下のいずれか1つでも超過した場合、ドッキングガイドペダル衝突・ラッチ破損により機体大破・即時失格（スコア 0 点、`DISQUALIFIED (DOCKING CRASH)`）：
     - 接触速度 $v_{\text{contact}} > 0.08\text{ m/s}$
     - 光軸偏差 $|\Delta y| > 0.06\text{ m}$ ($6.0\text{cm}$)
     - ロール位相偏差 $|\Delta\theta| > 0.08\text{ rad}$ ($4.6^\circ$)
     - 自転角速度偏差 $|\Delta\omega| > 0.05\text{ rad/s}$ ($2.9^\circ/\text{s}$)
     - 正面正対角偏差（Yaw方位角） $|\psi| > 0.10\text{ rad}$ ($5.7^\circ$)
   * 物理シミュレーション上も機体速度が直ちに 0 に拘束され、ポート突破・すり抜けが防止されます。

### (2) フライトランク認定基準
* 🏆 **GRADE S (Elite Astronaut)**: **8,000 pts 以上**（光軸偏差1cm以内かつ完全ソフトドッキング成立）
* 🥇 **GRADE A (Certified)**: 6,500 pts 以上
* 🥈 **GRADE B (Standard)**: 5,000 pts 以上
* 🥉 **GRADE C (Pass)**: 5,000 pts 未満
* 💥 **DISQUALIFIED (DOCKING CRASH)**: 接触速度 $> 0.08\text{ m/s}$, 光軸偏差 $> 6\text{cm}$, ロール位相偏差 $> 4.6^\circ$, 自転角速度偏差 $> 2.9^\circ/\text{s}$, または正面正対角偏差 $> 5.7^\circ$（スコア 0 点）

---

## 5. 競技戦略と制御設計の要点 (4-Phase FSM Guidance)

本シナリオでは「360度初期方位」「ステーション全体遠心自転」「激突大破判定」に対応するため、4段階の自律航法ステートマシン（4-Phase FSM）を実装します：
1. **Phase 1: HEADING ALIGN (正面正対旋回)**:
   - 補給船は初期に360度ランダムな方位角を持った状態で 50m 待機点に配置されます。機体を前進させずに RCS Yaw トルク（$\tau_z$）でノーズを回廊+X軸（ステーション正面）へ正確に正対旋回（$|\psi| < 0.06\text{ rad}$）させます。
2. **Phase 2: SPIN SYNC (自転位相同期)**:
   - 正面正対を維持したまま、遠心自転するステーションの自転角（`target_angle`）と自転角速度（`target_omega`）に機体のロール位相を完全同期（$|\Delta\theta| < 0.035\text{ rad}$, $|\Delta\omega| < 0.025\text{ rad/s}$）させます。
3. **Phase 3: AXIS CENTERING (光軸センタリング)**:
   - 正対および自転同期を維持しながら、並進 RCS 推力で QPD レーザー光軸中心（$|y| < 0.03\text{m}$, $|v_y| < 0.025\text{m/s}$）へ引き込みます。
4. **Phase 4: FINAL GLIDESLOPE (減速進入・ソフトラッチ)**:
   - ポートまでの距離に応じた減速プロファイル（$dist < 3\text{m}$ で $v_{\text{target}} = 0.018\text{ m/s}$）に従って50m回廊を前進し、激突大破判定を回避して電磁ラッチを締結します。世界座標系の並進推力を機体姿勢角に応じて機体座標系へ回転変換（DCM）して噴射します。

---

## 6. クイックスタート

```bash
# Web 3D 観戦モード (F-BB 統合ラボ)
# F-BB 統合 CLI による起動
fbb lab ~/.fbb/plugins/SpaceGuidance-FBB/scenario/04_laser_docking

# （ローカル開発環境の場合）
# ./start_lab.sh /workspaces/SpaceGuidance-FBB/scenario/04_laser_docking

# CLI 高速実行モード
bash scenario/04_laser_docking/run_mission.sh
```
