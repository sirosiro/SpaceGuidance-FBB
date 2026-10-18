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

### (2) 遠心力および脱線判定式
$$F_c = M \frac{v_x^2}{R(x)} \quad (R(x) \approx 2.5\text{ m: コーナー部})$$
遠心力または横荷重が $300.0\text{ N}$ を超過した場合、C++ デーモン公式審判が即座に `DISQUALIFIED (RAIL DERAILMENT)` を発動しミッション失敗となります。

---

## 3. ゲームプレイループとハッキングガイド

### (1) 編集対象ファイル
```text
~/.fbb/plugins/SpaceGuidance-FBB/scenario/03_iss_truss/pilot.py
（※ローカル開発環境の場合は /workspaces/SpaceGuidance-FBB/scenario/03_iss_truss/pilot.py）
```
（原本への初期化・リセットは `examples/mission03_baseline_truss.py` からコピー可能）

### (2) 攻略用 TUNE ZONE
```python
# 巡航速度設定
cruise_vel = 2.2         # 直線区間目標速度 (m/s)
corner_vel = 0.9         # カーブ区間目標速度 (m/s) [遠心力を300N未満に抑制]
approach_vel = 0.25      # ジョイント接近把持速度 (m/s)
latch_settle_time = 0.3  # レーザースキャン静止時間 (s)
```

---

## 4. 採点基準 & 公式審判システム (Official Referee SSOT)

全4箇所のジョイントスキャンを完了し、60m地点へ到達した際に公式審判（`OfficialReferee`）により採点されます：

$$\text{Final Score} = \text{Joints Score} + \text{Time Bonus} + \text{Battery Bonus}$$

### (1) 配点内訳
1. **ジョイント把持・スキャン配点 (全4箇所)**:
   * 速度 $< 0.35\text{m/s}$、誤差 $\le 0.35\text{m}$ で電磁把持 (`fdir_mode=1`) 成立ごとに **$+1,500 \text{ pts}$**（4箇所完遂で $6,000\text{ pts}$）
2. **タイムボーナス**:
   $$\text{Time Bonus} = \max(0, (45.0 - \text{Clear Time}) \times 50.0)$$
3. **バッテリー残量ボーナス**:
   $$\text{Battery Bonus} = \text{Battery}(\%) \times 10.0$$
4. **レール脱線失格**: レール遠心荷重が $300.0\text{ N}$ を超えた瞬間に即座に失格・スコア 0 点。

### (2) フライトランク認定基準
* 🏆 **GRADE S (Master Inspector)**: **8,000 pts 以上**
* 🥇 **GRADE A (Certified)**: 6,500 pts 以上
* 🥈 **GRADE B (Standard)**: 5,000 pts 以上
* 🥉 **GRADE C (Pass)**: 5,000 pts 未満

---

## 5. 今後の採点・競技仕様改定方針（開発ロードマップ）

現在本シナリオは実装途中の段階ですが、競技性向上のため以下の改定が予定されています：
1. **ゴール完了条件の柔軟化とスキップ戦略**:
   - 現行では全4箇所のジョイント点検がゴール到達に必須ですが、今後は「タイム短縮のためにあえて一部ジョイントをスキップする」戦術的タイムアタックを許容する予定です。
   - スキップしたジョイントは純粋に得点喪失（-1,500点/箇所）となり、タイムボーナスとのトレードオフが成立します（※最低1箇所の点検確認は必須）。
2. **カーブ区間遠心力限界（脱線 300N）の実効性維持**:
   - 急カーブ（20-25m, 40-45m）での減速不足によるレール脱線失格（$F_c > 300\text{N}$）は現行通り厳格に判定されます。

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
