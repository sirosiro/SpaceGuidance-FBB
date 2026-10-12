# Stage 4: 深宇宙光レーザードッキング (Optical Laser Docking)

**難易度: Level 4 (エキスパート) | 物理空間: 6自由度 (6-DoF) 完全無重力・無摩擦剛体力学**

---

## 1. ミッション概要 (Mission Overview)

推進剤（Delta-V）残量の極めて乏しい無人深宇宙補給船が、自転運動する宇宙ステーションのドッキングポートへ向けて最終アプローチを行い、誘導レーザーの十字光軸をターゲットの中心に合致させながら、接触速度ほぼゼロ（$\le 0.02\text{m/s}$）でソフトドッキングを果たす最高難易度ミッションです。

完全摩擦ゼロの 6自由度空間（$X, Y, Z, \text{Roll}, \text{Pitch}, \text{Yaw}$）では、姿勢を回転させると機体の主ノズル噴射方向が変わり、並進運動と回転運動が複雑に連成（クロスカップリング）します。限られた推進剤を節約しながら、自転するターゲットポートと位置・姿勢・角速度を同時に一致させる高度な宇宙航法技術が求められます。

---

## 2. 物理・力学モデル構想 (Physics Model)

### (1) 6自由度オイラー剛体運動方程式
機体座標系におけるオイラーの運動方程式およびクォータニオン運動学：

$$M \dot{\mathbf{v}} + \boldsymbol{\omega} \times (M \mathbf{v}) = \mathbf{F}_{\text{rcs}}$$

$$\mathbf{I} \dot{\boldsymbol{\omega}} + \boldsymbol{\omega} \times (\mathbf{I} \boldsymbol{\omega}) = \boldsymbol{\tau}_{\text{rcs}} + \boldsymbol{\tau}_{\text{wheel}}$$

$$\dot{\mathbf{q}} = \frac{1}{2} \mathbf{q} \otimes \begin{pmatrix} 0 \\ \boldsymbol{\omega} \end{pmatrix}$$

### (2) ドッキング成功判定基準 (Docking Constraints)
* **相対位置偏差**: $|\Delta \mathbf{r}| \le 0.02\text{ m}$ ($2\text{cm}$ 以内)
* **相対姿勢角偏差**: $|\Delta \boldsymbol{\theta}| \le 0.5^\circ$ ($0.5$度以内)
* **接触軸方向相対速度**: $0.005\text{ m/s} \le v_{\text{contact}} \le 0.020\text{ m/s}$（ハードクラッシュおよび跳ね返りの防止）

---

## 3. ハードウェア (PL) と ソフトウェア (PS) の役割分担構想

| レイヤー | コンポーネント | 役割と責務 |
| :--- | :--- | :--- |
| **PL (FPGA RTL)** | **4分割フォトダイオード (QPD) 光軸演算** | 十字誘導レーザーの受光量から光軸重心変位（$\Delta x, \Delta y$）を超高速にハードウェア算出 |
| | **最小インパルス PWM RCS ジェネレータ** | ソレノイドバルブの最小開弁時間（$10\text{ms}$）制約を守りつつ極小インパルスを生成する PWM 回路 |
| | **衝突防止レーダー＆緊急逆噴射ラッチ** | 接近速度が安全減速エンベロープを超過した場合の即時全開逆噴射インターロック |
| **PS (Python)** | **6-DoF 視線誘導 (Line-of-Sight Guidance)** | Clohessy-Wiltshire (CW) 方程式に基づくステーション相対ランデブー軌道生成 |
| | **スラスタ最適配分 (Thruster Allocation)** | 12基の RCS ノズルから目標推力・トルクを燃料消費最小で発生させる線形計画法 (LP) 配分 |
| | **自転同期ロール追従制御** | ステーションの自転角速度（$\omega_z$）に合わせて補給船をバレルロール同期させる制御 |

---

## 4. 攻略チューニングゾーン構想 (Tune Zones Memo)

* **🎯 TUNE ZONE 1: 6-DoF LOS 誘導ゲイン (`los_kp`, `los_kd`)**:
  * ターゲット光軸への引き込み力とダンピングのバランス。
* **🚀 TUNE ZONE 2: スラスタ配分ウェイト (`fuel_vs_time_weight`)**:
  * 燃料最小化（パルス節約）とアプローチ時間（ドッキング制限時間）のトレードオフ調整。
* **🛑 TUNE ZONE 3: 最終ドッキング減速カーブ (`final_braking_profile`)**:
  * ポート直前 1m から接触速度 $0.015\text{ m/s}$ へ滑らかに整定させる減速プロファイル。

---

## 5. 採点・評価システム構想 (Scoring Memo)

$$\text{Score} = \text{Docking Precision Score} + \text{Delta-V Fuel Bonus} + \text{Soft Contact Bonus}$$

* **ドッキング精度**: 接触時の光軸中心ズレ（mm単位）および角度ズレ（0.1度単位）に応じた採点。
* **残燃料ボーナス**: 推進剤消費量（$\Delta V$）の節約度合いに応じた大幅加算。
* **ソフトコンタクトボーナス**: 接触速度が理想速度（$0.01\text{m/s}$）にどれだけ近いか。

---

## 6. 実装準備メモ (Implementation Roadmap)
* [ ] `scenario/04_laser_docking/config.dts` の作成（QPD レーザー、6-DoF スラスタレジスタ）
* [ ] `src/space_physics.cpp` への 6-DoF オイラー運動力学エンジンの拡張
* [ ] `panes/sg-orbit-viewer` への自転ステーションポート＆レーザー光軸オーバーレイの実装
* [ ] `examples/mission04_baseline_docker.py` の原本作成
