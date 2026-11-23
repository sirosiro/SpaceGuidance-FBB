# 開発基本原則 (Core Development Philosophy)

- **開発の基本方針**: プロジェクト開発の基本として、常に [DESIGN_PHILOSOPHY.md](file:///workspaces/FPGA-BoardlessBench/DESIGN_PHILOSOPHY.md) に定義されている開発理念、厳格な開発プロトコル、検証プロトコル、およびライセンス戦略に例外なく従うこと。
- **アーキテクチャ・マニフェストの遵守**: 各フォルダのソースコードを修正・追加する際は、それぞれのフォルダ（またはその親フォルダ）に配置されている `ARCHITECTURE_MANIFEST.md` の記述を必ず参照し、その設計方針や規約に厳格に従うこと。各フォルダに配置されているマニフェストファイルの一覧は以下の通り：
  - ルート: [ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/ARCHITECTURE_MANIFEST.md)
  - テストシナリオ全体: [tests/scenarios/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/ARCHITECTURE_MANIFEST.md)
  - テストシナリオHAL: [tests/scenarios/P01_frdmIMX/hal/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/P01_frdmIMX/hal/ARCHITECTURE_MANIFEST.md)
  - テストシナリオAMR: [tests/scenarios/P02_robot_amr_ros2/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/P02_robot_amr_ros2/ARCHITECTURE_MANIFEST.md)
  - ダッシュボード: [dashboard/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/dashboard/ARCHITECTURE_MANIFEST.md)
  - スクリプト: [scripts/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/scripts/ARCHITECTURE_MANIFEST.md)
- **コード編集前の設計照合（Manifest Checking）の徹底**: どんなに軽微な修正やデバッグ・機能追加であっても、コードを書き換える前に必ず修正対象コンポーネントの `ARCHITECTURE_MANIFEST.md` および関連ドキュメントを参照・照合し、設計規約やアーキテクチャ原則（SoC/ベンダー非依存、Single Source of Truth など）に反していないことを思考プロセス（thought）内で検証すること。単に「テストがPASSする」ことだけでなく、「設計原則が維持されていること」を合否基準とすること。
- **不具合指摘対応時の即時修正禁止と冷静な影響考察**: ユーザーから不具合の指摘やバグ報告を受けた際であっても、焦ってすぐに手元のコードを書き換えようとせず、まず落ち着いてシステム全体の仕様・関連ドキュメントを再確認し、変更によるシステム全体への影響範囲を十分に考察した上で修正案を検討・提示すること。対症療法的な局所パッチ（特定名前の直叩き等）は厳禁とする。
- **Git管理・.gitignore判断時の歴史的意図（ADR）確認プロトコル**: Git管理下のファイルを除外・削除、または `.gitignore` を編集する際は、一般的な教科書的ビルド原則（例: 「生成物はGitに入れない」）を機械的に適用せず、必ず事前に [docs/architecture/AddInfo_history.md](file:///workspaces/FPGA-BoardlessBench/docs/architecture/AddInfo_history.md) や関連マニフェストを参照し、初学者の開発体験（`git clone` 直後の VS Code IntelliSense / clangd エラー防止のための `vfpga_device_config.h` 保持など）や過去の意図的決定（ADR）が存在しないかを思考プロセス内で事前に検証すること。
- **コード規模計測における `cloc` 使用の標準化**: 今後、プロジェクトのコード量・ファイル数・行数統計を調査・集計・ドキュメント更新する際は、必ず事前に `./tests/run_tests.sh --clean --cleanall` を実行して動的ロードされた外部 RTOS ソース等を完全にクリーンオフした上で、`cloc . --exclude-dir=build,node_modules,dist,obj_dir,.git,.vscode,.gemini,brain,scratch,assets` コマンドを使用し、F-BB 独自の正確な純プログラム行数 (Pure LOC)・コメント行数・空行数を計測・記録すること。
- **Git Push の完全禁止（厳格遵守）**: エージェントによるリモートリポジトリへの `git push` は、理由の如何を問わず一切禁止とする。エージェントが担当するバージョン管理操作はローカルリポジトリでのコミット（`git commit`）までに厳格に留め、リモートへの反映・プッシュは常にユーザー自身の手動操作に委ねること。
- **プラグイン完全隔離原則（F-BBコアへの具象名混入の絶対禁止）**: F-BBのコアソースコード（`dashboard/server.js`、`start_lab.sh`、`src/controller/vlogic_controller.py`、`scripts/` 等）に、特定のサードパーティ・プラグインや外部シナリオの具象名（例: `space_guidance_*`, `pilot.py`, `rct_*` 等）を直接記述・ハードコードすることを例外なく一切禁止する。プロセスライフサイクル管理は `/tmp/fbb_app.pid` によるPGID隔離、テレメトリは `/tmp/fbb_scenario_telemetry.json` 等の抽象契約に厳格に限定し、コミット前に必ず `./scripts/verify_plugin_isolation.sh` で違反ゼロであることを検証すること。
- **Markdownドキュメント作成時の標準用語遵守（AI造語の禁止）**: `README.md`・`ARCHITECTURE_MANIFEST.md`・設計書・各種ガイド等の Markdown ファイルを新規作成・編集する際は、AI 独自の造語・不自然な直訳表現（例: 「無言の破綻」「慣性順伝播」「開閉原則」「粗暴な〜」「無断裂取得」等）や、技術文書として過度なスラング・誇張表現（例: 「爆速」「カンペ」「ゴリゴリ魔改造」等）を使用せず、標準的な技術用語（例: 「暗黙の破綻」「開放/閉鎖原則 (OCP)」等）を用いること。また、プロジェクト公式の略称・用語（`PPA`、`DPPA`、`C-Shim`、`GTR`、`fbb lab ./plugins/...` 等）および表現を統一すること。ただし、`☕ コラム` や `作者からのメッセージ` 等の意図的なカジュアル文体、およびプロジェクト固有の定着済み用語（`Time-Travel Debugging`、`Bus Glow`、`Decoupled Observability`、`実機透過性`、`Zero-Touch`、`シード値再現型カオス障害注入` 等）はこの限りではない。

# High-Level Model Routing (利用シーン別モデル＆推論深度ルーティングプロトコル)

タスクの規模・並列性・推論深度・クォータ効率を最適化するため、エージェントは作業着手前やフェーズ移行時に、以下の基準に従って最適なモデル（および推論レベル `Low` / `Medium` / `High` / `Extra High`）への切り替えをユーザーへプロアクティブに提案すること。

1. **Gemini 3.8 Flash (`Low` / `Medium` / `High`) — 軽量高速・定型運用向け**:
   - **`Low` / `Medium`**: 日常的な Q&A、状況確認、ドキュメントの誤字脱字修正・軽微な体裁調整、単発のコマンド確認。
   - **`High`**: 対象範囲が限定された軽量なコード調査、定型的なシナリオ展開、テスト実行とログ確認の反復。
   - *提案タイミング*: 重い設計や複合実装が完了し、軽量な確認作業や定型運用フェーズへ移行する場面（「軽量な確認・定型作業が中心のため、`Gemini 3.8 Flash (Medium / High)` への切り替えが高速で効率的です」と提案）。

2. **Gemini 4 Hydrogen (`Low` / `Medium` / `High` / `Extra High`) — 実装・デバッグの標準主力**:
   - **`Low` / `Medium`**: 対象ファイルが 1〜2 個に絞られたピンポイントの修正、ビルド実行、回帰テストの合否検証、Git コミット。
   - **`High` (標準)**: 設計確定後の具象コード実装（RTL / C++ / Python / JS）、一般的なバグの原因調査と修正、複数ファイルにまたがる通常の機能改修。
   - **`Extra High`**: 単一コンポーネント内の複雑なロジック実装や、単一スレッドで粘り強く追うべき中〜高難度のバグ解析（設計の根本見直しまでは要しない場面）。
   - *提案タイミング*: 設計確定後や、`Orchestra` / `Gemini 4 Neon` での抽象設計・大規模展開が終わった後の実装・検証フェーズ（「ここからの実装・検証は `Gemini 4 Hydrogen (High)`（軽微作業なら `Medium`）が効率的です」と提案）。

3. **Gemini 4 Neon (`Low` / `Medium` / `High` / `Extra High`) — 深い仕様検討・設計特化**:
   - **`Low` / `Medium`**: 既存設計の枠内での方針確認、小規模な設計レビューやドキュメント構成の相談。
   - **`High` (標準)**: コード編集や並列テストを伴わない純粋な仕様議論・設計の壁打ち、`ARCHITECTURE_MANIFEST.md` の改定、新しい ADR の起草、トレードオフの根本的再設計。
   - **`Extra High`**: 失敗の許されないアーキテクチャ境界の厳密設計や、単一スレッドで論理を徹底的に検証すべき難解な静的解析（同期競合・複雑な状態遷移等）。
   - *提案タイミング*: 実装着手前に仕様・設計・ADR を固める段階や、難解な単体設計の詰めに集中する場面（「実装前に設計と仕様を固めるため、`Gemini 4 Neon (High / Extra High)` への切り替えを推奨します」と提案）。

4. **Orchestra — 複数レイヤー横断・並列オーケストレーション**:
   - **推奨シーン**:
     - **複数レイヤー横断の新規実装**: RTL / C-Shim / Linux / ダッシュボード UI / テストを連動させて一気通貫で構築・検証する作業。
     - **全シナリオ横断監査・一括リファクタリング**: 全テストシナリオの DTS チェック、多数ファイルへの横展開、大規模ドキュメント監査など、サブエージェントの並列稼働が活きる作業。
     - **原因箇所不明の複合バグ調査**: どのレイヤーに原因があるか不明な不具合を並列調査し、特定から修正・回帰テストまで完遂する作業。
     - **計画書に基づく自律進行**: 計画書（Plan MD 等）に沿って設計・実装・テストの複数ステップを一任する場面。
   - *提案タイミング*: 作業対象が複数レイヤー・多数ファイルに広がり、並列処理や段階的統括が有効と見えた段階（「複数レイヤー横断・並列作業のため、`Orchestra` への切り替えが最適です」と提案）。

5. **Gemini 4 Argon (`Low` / `Medium` / `High`) — 超難関・極限課題専用の切り札**:
   - **推奨シーン**:
     - **`Low` / `Medium`**: `Gemini 4 Neon (Extra High)` でも判断が割れる高度な設計トレードオフのセカンドオピニオンや最終レビュー。
     - **`High`**: プロジェクトの根幹に関わるアーキテクチャ刷新、複数プロセス・RTL・RTOS にまたがる極めて難解な未解決バグの突破など、長時間の深い推論を要する極限課題。
   - *提案タイミング*: クォータ消費が大きいため通常タスクでは提案せず、`Gemini 4 Neon` や `Orchestra` でも突破が困難な極限課題に直面した場合のみ理由を明示して提案する。

# Ollama Routing Rules

以下のタスクは、APIクォータ節約のため Ollama ツールを優先して使用し、タスクの性質に応じてモデルを切り替えること。ただし、**失敗によるやり直し（クォータの二重消費）を防ぐため、エージェントは事前にタスクの複雑さをスクリーニングすること**：

- **二度手間防止ルール（Gemini直行）**:
  - 技術的ドキュメントの文脈を考慮した推敲、複雑なバグの静的解析・原因究明、複数ファイルにまたがる設計レビューなど、ローカルLLMが指示をこぼして「失敗してやり直すリスクが高いタスク」は、Ollamaを介さず**最初からメインモデル（Gemini 4 Hydrogen / Neon / Gemini 3.8 Flash 等）で一発実行すること**。

- **Ollama 優先タスクとモデルの使い分け**:
  - **機械的なテキスト・データ変換タスク**（例：データ表のMarkdownテーブル化、単純なエラーログ抽出・ダイジェスト化、短いUI文言の翻訳など）
    - 使用モデル: `qwen3.6:35b` (または `deepseek-r1:14b`)
  - **定型的なコーディングタスク**（例：C++ヘッダーからRust `extern "C"` への構造変換、テスト用ダミー配列データの生成、機械的なリネームやフォーマット整形など）
    - 使用モデル: `qwen2.5-coder:7b`
  - **Gitコミットメッセージの生成（英語）及び `git diff` の要約**:
    - 使用モデル: `qwen3.6:35b` (または `qwen2.5-coder:7b`)
    - 役割: `git diff` から英語のコミットメッセージや変更点の要約テキストをローカルで自動生成する。
  - **レポートやドラフトの日本語翻訳**:
    - 使用モデル: `qwen3.6:35b` (または `deepseek-r1:14b`)
    - 役割: メインモデルが英語で作成したドラフトやレポートを、日本語へ翻訳して最終出力する。

# Language & Thinking Preference

- **思考プロセス**: メインモデル（Gemini 4 Hydrogen / Neon / Gemini 3.8 Flash 等）は、推論精度を高めトークンを節約するために、内部的な思考や作業ドラフトの構築を英語で行うこと。
- **レポートの出力**: 英語で指示された場合であっても、回答やレポートは常に日本語で出力すること。
- **翻訳のOllama委譲**: 英語で構成した思考やドラフトを日本語のレポートとして出力する際、翻訳処理はローカルLLMであるOllama（`qwen3.6:35b`）を使用して実行すること。
  - **Ollama待機時の節約ルール**: Ollamaの処理をバックグラウンドで走らせている間（応答待ちの間）は、メインモデル（Gemini 4 Hydrogen / Neon / Gemini 3.8 Flash 等）のトークンを無駄に消費しないよう、中間報告や詳細な進捗解説、余計な診断コマンドの実行を避け、最小限のステータス（1行程度）を出力して静かにタイマーで待機すること。
  - **Docker環境でのOllamaホスト指定**: DockerコンテナからホストPC側のOllamaサーバーへ接続する際は、必ず環境変数 `OLLAMA_HOST=host.docker.internal:11434` を付与して実行すること。

# 順法セルフチェック・プロトコル (Compliance Self-Check Protocol)

エージェントは、ツール呼び出しや最終回答の出力を行う前に、**必ず思考プロセス（thought）内で以下のチェックリストを自己検証し、思考ログに明記すること。** この自己検証ステップの省略は規約違反とみなされます。

1. **Ollama優先タスクおよびモデルルーティングの確認**:
   - 実行しようとしている作業に「Gitコミットメッセージ生成」「翻訳・ダイジェスト化」「定型コーディング」が含まれるか？
     - **含まれる場合**: メインモデル側で直接ドラフトテキストを作成・実行せず、必ず `ollama-mcp` ツールを介してローカルモデルに委託すること。
     - **含まれない場合**: メインモデルで実行する妥当な理由（例：「複雑なC++バグ解析のため」等）を思考プロセスに1行記述すること。
   - 作業内容が「High-Level Model Routing」の切り替えトリガー（`Gemini 3.8 Flash` / `Gemini 4 Hydrogen` / `Gemini 4 Neon` / `Orchestra` / `Gemini 4 Argon` および推論レベル `Low`〜`Extra High`）に合致するか？ 合致する場合は作業着手前やフェーズ移行時に適切なモデルと推論レベルへの切り替えをプロアクティブに提案すること。
2. **実行前の最終ゲートチェック**:
   - Markdown ファイルを新規作成・編集した場合、AI 独自の造語・過度なスラング・用語ブレ（標準用語や `PPA` / `DPPA` / `GTR` / `C-Shim` 等の公式名称からの逸脱）が混入していないか確認したか？
   - コミット実行時、メッセージは Ollama から返ってきた出力結果を適用しているか？
   - コミットの実行前に、必ずユーザーのレビューおよび明示的な承認（レビュー終了の合意）を得ているか？（**厳守項目**）
3. **Git Push の完全禁止（厳守項目）**:
   - エージェントはいかなる状況下であっても `git push` コマンドを実行してはならない。エージェントが担当する Git 操作はローカルでのコミット（`git commit`）までに厳格に限定し、リモートリポジトリへのプッシュはすべてユーザー自身の手動操作に委ねること。
