# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-05-19
- 対象バージョン: 2.1.0

## 1. 概要

- 目的: Codex CLI / Claude Code のローカル履歴を VS Code 上で閲覧・検索・整理・再開しやすくする
- 対象データ:
  - Codex: `~/.codex/sessions` 配下の `rollout-*.jsonl`
  - Claude: `~/.claude/projects/<project>/<session>.jsonl`
- 通信: ネットワーク通信は行わない。ローカルファイルと VS Code のストレージだけを扱う
- 対応ソース: `codexHistoryViewer.sources.enabled` で `codex` / `claude` を切り替える

## 2. ディレクトリ構成（主要）

- `src/`: TypeScript 実装
- `dist/`: ビルド成果物
- `media/`: Webview（チャット表示）用の CSS / JS
- `l10n/`: 実行時 UI / Webview 用のローカライズバンドル
- `package.nls*.json`: VS Code manifest (`package.json`) 用のローカライズ
- `resources/`: アイコン等
- `docs/`: 補助ドキュメント
- `SECURITY.md`: セキュリティポリシーと既知アドバイザリへの対応方針

## 3. 機能仕様

### 3.1 ビュー

- **Control**: 全体操作と保守操作
  - `Open Settings`
  - `Configure Default Search Roles`
  - `Refresh All`
  - `Undo Last Action`
  - `Import Sessions`
  - `Rebuild Cache`
  - `Rebuild Search Index`
  - `Cleanup Missing Pins`
  - `Bulk Rename Tag`
  - `Bulk Delete Tags`
  - `Delete Handoff Files`
  - `Empty Trash`
- **Pinned**: ピン留め済みセッション一覧
  - タグ絞り込み対応
  - 欠損ピンも表示対象
  - `History` / `Search` からのドラッグ&ドロップで追加可能
- **History**: 年 / 月 / 日でグルーピングした履歴ツリー、または最新順のフラット一覧
  - 表示モード: `日付別` / `最新順`
  - 絞り込み: 日付スコープ / プロジェクト (`cwd`) / ソース / タグ
  - ヘッダー操作: 再読み込み、表示モード切替、絞り込み、現在のプロジェクトで絞り込み、ソース切替、絞り込み解除など
  - 複数選択で開く / エクスポート / Promote / Delete が可能
  - 初回履歴ロード中は、空状態案内ではなく読み込み中ノードを表示する
  - 履歴が 0 件の場合は、履歴保存先確認・再読み込み・Claude 有効化に関する案内ノードを表示する
  - 絞り込み適用後に一致する履歴がない場合は、絞り込み条件の変更 / 解除を促す案内ノードを表示する
- **Search**: 検索結果ツリー
  - 表示構造: セッション -> ヒット一覧
  - ヘッダー操作: `Search...`、`Rerun Search`、`Clear Results`、タグ絞り込み、保存済み検索、既定ロール設定
  - 検索対象は History 側の「日付 / プロジェクト / ソース」絞り込みに追従する
  - Search 独自のタグ絞り込みも別途持つ
- **Status**: 実行時状態の要約
  - 有効ソースごとのセッション件数
  - ピン数 / 欠損ピン数 / 保存済み検索数 / 総タグ数
  - キャッシュフォルダ容量
  - Handoff 件数 / 容量
  - ゴミ箱件数（`undo-delete` + `deleted` の合算）
  - 現在の検索ロール / 検索タグ / 履歴絞り込み / 現在プロジェクト / 最終更新時刻
  - 有効ソースごとのセッションルート
  - 拡張機能バージョン
  - `Current project` と `Sessions root` 系のパスは行右側のコピーアイコンからクリップボードへコピーできる

### 3.2 セッション操作

- `Open in New Tab (Chat)`: Webview で会話をセッションタブとして表示
- `Custom Title...`: QuickPick からカスタムタイトルの設定 / 消去を選択する
- `Open Session (Markdown)`: 仮想ドキュメントとして Markdown 化して表示
- `Copy Quick Prompt`: チャット表示内で、タスクと直近メッセージだけの軽量な再開用プロンプトをクリップボードへコピー
- `Resume in OpenAI Codex`: OpenAI Codex 拡張へ引き継ぐ
- `Resume in Claude Code`: Claude Code 拡張へ引き継ぐ
- `他のAIへ引継ぎ`: Handoff 用の階層メニューを表示する
- `Pin / Unpin`: ピン留めの追加 / 解除
- `Promote to Today (Copy)`: セッションを「今日」の履歴として複製する
- `Delete`: 削除確認後に削除する
- `Undo Last Action`: delete / pin / annotation / tag 操作などを 1 手戻す
- `Edit Session Annotation`: タグ / ノート編集
- `Export Sessions`: 生 JSONL または Markdown transcript を出力
- `Import Sessions`: フォルダ単位で `.jsonl` を再帰取り込み

### 3.2.1 他のAIへ引継ぎ

- 表示条件:
  - `codexHistoryViewer.handoff.enabled` が有効で、History / Pinned / Search の表示中セッションであれば、`Sources: Enabled` の組み合わせに関係なく Handoff 階層メニューを表示する
  - `codexHistoryViewer.handoff.enabled` が無効な場合は、Handoff 階層メニューと作成 / コピー / 開く操作を表示しない
  - `Sources: Enabled` を見るのは、Codex セッションの `Claude Code へ引き継ぐ` メニュー表示だけに限定する
- メニュー構成:
  - `Claude Code へ引き継ぐ`: Codex セッションかつ Codex / Claude の両ソースが有効な場合のみ表示し、Handoff ファイルを作成または既存利用して Claude Code を開く
  - `引き継ぎファイルを作成`: 選択セッションの Handoff ファイルを作成する
  - `引き継ぎプロンプトをクリップボードにコピー`: Handoff ファイルを参照するプロンプトをクリップボードへコピーする
  - `引き継ぎファイルを開く`: 選択セッションに対応する Handoff ファイルを開く。存在しない場合は作成確認トーストを出し、承認時は作成後に開く
- `Delete Handoff Files` と Status の Handoff 件数 / 容量は保守機能として残し、`handoff.enabled` が無効でも利用できる
- Claude から Codex への引き継ぎは Codex 側の入力欄へ自動投入できないため、通常メニューには出さず、プロンプトのクリップボードコピーで扱う
- `引き継ぎプロンプトをクリップボードにコピー` は、既存 Handoff ファイルがある場合は確認なしで既存ファイルを参照するプロンプトをコピーし、存在しない場合だけ新規作成して作成込みのコピー完了通知を出す
- `Claude Code へ引き継ぐ` と `引き継ぎファイルを作成` は、既存 Handoff ファイルがある場合に「既存を使う / 再作成」を確認する
- Handoff プロンプトは UI 言語に応じてローカライズし、作業開始前にファイルを読ませ、理解後は短い確認応答だけを返すよう促す
- Handoff ファイル (`handoff.md`) の本文ラベルは token 節約のため英語で固定する
- Handoff ファイルには、末尾優先の transcript 抜粋、直近のユーザー依頼、復元可能なファイル変更、`Source session file` を含める
- Handoff ファイルには tool call と tool output を含めない

### 3.3 検索

- 検索方式: フルテキスト検索
- クエリ構文:
  - 通常部分一致
  - `exact:...`
  - `re:...`
  - `/regex/`
  - `AND` / `OR` / `NOT`
- ロール絞り込み:
  - 既定: `user`, `assistant`
  - 任意追加: `developer`, `tool`
- 検索対象:
  - メッセージ本文
  - ツール引数 / ツール出力（`search.indexToolContent` の設定に従う）
  - セッションの表示タイトル / カスタムタイトル / オリジナルタイトル
  - セッション注釈のタグ / ノート
- 保存済み検索:
  - 実行
  - 保存
  - 削除
- `Rerun Search` は最後に使った検索条件を再実行する
- カスタムタイトルは検索対象に含め、検索結果の表示タイトルにも反映する

### 3.4 キャッシュ / インデックス / 保守

- 履歴キャッシュ:
  - 保存先: `globalStorageUri/cache.v8.json`
  - 用途: 一覧表示用の要約キャッシュ
  - セッションファイル処理は上限付き並列で行う（無制限 `Promise.all` は使わない）
  - 再利用条件:
    - `sessionsRoot`
    - `claudeSessionsRoot`
    - 有効ソース設定
    - `preview.maxMessages`
    - 日付時刻設定キー
    - 各ファイルの `mtime` / `size`
- Codex タイトルキャッシュ:
  - 保存先: `globalStorageUri/codex-title-cache.v1.json`
  - 用途: `session_index.jsonl` から消えた古いタイトルも引き続き表示できるようにする
  - 対象: `history.titleSource = nativeWhenAvailable` で利用する Codex のネイティブタイトル
- カスタムタイトル:
  - 保存先: VS Code `globalState`
  - 用途: 本家履歴ファイルを変更せず、この拡張機能内だけで表示タイトルを上書きする
  - 保存キーは可能な限り `source:id:<sessionId>` を使い、ID がない場合のみ `source:path:<fsPath>` にフォールバックする
  - 最大 120 文字を超える入力はエラーにする
- 検索インデックス:
  - 保存先: `globalStorageUri/search-index.v2.json`
  - 用途: 繰り返し検索を高速化する増分インデックス
  - 現在の履歴インデックスに存在しない孤立エントリは `ensureUpToDate()` で削除する
  - 再利用条件:
    - `sessionsRoot`
    - `claudeSessionsRoot`
    - 有効ソース設定
    - `search.indexToolContent`
    - 各ファイルの `mtime` / `size`
  - `search.indexToolContent`:
    - `conversationOnly`: 会話本文とタイトル / 注釈だけを保存する
    - `toolCalls`: 会話本文に加えてツール名 / 引数を保存する
    - `toolCallsAndOutputs`: 会話本文、ツール名 / 引数、ツール出力を保存する（互換性維持の既定値）
  - Codex の `custom_tool_call` は `toolCalls` / `toolCallsAndOutputs` のとき、tool 名、action、command、files、paths などの軽量メタだけを保存する
  - `custom_tool_call` の patch / diff 本文、巨大 JSON、base64 / data URI、secret / token / password 系キーの値は保存しない
  - Codex の `custom_tool_call_output` は `toolCallsAndOutputs` のときだけ、取得できる場合に status / exitCode / durationMs / success / error などの短い実行メタだけを保存する
  - ファイル履歴向けの `fileChangeHints` は関連セッションの優先付け補助として使う。最終的な diff 抽出結果の正しさは元のセッション JSONL の再解析で担保する
  - 保存形式: 整形なし JSON（サイズ削減のため）
- Handoff 生成ファイル:
  - 保存先: `globalStorageUri/handoffs/<source>/<source-root-relative-path-with-final-stem>/`
  - 例: Claude の `~/.claude/projects/<project>/<session>.jsonl` は `handoffs/claude/<project>/<session>/handoff.md` に対応する
  - 通常は 1 つの元セッションに 1 つの Handoff ディレクトリを対応させ、同じセッションで作り直す場合は上書きする
  - ソースルートからの相対化ができない場合は `handoffs/<source>/by-hash/<hash>/` にフォールバックする
  - `handoff.md` と生成メタデータを同じディレクトリへ保存する
  - 自動整理では 30 日超または 100 ディレクトリ超の古い Handoff ディレクトリを削除対象にする
- `Rebuild Cache`:
  - 実行前に確認ダイアログを出す
  - 履歴キャッシュと検索インデックスを両方とも強制再作成する
  - 実行後は検索結果をクリアする
- `Rebuild Search Index`:
  - 検索インデックスだけを強制再作成する
  - `search.indexToolContent` 変更時は通知から再作成を実行できる
- `Delete`:
  - 既定は OS のゴミ箱 / リサイクルビンへ移動
  - 失敗時は `globalStorageUri/deleted` に退避
  - Undo 用バックアップを `globalStorageUri/undo-delete` に作成
  - Undo アクションの破棄 / clear / 完了時に不要バックアップを cleanup する
- `Undo Last Action`:
  - メモリ上の Undo スタックは直近 20 件を上限とする
  - 上限超過で破棄された Undo アクションは cleanup hook を実行する
- `Delete Handoff Files`:
  - `globalStorageUri/handoffs` 配下の Handoff 生成ファイルを手動削除する
  - 実行前に Handoff 件数と容量を確認ダイアログで表示する
- `Empty Trash`:
  - `deleted` と `undo-delete` を手動削除する
  - あわせて旧世代の `cache.v*.json` / `search-index.v*.json` も削除する
  - ダイアログと Status 表示上の件数は「ゴミ箱件数」のみを扱う
- 自動削除:
  - 履歴キャッシュ、検索インデックス、ゴミ箱はユーザー操作 (`Empty Trash` / `Rebuild Cache`) に委ねる
  - Handoff 生成ファイルは作成時に古い世代だけを整理し、全削除はユーザー操作 (`Delete Handoff Files`) に委ねる

### 3.5 自動更新

- 履歴の自動更新設定は既定では無効 (`codexHistoryViewer.autoRefresh.enabled = false`)
- 有効時は Codex / Claude の履歴 `.jsonl` を監視する
- 変更イベントは `autoRefresh.debounceMs` でまとめ、`autoRefresh.minIntervalMs` より短い間隔では refresh しない
- 実際の refresh 実行条件:
  - History view が表示中、または自動更新オンのチャットタブが開いている
  - VS Code ウィンドウがフォーカス中
- 自動更新オンのチャットタブは、エディタ上で裏タブになっていても更新対象にする
- VS Code ウィンドウ非フォーカス中、または更新対象 consumer がない間の変更は pending として保持する
- フォーカス復帰時、または更新対象 consumer が現れた時に pending があれば更新予約する
- チャットヘッダーの自動更新ボタンは、履歴の自動更新設定が有効なときだけ表示する
- チャットタブの自動更新モードは `off` / `preserve` / `follow` を持つ
- 新規チャットタブ、または再利用タブで別セッションへ切り替わったチャットタブは `off` から開始する
- 同じセッションの既存チャットタブを再表示する場合は、そのタブの自動更新モードを維持する
- `preserve` は現在の表示位置と UI 状態を維持して再読み込みする
- `follow` は UI 状態を維持し、最新の表示カードへスクロールする。ただし末尾が grouped diff カードの場合は、直前の非 diff 表示カードを優先する
- 自動更新では Search 結果を消さない
- 自動更新では検索インデックス再構築を行わない

### 3.6 チャット表示 / 画像

- チャット表示では Codex / Claude のメッセージ内に含まれる対応画像をサムネイル表示する
- 対応形式:
  - `image/png`
  - `image/jpeg`
  - `image/gif`
  - `image/webp`
- 対応入力:
  - base64 / data URI 形式の画像データ
  - セッションの CWD から解決できるローカル画像ファイル
- `<image></image>` のような画像プレースホルダーだけが残る場合は、本文からプレースホルダーを除去し、表示不能状態の画像カードを表示する
- remote-only / API 参照のみ / 未対応形式 / 欠損ファイル / サイズ超過 / 設定無効の場合は、画像カードに理由を表示する
- 対応画像の実データは初回描画では Webview に送らず、表示範囲に入ったサムネイルやプレビュー要求時にオンデマンドで読み込む
- `images.maxSizeMB` はプレビュー表示と保存のために読み込む画像サイズ上限として扱う
- `images.thumbnailSize` はチャット本文内のサムネイルサイズだけを切り替える
- サムネイルクリックで Webview 内の画像プレビューモーダルを開く
- 画像プレビューモーダル:
  - 上部ヘッダーに、1 枚の場合も含めてサムネイルを表示する
  - 複数画像はサムネイル、前後ボタン、左右キーで切り替える
  - 先頭 / 末尾を超えて反対側へループしない
  - 画像が多い場合はサムネイル列を横スクロールできる
  - fit 表示 / 原寸表示を切り替えられる
  - 表示中の画像を保存できる
  - `Escape`、閉じるボタン、背景クリックで閉じる
  - 別セッションへ切り替わった場合は閉じる
- チャットのスクロール領域は固定ヘッダーの下に分離し、スクロールバーがヘッダー横から始まらないようにする
- チャットヘッダーには、検索ボタンと再読み込みボタンの間に自動更新ボタンを置く
- チャットヘッダーには、ピン留めボタンの右にカスタムタイトルの pencil アイコンを置き、QuickPick から設定 / 消去を選べるようにする
- チャットタブの自動更新ボタンは、履歴の自動更新設定が有効なときだけ表示し、`off` / `preserve` / `follow` をクリックで循環する
- `preserve` / `follow` はボタンの背景色でオン状態を示し、`follow` はさらに別色で追従中であることを示す
- チャットの先頭 / 末尾スクロールは、スクロールコンテナの絶対端ではなく、実際に描画されている最初 / 最後のカードを対象にする
- 自動更新 `follow` は、末尾が grouped diff カードの場合に直前の非 diff カードへ追従する。非 diff カードがない場合は最後の diff カードへフォールバックする
- `Show details` OFF で描画されないカードは、先頭 / 末尾スクロールおよび `follow` の対象に含めない
- `Show details` OFF では tool 引数 / tool 出力 / patch diff 行などの重い詳細を省略し、必要時に full detail を再読み込みする
- `chat.performanceMode` は `auto` / `normal` / `simplified` を持つ
  - `auto`: ファイルサイズ、item 数、diff entry 数、diff 行見積もり、画像数に応じて `normal` / `simplified` を選ぶ
  - `normal`: 表示状態をできるだけ保持する
  - `simplified`: diff 本文や詳細を必要時に読み込み、タブ再表示時は重い描画済み section を一時的に軽量化する
- チャットヘッダーのパフォーマンスモードボタンは、この画面だけの一時設定として `auto` / `normal` / `simplified` を循環する。永続化は設定側で行う
- タブ再表示や `visibilitychange` 復帰時は restore cover で本文領域を覆い、レイアウト安定後に cover を外す。cover 中は date guide 更新と重い diff body 復元を保留する
- assistant の model / effort / token usage は `Show details` ON のときだけ、assistant 応答後の細い usage 行として表示する
- usage 行は初期状態では 1 行表示とし、クリックすると入力 / 出力 / キャッシュ / 推論 / 累計 / context window / rate limit / service tier など取得できた項目だけを展開表示する
- CWD / Git ブランチ / Git コミット / dirty 状態が取得できた場合は、`Show details` ON のときだけ environment 行として表示する
- tool の status / exit code / duration / interruption / error が取得できた場合は、`Show details` ON の tool カードにメタ情報として表示する
- `Show details` の ON/OFF では切り替え前に見えていたカードを基準にスクロールを復元し、対象カードが非表示なら次の表示カードへ移動する
- `chat.openPosition`:
  - `top`: 通常は先頭から開く
  - `lastMessage`: 最後に見えていたメッセージ付近を復元する
  - `latest`: ヘッダーの末尾ボタンと同じく、描画されている最新のカードへ移動する
  - 保存 / 復元の単位は本文メッセージの `msg-*` アンカーとする
  - `latest` は保存位置を使わず、表示時点で描画済みの最後のカードを対象にする
  - 保存時に画面内の本文メッセージがない場合は、直前の描画済み本文メッセージを保存し、直前もなければ先頭扱いにする
  - 復元対象の本文メッセージが描画されていない場合は、直前の描画済み本文メッセージへフォールバックし、直前もなければ先頭へ戻す
  - 復元フォールバックでは直後の本文メッセージへは進めない
- ツリー選択で開くチャットは再利用タブとして扱い、次のツリー選択で中身を差し替える
- メニューから開くチャットはセッションタブとして扱い、別セッションを開いても差し替えない
- 再利用タブに表示中の同じセッションをメニューから開いた場合、そのタブをセッションタブへ昇格する
- ツリー選択 / メニュー操作のどちらでも、同じセッションのチャットタブが既に開いていれば既存タブをアクティブにする
- Reload とチャットタブの自動更新は、表示位置、選択メッセージ、詳細表示、展開カード、展開 diff、diff 折り返し、検索サイドバー状態を維持する
- 再利用タブで別セッションへ切り替わる場合は、検索状態、検索リサイズ状態、画像プレビュー、画像データキャッシュ、画像保存先 CWD、patch entry 詳細の pending 要求などのセッション依存 UI / panel-side 状態をリセットする
- grouped diff カードの最大幅状態は、再読み込みでカードの並び順が変わっても維持しやすいように安定キーで管理する

### 3.6.1 AI Change History（ファイル単位の AI 更新履歴）

- 目的:
  - ワークスペース内の 1 ファイルを起点に、そのファイルへ影響した Codex / Claude の AI diff 履歴を時系列で確認できるようにする
  - diff から元の通常履歴 Webview の該当 diff カードへ戻り、会話文脈を確認できるようにする
- 起動方法:
  - Command Palette / Explorer ファイル右クリックメニューから `Show File AI Change History` を実行する
  - Explorer ファイル右クリックメニューへの表示は `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled` が `true` のときだけ有効
  - ディレクトリは対象外。ワークスペース外のファイルも対象外
- 対象範囲:
  - 現在開いているワークスペース配下の対象ファイルだけ
  - `codexHistoryViewer.sources.enabled` で有効な source だけ
  - Claude は復元可能な diff がある変更だけ表示する
  - `search.indexToolContent = conversationOnly` でも利用可能。ただし tool メタ情報が検索インデックスに少ないため、関連セッションの優先付け精度が下がる場合がある
- 表示:
  - ファイル名 / 相対パス / 総件数 / source 別件数をヘッダーに表示する
  - Codex / Claude はヘッダーの source toggle で絞り込める
  - diff card は通常履歴 Webview の diff card と同じ見た目・操作感に寄せる
  - diff は Webview 内の独自レンダリングで表示し、VS Code 標準 Diff Editor / `vscode.diff` は使わない
  - 初期表示と追加読み込みは日付昇順
  - 通常サイズの diff は初期展開し、巨大 diff は折りたたむ
  - 1 card は選択ファイル 1 変更分として扱う。move / rename で before / after の両方が一致しても 1 card にまとめる
- 操作:
  - `対象ファイルを開く`: VS Code の通常エディタで対象ファイルを開く
  - `ファイルパスをコピー`
  - `再読み込み`
  - Webview 内検索（case-insensitive）
  - `続きを読み込む`
  - 前 / 次の diff card へ移動。source toggle で絞り込んでいる場合は、表示中 card だけを移動対象にする
  - `履歴で開く`: 通常履歴 Webview を現在のエディタグループに別タブとして開き、該当 diff card へスクロールする。`patchEntry` reveal では full detail mode を強制しない
- 追加読み込み:
  - 成功 / 失敗 / キャンセルのいずれでも現在のスクロール位置を維持する
  - 追加後は通知相当の短いメッセージだけを表示し、追加分へ自動移動しない
  - 初回読み込み / 再読み込み後にまだ続きがある場合は、`続きを読み込む` で追加できることを toast で案内する
  - `続きを読み込む` 成功後もまだ続きがある場合は、追加件数と続きがある旨を同じ toast にまとめ、同系統の toast は重ねず置き換える
  - 全候補を解析済みの場合は `これ以上の履歴はありません` を表示し、`続きを読み込む` を消す
- date guide:
  - `codexHistoryViewer.ui.timeGuide.enabled` が `true` のときだけ表示する
  - ファイル履歴では範囲に応じて day / month / year に自動スケールする
  - マウスオーバー、手動スクロール、キーボードスクロールで表示する
  - 自動更新追従、先頭 / 末尾ボタン、前後カード移動、reveal target への自動ジャンプでは表示しない
  - 日付ガイド外クリックで即座に閉じる。ただしガイド上にマウスがある間は閉じない
- source 表示:
  - source icon は light / dark 両方を Webview へ渡し、VS Code Webview theme class に合わせて切り替える
  - 色だけで source を区別せず、icon + label を表示する

### 3.6.2 しおり / 日付ガイド

- しおり:
  - 通常履歴 Webview とファイル履歴 Webview のカードに、しおり ON/OFF を付けられる
  - しおり状態は VS Code `globalState` に保存し、元のセッション JSONL は変更しない
  - 通常履歴 Webview とファイル履歴 Webview は同じしおり状態を共有する
  - Codex の grouped diff / ファイル履歴 diff は、可能な限り `turn:<turn_id>` を使った `patchGroup` 単位のキーで同期する
  - `turn_id` がない Codex patch は `call_id`、`payload.timestamp`、JSONL record の `timestamp`、JSONL 行番号へ順にフォールバックする
  - Claude tool use 由来の patch は `tool_use.id` を優先し、欠如時は JSONL 行番号と同一行内の tool call index へフォールバックする
  - 旧しおりキーの互換読み取りは行わない。キー生成規則変更前のしおりは付け直しを前提とする
  - セッション削除時は該当セッションのしおりも削除し、Undo では削除前のしおりを復元する
- しおり UI:
  - `codexHistoryViewer.ui.timeGuide.enabled = true` のときだけ、カード上のしおりボタンを表示する
  - `codexHistoryViewer.ui.timeGuide.enabled = false` のときは、日付ガイドとカード上のしおり UI をどちらも表示しない
  - しおり済みカードはカード側でも強調表示する
  - ファイル履歴 Webview の `履歴で開く` ボタンはアイコン付きで表示する
- 日付ガイド上のマーカー:
  - しおり位置は黄色の丸で表示する
  - user 位置は青系の丸で表示する
  - user としおりが同じ位置にある場合は、黄色丸を主表示しつつ青系の外周表現を残す
  - 現在位置は通常ドットとは別の最前面リングとして表示し、user / しおり / 密集マーカーに隠れないようにする
  - 日付ガイドの開閉条件や表示維持条件は、しおり有無では変えない
- 巨大履歴向けの密集レンズ:
  - 日付ガイド上のマーカーが密集している場合だけ、右レール左側に拡大レンズを表示する
  - 通常時は既存の日付ガイド表示を維持し、常時拡大はしない
  - 密集判定は近辺の item 数と隣接間隔を基準にする
  - レンズ内では対象 item を縦方向に広げ、最低間隔を確保する
  - レンズ内でも user / しおり / 現在位置の表現を維持する
  - 右側の元レール上をマウスオーバーすると、レンズ内の最も近い item を active にし、その tooltip を表示する
  - 右側の元レール上をクリックすると、レンズ内で tooltip が出ている item へ移動する
  - レンズ内へポインタを移した場合は、元レール連動 tooltip を抑制し、hover 中のレンズ item の tooltip だけを表示する
  - レンズは件数に応じて高さを変え、最小 140px、最大 220px、かつ画面高さの 45% を上限とする
  - レンズ内の item 選択では現在位置としおりを優先し、user だけで埋まらないよう通常 item も混ぜる

### 3.7 設定（`codexHistoryViewer.*`）

- `sessionsRoot`
- `claude.sessionsRoot`
- `sources.enabled`
- `handoff.enabled`
- `preview.openOnSelection`
- `preview.maxMessages`
- `preview.tooltipMode`
- `search.defaultRoles`
- `search.indexToolContent`
- `search.caseSensitive`
- `search.maxResults`
- `fileChangeHistory.explorerContextMenu.enabled`
- `history.dateBasis`
- `history.titleSource`
- `autoRefresh.enabled`
- `autoRefresh.debounceMs`
- `autoRefresh.minIntervalMs`
- `chat.openPosition`
- `chat.performanceMode`
- `chat.toolDisplayMode`
- `chat.userLongMessageFolding`
- `chat.assistantLongMessageFolding`
- `images.enabled`
- `images.maxSizeMB`
- `images.thumbnailSize`
- `resume.openTarget`
- `delete.useTrash`
- `ui.language`
- `ui.timeGuide.enabled`
- `ui.alwaysShowHeaderActions`
- `debug.logging.enabled`

## 4. 実装要点

### 4.1 セッション探索

- `src/sessions/sessionDiscovery.ts`
  - Codex は `rollout-*.jsonl` を再帰走査で収集する
  - Claude は `.claude/projects/<project>/<session>.jsonl` の 2 階層構造のみを対象にする

### 4.2 セッション要約

- `src/sessions/sessionSummary.ts`
  - `session_meta` を読み取り、一覧用メタ情報を構築する
  - `user` / `assistant` メッセージを先頭から最大 `preview.maxMessages` 件だけ読んでスニペットを作る
  - 大きすぎるコンテキスト断片は一覧スニペットから除外する
  - Claude のネイティブタイトルは `custom-title -> ai-title -> rename -> summary` の優先順で抽出する

### 4.3 履歴キャッシュ

- `src/services/historyService.ts`
  - `cache.v8.json` を読み書きする
  - 変更のないファイルはキャッシュ済み `summary` を再利用する
  - ファイルごとの `stat` / キャッシュ判定 / `buildSessionSummary` は最大 4 並列で処理する
  - `HistoryIndex.byCacheKey` を構築し、`findByFsPath()` は `Map` で引く
  - 最終的な一覧はローカル日付 / 時刻順で降順ソートする
  - `history.titleSource` に応じて `displayTitle` を後段で解決する
- `src/services/sessionTitleOverrideStore.ts`
  - カスタムタイトルを VS Code `globalState` に保存する
  - 本家の Codex / Claude 履歴ファイルは変更しない
  - セッション ID が取れる場合は `source:id:<sessionId>`、取れない場合は `source:path:<fsPath>` をキーにする
- `src/services/codexTitleStore.ts`
  - Codex の `session_index.jsonl` と `codex-title-cache.v1.json` を使ってネイティブタイトルを解決する
  - 既知セッションだけを保持しつつ、古い Codex タイトルを軽量キャッシュとして残す
- `src/sessions/sessionTitleResolver.ts`
  - `generated` / `nativeWhenAvailable` の設定値に応じて `displayTitle` を決定する
  - カスタムタイトルがある場合は `displayTitle` として最優先する

### 4.4 自動更新

- `src/services/autoRefreshService.ts`
  - 履歴の自動更新設定 (`codexHistoryViewer.autoRefresh.enabled`) が `true` のときだけ FileSystemWatcher を作成する
  - Codex は `**/rollout-*.jsonl`、Claude は `*/*.jsonl` を監視する
  - watcher イベントは即 refresh せず、変更された `fsPath` を pending 集合に入れて debounce / min interval を適用する
  - refresh callback には変更された `fsPath` の配列を渡す
  - `History` view が非表示かつ自動更新オンのチャットタブが開いていない場合、または VS Code ウィンドウが非フォーカスの場合は timer を止めて pending を保持する
  - `vscode.window.state.focused` と `onDidChangeWindowState` により、フォーカス中のウィンドウだけ自動 refresh を実行する
  - 自動 refresh は `refreshHistoryIndex(false)`、view refresh、チャットタイトル更新、対象チャットタブ更新を行い、Search 結果のクリアや検索インデックス再構築は行わない
- `src/extension.ts`
  - 自動更新 consumer は `History` view が表示中、または `ChatPanelManager` に自動更新オンの開いているチャットタブがある場合に存在するとみなす
  - `historyView.onDidChangeVisibility`、チャット consumer 変更イベント、`onDidChangeWindowState` で `AutoRefreshService` の実行条件を更新する
- `src/chat/chatPanelManager.ts`
  - チャットタブごとに `autoRefreshMode` と `pendingAutoRefresh` を保持する
  - 開いているチャットタブは裏タブでも自動更新対象にする
  - `refreshAutoRefreshPanels(changedFsPaths)` は変更されたセッションファイルに対応するチャットタブだけ再読み込みする
  - Webview がまだ ready でない場合のみ `pendingAutoRefresh` として保持し、ready 後に 1 回反映する
  - 新規チャットタブ、または別セッションへ差し替えた再利用チャットタブは `off` から開始する
  - 同じセッションの既存タブは自動更新モードを維持する

### 4.5 検索インデックス

- `src/services/searchIndexService.ts`
  - `search-index.v2.json` を管理する
  - ファイル内 cache version が一致しない場合は既存インデックスを破棄し、次回検索時に再構築する
  - セッションごとに `mtime` / `size` を持ち、差分更新する
  - JSONL をストリーミングで読み、検索対象メッセージ列を構築する
  - `search.indexToolContent` に応じてツール名 / 引数 / 出力を検索インデックスへ入れる範囲を変える
  - Codex の `custom_tool_call` は既存 tool 検索と同じ `role: tool` / `source: toolArguments` 粒度で、軽量メタだけを入れる
  - Codex の `custom_tool_call_output` は `toolCallsAndOutputs` のときだけ `role: tool` / `source: toolOutput` として短い実行メタを入れる
  - `conversationOnly` のときは `custom_tool_call` の callId 紐付けだけを維持し、検索用メタ生成は行わない
  - 旧キャッシュに `indexToolContent` がない場合は `toolCallsAndOutputs` とみなし、既定設定のままなら不要な再作成を避ける
  - `cleanupOrphanEntries()` で現在の履歴に存在しない cacheKey を削除する
  - 実ファイルが消えている場合は `stat` 失敗時に該当エントリを削除する
  - `forceRebuild` 指定時は内部エントリをクリアして最初から作り直す

### 4.5.1 AI Change History 実装

- `src/fileHistory/fileChangeHistoryService.ts`
  - ファイル単位 AI 更新履歴の候補抽出、精密 diff 解析、ページングを担当する
  - 検索インデックスの `fileChangeHints` は候補順位付けの補助として使う
  - 最終的な diff card は必ず元のローカルセッション JSONL を読み直して生成する
  - Codex は `patch_apply_end` を第一候補にし、`apply_patch` 入力と照合して重複 diff を避ける
  - `apply_patch verification failed` など失敗出力がある場合は成功 diff として扱わない
  - Claude は `Edit` / `MultiEdit` / `Write` から復元可能な diff だけを `ChatPatchEntry` 相当へ変換する
  - 絶対パス、workspace 相対パス、session cwd 相対パス、move / rename の before / after path を正規化して照合する
  - Windows では大小文字差と区切り文字差を吸収する
- `src/fileHistory/fileChangeHistoryPanelManager.ts`
  - ファイル履歴 Webview の作成、再利用、reload、load more、通常履歴 Webview への reveal を担当する
  - panel key は workspace folder + file path で構築し、同じファイルは既存 Webview を再利用する
  - 同じファイルで再実行した場合は検索状態、scroll、cursor を初期化する
  - hidden から戻っただけでは Webview state を保持する
  - `loadMore` は世代管理と `CancellationTokenSource` で古い結果の混入を防ぐ
  - `履歴で開く` は通常履歴 Webview を現在のエディタグループに別タブとして開き、`patchEntry` reveal target で該当 diff card を開く
  - `patchEntry` reveal target では通常履歴 Webview を summary mode のまま開き、対象 diff entry の詳細だけを必要時に読み込む
  - `sendModel` では `initial` / `reload` / `loadMore` の reason を Webview へ渡し、初回・再読み込み時の追加履歴案内と load more 完了通知を分ける
- `src/fileHistory/fileChangeHistoryTypes.ts`
  - File AI Change History 用の source、card、query、reveal target などの型を定義する
- `media/fileChangeHistory.js` / `media/fileChangeHistory.css`
  - ファイル履歴 Webview のヘッダー、source toggle、検索、diff card、load more、空状態、stale banner を描画する
  - diff card は通常履歴 Webview の diff card と同じ before / after column、行番号、追加 / 削除表示を使う
  - loading 表示の fallback はタイトル文言を流用せず、`l10n/bundle.l10n.*` の loading 文言を使う
  - 検索は読み込み済み card だけを対象にし、追加読み込み後は自動で再検索する
  - 追加読み込み成功後も scroll 位置を維持する
  - 初回 / 再読み込み後に `hasMore` が残る場合は `続きを読み込む` の存在を toast で案内し、load more 後も続きがある場合は追加件数と同じ toast にまとめる
  - 前 / 次 card ナビゲーションは、source toggle 適用後の表示中 card 配列を基準にする
- `media/sharedTimeGuide.js` / `media/sharedTimeGuide.css`
  - 通常履歴 Webview とファイル履歴 Webview で共通の date guide を提供する
  - 設定が無効な場合は date guide DOM を生成しない
  - 表示単位はモードと範囲に応じて自動スケールする
  - tooltip は目盛り近辺だけで表示し、ガイド外クリックでは閉じる
  - Dark / Light / High Contrast で rail / dot が埋もれないよう theme 変数で描画する
- `src/chat/chatPanelManager.ts` / `media/chatView.js`
  - 通常履歴 Webview 側で `patchEntry` reveal target を受け取り、対象 diff card を展開・最大幅化・スクロール・一時ハイライトする
  - source、entryId、path、movePath、timestamp、messageIndex を使って候補 diff card をスコアリングする
  - `messageIndex` は補助情報として扱い、完全一致しない場合でも diff card 側の一致を優先する
- `src/settings.ts` / `src/extension.ts`
  - `fileChangeHistory.explorerContextMenu.enabled` と `ui.timeGuide.enabled` を読み取る
  - 設定変更時に既存 Webview へ i18n / stale 状態を通知する
- `package.json` / `package.nls.*`
  - `Show File AI Change History` コマンド、Explorer context menu、関連設定説明を定義する
- `l10n/bundle.l10n.*`
  - ファイル履歴 Webview の表示文字列、エラー、空状態、load more、source 件数、date guide 文字列を管理する

### 4.6 検索フロー

- `src/services/searchService.ts`
  - 検索開始時に検索インデックスの差分同期を行う
  - 削除済みファイルに対応してインデックスから不要エントリを落とす
  - 候補絞り込みは「日付 / プロジェクト / ソース / Search タグ」の順で適用する
  - 進捗表示とキャンセルに対応する

### 4.7 削除とゴミ箱

- `src/services/deleteService.ts`
  - 削除前に確認ダイアログを出す
  - Undo 用コピーを `undo-delete` に保存する
  - OS ゴミ箱失敗時は `deleted` へ退避してデータ損失を避ける
  - `cleanupDeletedSessionUndoBackups()` で不要になった Undo 用コピーを削除する
- `src/services/undoService.ts`
  - Undo スタックを直近 20 件に制限する
  - cleanup hook を `discarded` / `cleared` / `undone` の理由付きで実行する
- `src/services/storageMaintenanceService.ts`
  - キャッシュフォルダ全体容量を集計する
  - `undo-delete` / `deleted` 件数を合算して返す
  - `handoffs` 配下の Handoff 件数 / 容量も集計する。件数は `handoff.md` の数、容量は `metadata.json` を含む配下全体の合算とする
  - `Empty Trash` 実行時に旧世代キャッシュ / インデックスも整理する

### 4.8 注釈 / ピン / 保存済み検索

- `src/services/sessionAnnotationStore.ts`
  - タグ / ノートを `globalState` に保存する
- `src/services/pinStore.ts`
  - ピン留め情報を `globalState` に保存する
- `src/services/searchPresetStore.ts`
  - 保存済み検索条件を `workspaceState` に保存する
- `src/services/chatOpenPositionStore.ts`
  - 最後に見えていた表示位置を `globalState` に最大 100 セッション分保存する
  - 復元には `chat.openPosition = lastMessage` のときだけ使用する
  - `chat.openPosition = latest` は保存位置を使わず、Webview 側で最新の描画済みカードへ移動する

### 4.8.1 Handoff

- `src/services/handoffService.ts`
  - 元セッション JSONL を UTF-8 stream として読み取り、Handoff 用の transcript 抜粋とファイル変更を生成する
  - LLM による要約生成は行わず、末尾優先で transcript 本文をサイズ上限内に切り出す
  - Codex は `patch_apply_end` の `unified_diff` を復元可能なファイル変更として取り込む
  - Claude は `Edit` / `MultiEdit` / `Write` から復元可能な synthetic diff を作る
  - tool call / tool output 本文は Handoff ファイルへ含めない
  - secret / token / password 系に見える値は Handoff 用テキストへ入れる前に伏せる
  - `handoff.md` の保存先は元セッションパスから安定的に決め、同一セッションでは同じファイルを再利用または上書きする
  - `metadata.json` は Handoff ディレクトリの作成時刻、元セッション情報、生成サイズなどを保持する
  - 生成時に 30 日超または 100 ディレクトリ超の古い Handoff ディレクトリを整理する
- `src/extension.ts`
  - `handoffToClaude` は Codex セッションを対象に、既存ファイル確認後に `claude-vscode.editor.open` へ localized prompt を渡す
  - `handoffToCodex` は Codex の入力欄へ自動投入できないため、Handoff prompt をクリップボードへコピーし、可能な範囲で Codex UI を開く
  - `copyHandoffPrompt` は既存 Handoff ファイルを確認なしで使い、存在しない場合だけ作成して、作成有無に応じたコピー完了通知と `引き継ぎファイルを開く` action を出す
  - `createHandoffFile` は既存 Handoff ファイルがある場合に「既存を使う / 再作成」を確認する
  - `openSessionHandoff` は選択セッションに対応する Handoff ファイルを開き、存在しない場合は作成確認トーストから生成して開けるようにする
- `package.json`
  - `codexHistoryViewer.handoff.enabled` が有効な場合だけ、Codex / Claude の表示中セッションに Handoff 階層メニューを表示する
  - `codexHistoryViewer.handoffEnabled` context key により、Handoff 階層メニューと作成 / コピー / 開く操作の表示を切り替える
  - `codexHistoryViewer.codexToClaudeHandoffEnabled` context key により、`Claude Code へ引き継ぐ` だけ Handoff が有効かつ Codex / Claude の両ソースが有効な Codex セッションに限定して表示する
  - `引き継ぎファイルを作成` / `引き継ぎプロンプトをクリップボードにコピー` / `引き継ぎファイルを開く` は Codex / Claude セッションで表示する

### 4.9 表示

- チャット表示: `src/chat/*`
  - `ChatPanelManager` は対象ファイルの存在を確認してから開く / reload する
  - refresh や削除で元ファイルが消えたパネルは閉じる
  - `ChatPanelManager` はツリー選択用の `reusable` タブと、明示的に開いた `session` タブを区別する
  - 既存タブ検索では `session` タブを優先し、なければ同じセッションを表示中の `reusable` タブを使う
  - `ChatPanelManager` は `ChatOpenPositionStore` を使い、明示的な移動先がない場合だけ最後に見えていたメッセージ付近を復元する
  - `ChatPanelManager` は保存可能な画像をパネル単位で保持し、Webview からの保存要求時に `showSaveDialog` 経由で書き出す
  - `ChatPanelManager` は Webview からの `manageCustomTitle` message を受け取り、共通の `codexHistoryViewer.manageCustomTitle` コマンドを実行する
  - `ChatPanelManager` は表示詳細を `summary` / `full` で管理し、`summary` では tool 引数 / tool 出力 / patch diff 行を Webview model から省略する
  - `patchEntry` reveal target で開く場合は、`revealMessageIndex` があっても `summary` を維持する
  - `ChatPanelManager` は対応画像の data URI をパネル単位で保持し、Webview からの `requestImageData` に応じて必要な画像データだけ返す
  - `ChatPanelManager` は usage 行のラベルを Webview i18n として渡し、表示文字列を `l10n/bundle.l10n.*` で管理する
  - `chatModelBuilder.ts` は Codex の `turn_context.payload.model` / `effort` を assistant メッセージと usage 行へ付与する
  - `chatModelBuilder.ts` は Codex の `event_msg.payload.type = token_count` から `last_token_usage` / `total_token_usage` / `model_context_window` / `rate_limits` を usage 行に変換する
  - `chatModelBuilder.ts` は Claude の `message.model` / `message.usage` から usage 行を生成し、連続する同一 usage の重複表示を抑制する
  - `chatModelBuilder.ts` は `session_meta` などから CWD / Git ブランチ / Git コミット / dirty 状態を environment 行に変換し、同一 snapshot の重複表示を抑制する
  - `chatModelBuilder.ts` は Codex の `custom_tool_call` / `custom_tool_call_output` も tool カードとして扱う
  - `chatModelBuilder.ts` は Codex の `exec_command_end`、tool output の JSON / plain text、Claude の tool result から tool 実行メタ情報を抽出する
  - `chatImageAttachments.ts` は Codex / Claude の画像データ、ローカル画像参照、画像プレースホルダーを正規化する
  - 未対応 / 欠損 / remote-only / サイズ超過 / 設定無効の画像は表示不能理由としてモデル化する
  - `user` / `assistant` / tool / note / diff などのカードは個別に最大幅展開できる
  - grouped diff カードは前後の diff へ移動する上下ナビゲーションを持つ
  - 画像プレビューは Webview 内モーダルとして実装し、ヘッダーのサムネイル列、前後ボタン、左右キー、fit / 原寸切替、保存、閉じる操作を持つ
  - Webview のスクロール対象は `#scrollRoot` に限定し、固定ヘッダーをスクロール領域から分離する
  - チャットヘッダーの自動更新ボタンは `btnPageSearch` と `btnReload` の間に配置する
  - Webview 側は `requestReload` / `reload` message で自動更新時のスクロール・UI 状態保持を行う
  - Webview 側は `Show details` 切り替え時にカード anchor を保持し、再描画後に同じカードまたは次の表示カードへ復元する
  - Webview 側は performance mode に応じて heavy diff body の遅延描画、タブ復帰時の hibernation、restore cover 後の復元を行う
  - Webview 側は `lastMessage` の保存 / 復元を本文 `msg-*` アンカー単位で行い、対象が表示されていない場合は直前の描画済み本文メッセージ、なければ先頭へフォールバックする
  - Webview 側は `latest` のとき、保存位置を参照せず、ヘッダーの末尾ボタンと同じ最新の描画済みカードへスクロールする
  - Webview 側は usage 行を折りたたみ可能カードとして描画し、展開状態を同一セッション reload 中は保持する
  - Webview 側は environment 行を軽量メタカードとして描画し、CWD など長い値は表示崩れしないよう省略 / 折り返しする
  - Webview 側は tool 実行メタ情報を tool カードの meta tag として表示し、status はローカライズ済みラベルへ正規化する
  - Webview 側は IntersectionObserver で表示範囲付近の画像だけ data URI を要求し、セッション切替時は画像データキャッシュを破棄する
  - `follow` モードは、`#timeline` に描画済みの `.row` から追従対象を選ぶ。末尾が `patchGroup` の場合は直前の非 `patchGroup` 行を優先し、非 `patchGroup` 行がなければ最後の `patchGroup` 行へフォールバックする
  - チャット末尾ボタンは、`#timeline` に描画済みの最後の `.row` へスクロールする
  - patch group のカード幅保持キーは `turnId`、メッセージ index、変更ファイル情報などから安定的に作る
- Markdown transcript: `src/transcript/*`
- Control / Status ビュー: `src/tree/utilityTrees.ts`
- History / Pinned / Search ツリー: `src/tree/*`
  - History は `date` / `latest` の表示モードを持ち、`latest` ではセッションをフラットに降順表示する

### 4.10 ツール意味付けレイヤー

- `src/tools/toolSemantics.ts`
  - ツール名からカード表示用のメタ情報（アイコン・アクセント・ラベル）を解決する
  - `detailsOnly` / `compactCards` の表示モードを制御するビルダーを提供する
- `src/tools/toolTypes.ts`
  - ツール関連の共通型定義

### 4.11 ローカルファイルリンク

- `src/utils/localFileLinks.ts`
  - Webview / transcript 内のローカルパス文字列を VS Code URI に変換する
  - ワークスペース相対パス・行番号指定（`#L39`・`#L39-L45`・`#L39C2`）に対応する
- `src/transcript/transcriptDocumentLinkProvider.ts`
  - Markdown transcript ドキュメント上のリンクを `DocumentLinkProvider` として解決する

### 4.12 設定

- `src/settings.ts`
  - 拡張設定の読み取りヘルパーをまとめる
  - `preview.*`、`search.*`、`history.titleSource`、`autoRefresh.*`、`chat.openPosition`、`chat.toolDisplayMode`、`images.*` などの設定もここで管理する
  - 数値設定は下限 / 上限を丸め、想定外の enum 値は既定値へ戻す
  - `preview.maxMessages` は `1..50`、`search.maxResults` は `1..10000` に丸め、`package.json` の `minimum` / `maximum` と一致させる
- `src/utils/dateTimeSettings.ts`
  - 日付時刻表示は VS Code Extension Host のタイムゾーンを使う
  - UI 言語はタイムゾーン決定に使わない

### 4.13 ローカライズ

- `package.nls.json` / `package.nls.ja.json`
  - VS Code が拡張起動前に解決する `package.json` の `%...%` プレースホルダーを担当する
  - コマンド名、View 名、設定説明、拡張説明などの manifest 文言を置く
- `l10n/bundle.l10n.json` / `l10n/bundle.l10n.ja.json`
  - `src/i18n.ts` の `t(...)` から参照する実行時 UI 文言を担当する
  - 通知、QuickPick、InputBox、Webview に渡すラベル/tooltip などを置く
- `package.json` の `codexHistoryViewer.ui.ja.*` / `codexHistoryViewer.ui.en.*`
  - `codexHistoryViewer.ui.language` に合わせてメニュー文言を切り替えるための alias command
  - VS Code の表示言語ではなく拡張独自設定に従う必要があるため、例外的に言語別タイトルを直接持つ
- 実行時の View タイトルは `runtime.view.*` キーを使う
  - `package.nls.*` の `view.*` と同名にしないことで、manifest 用キーと実行時キーの責務を分ける
- TypeScript 内に UI 表示用の日本語を直書きしない
  - 新しい UI 文言は `t("...")` と `l10n/bundle.l10n*.json` に追加する
  - ソースコードコメントは英語で記述する

### 4.14 診断ログ

- `src/services/logger.ts`
  - `codexHistoryViewer.debug.logging.enabled` が `true` のときだけ OutputChannel `Codex History Viewer` に出力する
  - 出力内容は件数と処理時間のみとし、セッションパス・セッションID・メッセージ本文は含めない
  - ログ時刻はローカル時刻で出力し、`Asia/Tokyo` などのタイムゾーン名は付けない
- `src/services/historyService.ts`
  - `history.refresh done` として `totalMs` / `discoverMs` / `processMs` / `cacheHit` / `cacheMiss` などを出力する
- `src/services/searchIndexService.ts`
  - `search.index ensure done` として `orphanRemoved` / `missingRemoved` / `cacheHit` / `rebuilt` などを出力する
- `src/chat/chatPanelManager.ts`
  - `chatOpenPosition ...` として復元対象メッセージの記録 / 復元状況を出力する
  - セッションパス全体は出さず、ファイル名相当の安全化した識別子だけを出す
- `Debug Info (Copy)` のような通常 UI 導線は持たない
  - 必要時は `settings.json` で診断ログを有効化し、OutputChannel からコピーする

### 4.15 しおり / 日付ガイド実装

- `src/services/bookmarkStore.ts`
  - しおり状態を VS Code `globalState` の `codexHistoryViewer.bookmarks.v1` に保存する
  - `BookmarkTarget` / `BookmarkEntry` を正規化し、不正な key / kind / path は保存しない
  - `buildBookmarkKey` は `sessionCacheKey`、target kind、必要な識別情報から保存キーを作る
  - `patchGroup` は `groupId` がある場合にそれを優先する。Codex grouped diff では `turn:<turn_id>` を使う
  - セッション削除では `removeMany()` で該当セッションのしおりを退避付きで削除し、Undo では `restore()` で戻す
- `src/services/bookmarkIdentity.ts`
  - 通常履歴 Webview とファイル履歴 Webview で同じ `bookmarkGroupId` を生成するための共通 helper を持つ
  - Codex `patch_apply_end` は `turn_id`、`call_id`、`payload.timestamp`、record `timestamp`、JSONL 行番号の順で group id を解決する
  - Claude tool use は `tool_use.id` を優先し、欠如時は JSONL 行番号と同一行内 tool call index から fallback call id を作る
- `src/chat/chatModelBuilder.ts`
  - Codex `patch_apply_end` の grouped diff に `bookmarkGroupId` を付与する
  - `turn_id` がある場合は `turn:<turn_id>` を `bookmarkGroupId` とする
  - `turn_id` がない場合は `bookmarkIdentity.ts` の共通規則で callId / timestamp / line fallback へフォールバックする
  - `apply_patch` 入力由来の pending patch group は `apply:<callId>` を `bookmarkGroupId` として扱い、callId 欠如時は JSONL 行番号由来の fallback callId を使う
  - Claude tool use 由来の patch group には tool call と message index から `bookmarkGroupId` を作る
- `src/fileHistory/fileChangeHistoryService.ts`
  - ファイル履歴 card に `bookmarkGroupId` を付与する
  - Codex `patch_apply_end` では通常履歴 Webview と同じ `bookmarkIdentity.ts` の group id を使い、1 ファイル diff card と通常履歴 grouped diff の同期キーを揃える
  - Claude tool use の callId 欠如時も、通常履歴 Webview と同じ JSONL 行番号 / tool call index fallback を使う
- `src/chat/chatPanelManager.ts` / `src/fileHistory/fileChangeHistoryPanelManager.ts`
  - Webview model へ `bookmarkKey` / `isBookmarked` を付与する
  - Webview からの `toggleBookmark` message を受け取り、`BookmarkStore` を更新する
  - `BookmarkStore.onDidChange` で開いている Webview へ `bookmarkState` を再送し、通常履歴 Webview とファイル履歴 Webview の表示を同期する
  - `BookmarkStore.toggle()` が失敗した場合も `bookmarkState` を返し、Webview の楽観的 UI 更新を store 側の状態へ戻す
  - 初回 model 送信時は `withBookmarkState()` で算出した bookmarked keys を再利用し、同じ target 群への `getKeysForTargets()` 二重実行を避ける
- `media/chatView.js` / `media/fileChangeHistory.js`
  - `bookmarkState` を受け取り、カード上のしおりボタンとカード強調を更新する
  - 日付ガイドが無効な場合は、カード上のしおり UI も生成しない
  - 日付ガイド用 item には `bookmarked` と user role を渡し、Webview DOM にも `data-bookmarked` / `data-time-guide-role` を反映する
- `media/sharedTimeGuide.js` / `media/sharedTimeGuide.css`
  - 日付ガイド上で user / しおり / 現在位置を別表現として描画する
  - 現在位置は独立した `dateGuideCurrentMarker` として描画し、通常 tick より前面に置く
  - 密集時だけ `dateGuideLens` を表示し、近辺 item を拡大表示する
  - レンズは右側の元レール hover 位置へ追従し、active item の tooltip とクリック移動対象を同期する
  - レンズ内 hover 時は active item tooltip の二重表示を抑制する
- `l10n/bundle.l10n.json` / `l10n/bundle.l10n.ja.json`
  - しおり追加 / 解除 tooltip を実行時 Webview 文言として管理する

## 5. 開発手順

### 5.1 セットアップ

```powershell
# 依存関係をインストールします
npm install
```

### 5.2 ビルド

```powershell
# TypeScript をコンパイルします
npm run compile

# 変更監視でコンパイルします
npm run watch
```

### 5.3 VSIX 作成

```powershell
# VSIX を作成します
npm run package
```

- `scripts.package` は `vsce package --allow-missing-repository` を実行する
- 公開配布を前提にする場合は `repository` を正しく設定することを推奨する

### 5.4 v2.1.0 リリースメモ（2026-05-19）

- Codex / Claude Code 間の Handoff を新規実装した
- History / Pinned / Search のセッション右クリックに、`他のAIへ引継ぎ` 階層メニューを追加した
- Handoff 階層メニューは `codexHistoryViewer.handoff.enabled` で表示 / 非表示を切り替えられるようにした
- Handoff の作成 / コピー / 既存ファイル表示は、Handoff が有効であれば `Sources: Enabled` の組み合わせに関係なく表示中セッションで使えるようにした
- `Claude Code へ引き継ぐ` メニューだけ、Handoff が有効で Codex と Claude の両方のソースが有効な Codex セッションで表示するようにした
- Codex セッションから Claude Code へ、Handoff ファイルを作成して localized prompt 付きで開けるようにした
- Claude から Codex への引き継ぎは、Handoff prompt のクリップボードコピーを主経路にした
- Handoff ファイルは `globalStorageUri/handoffs/<source>/.../handoff.md` に保存し、元セッションに対して 1 対 1 で再利用または上書きするようにした
- Handoff ファイルには `Source session file`、末尾優先の transcript 抜粋、直近のユーザー依頼、復元可能なファイル変更を含めるようにした
- Handoff ファイルから tool call と tool output を除外するようにした
- 既存 Handoff ファイルがある場合、`Claude Code へ引き継ぐ` と `引き継ぎファイルを作成` では既存利用または再作成を選べるようにした
- `引き継ぎプロンプトをクリップボードにコピー` は、既存 Handoff ファイルがある場合は確認なしで既存ファイルを参照するプロンプトをコピーするようにした
- `引き継ぎファイルを開く` を追加した
- Control / Status に Handoff 生成ファイルの削除、件数、容量表示を追加した
- `Delete Handoff Files` は Control で `Empty Trash` の直前に配置し、Handoff 表示設定が無効でも利用できるようにした
- チャット表示内の軽量コピー機能は `Copy Quick Prompt` / `簡易プロンプトをコピー` とし、完全な Handoff と役割を分離した
- `package.json` / `package-lock.json` のバージョンを `2.1.0` に更新した

### 5.5 v2.0.1 リリースメモ（2026-05-15）

- 通常履歴 Webview とファイル履歴 Webview に、しおり ON/OFF 機能を追加した
- しおり状態は VS Code `globalState` に保存し、元の JSONL 履歴ファイルは変更しない
- 通常履歴 Webview とファイル履歴 Webview のしおり状態を同期し、一方で ON/OFF した状態がもう一方にも反映されるようにした
- Codex の diff しおりキーは、通常利用では `turn:<turn_id>` ベースの `patchGroup` 単位に統一し、ファイル履歴の 1 ファイル diff card と通常履歴の grouped diff が同じしおり状態を共有できるようにした
- Codex の `turn_id` 欠如時 fallback を通常履歴 Webview / ファイル履歴 Webview で共通化し、`call_id`、`payload.timestamp`、record `timestamp`、JSONL 行番号の順で同期キーを作るようにした
- Claude の `tool_use.id` 欠如時 fallback を通常履歴 Webview / ファイル履歴 Webview で共通化し、JSONL 行番号と同一行内 tool call index で同期キーを作るようにした
- しおり ON/OFF の保存に失敗した場合でも、Webview へ現在の `bookmarkState` を返して楽観的 UI 更新を巻き戻すようにした
- 初回 model 送信時の bookmarked keys 算出を再利用し、同じ target 群への重複計算を避けるようにした
- 旧キー互換は入れず、キー生成規則変更前のしおりは付け直しを前提とした
- 日付ガイドが無効なときは、カード上のしおり UI も表示しないようにした
- 日付ガイド上にしおり位置と user 位置を表示するようにした
- しおりマーカーは黄色の丸、user マーカーは青系の丸で表示するようにした
- 現在位置は最前面の独立リングとして表示し、user / しおり / 密集マーカーに隠れないようにした
- しおり有無で日付ガイドの開閉や表示維持の挙動が変わらないようにした
- 巨大履歴で日付ガイドが密集する場合だけ、吹き出し風の拡大レンズを表示するようにした
- 拡大レンズでは近辺 item を縦方向に広げ、tooltip とクリック移動対象を右側の元レール hover 位置へ同期するようにした
- 拡大レンズ内にポインタを移したとき、tooltip が二重に出ないようにした
- 拡大レンズの高さを件数に応じて可変にし、最小 140px、最大 220px、画面高さの 45% を上限とした
- 拡大レンズ内で user だけが選択枠を占有しないよう、現在位置 / しおりを優先しつつ通常 item も混ぜるようにした
- ファイル履歴 Webview の `履歴で開く` ボタンにアイコンを追加した
- `package.json` / `package-lock.json` のバージョンを `2.0.1` に更新した

### 5.6 v2.0.0 リリースメモ（2026-05-14）

- ワークスペース内のファイルを起点に、Codex / Claude の diff 履歴を時系列で確認できる AI Change History を追加した
- カスタムタイトル操作を QuickPick 入口へ統一し、チャット履歴ビューアのヘッダーからも設定 / 消去できるようにした
- Explorer のファイル右クリックメニューに `Show File AI Change History` を表示できる設定 `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled` を追加した
- ファイル履歴 Webview では、source toggle、Webview 内検索、前後 card 移動、先頭 / 末尾移動、`続きを読み込む`、`履歴で開く` を提供する
- `履歴で開く` は通常履歴 Webview を現在のエディタグループに別タブとして開き、該当 diff card へ reveal する
- `履歴で開く` の `patchEntry` reveal では full detail mode を強制せず、対象 diff entry の詳細だけを必要時に読み込む
- ファイル履歴 Webview の前後 card 移動は、Codex / Claude source toggle 適用後の表示中 card を基準にする
- Codex の `patch_apply_end` と `apply_patch` 入力を照合し、成功 patch の重複 diff を避けるようにした
- Claude の `Edit` / `MultiEdit` / `Write` から復元可能な diff をファイル履歴に表示できるようにした
- 通常履歴 Webview とファイル履歴 Webview で共通の date guide を追加した。設定 `codexHistoryViewer.ui.timeGuide.enabled` が `true` のときだけ表示する
- date guide はマウスオーバー、手動スクロール、キーボードスクロール時に表示し、自動更新追従やカード前後移動では表示しない
- 大きい履歴向けに `chat.performanceMode` を追加し、`auto` / `normal` / `simplified` から既定の表示負荷を選べるようにした
- `simplified` では重い diff / 詳細の描画を必要時に遅延し、タブ復帰時のレイアウト崩れは restore cover で隠す
- diff は VS Code 標準 Diff Editor ではなく、拡張機能の Webview 独自レンダリングで表示する
- 検索インデックスの tool メタ情報をファイル履歴の関連セッション優先付け補助に使うが、最終的な diff は元のローカルセッション JSONL を読み直して生成する

### 5.7 v1.5.1 リリースメモ（2026-05-08）

- 自動更新 `follow` で、末尾が grouped diff カードの場合に本文追従が diff に奪われないよう、直前の非 diff カードを追従対象にするようにした
- 自動更新 `follow` では pending のカードアンカー復元より追従を優先し、レイアウト更新後に追従位置がずれにくいよう再スクロールするようにした
- `chat.openPosition = lastMessage` で、画面内に本文メッセージがない位置の保存や、復元対象メッセージが描画されない場合に、直前の描画済み本文メッセージまたは先頭へフォールバックするようにした
- `chat.openPosition = latest` で、移動先指定のないチャット表示を最新の描画済みカードから開けるようにした
- チャット末尾ボタンは最後に描画されたカードへ移動するため、diff そのものを確認できる
- Codex の `custom_tool_call` を、`toolCalls` / `toolCallsAndOutputs` の検索インデックスに軽量メタとして含めるようにした
- `custom_tool_call` の patch / diff 本文は検索インデックスに入れず、対象ファイルや command など検索の入口になる情報だけを入れるようにした
- 検索インデックスの cache version を更新し、既存 cache は次回検索時に自動再構築されるようにした

### 5.8 v1.5.0 リリースメモ（2026-05-07）

- Codex / Claude セッションに対して、この拡張機能内だけのカスタムタイトルを設定 / 消去できるようにした
- カスタムタイトルは History / Pinned / チャット Webview のタイトルへ反映し、詳細ツールチップではオリジナルタイトルも確認できるようにした
- ツリー項目ツールチップの表示量を `full` / `compact` / `titleOnly` から選べるようにした
- 検索インデックスに保存するツール情報の範囲を `conversationOnly` / `toolCalls` / `toolCallsAndOutputs` から選べるようにした
- `Rebuild Search Index` コマンドを追加し、検索インデックス設定変更時に再作成へ誘導するようにした
- Status に拡張機能バージョンを表示するようにした

### 5.9 v1.4.3 リリースメモ（2026-04-30）

- `SECURITY.md` を追加し、`markdown-it` の GHSA-38c4-r59v-3vqw / CVE-2026-2327 について、v1.2.2 以降は `markdown-it@14.1.1` を同梱していることを明記した
- v1.2.1 以前の古い VSIX をインストールまたは再配布しないよう、セキュリティポリシーに明記した
- History の初回ロード中に、履歴 0 件の案内が先に表示されないよう、読み込み中ノードを表示するようにした
- Pinned の初回ロード中に、欠損ピンが先に表示されないよう、読み込み中ノードを表示するようにした
- 起動時の履歴キャッシュ / 検索インデックス処理前に、拡張機能の global storage ディレクトリを作成するようにした

## 6. 手動テスト観点

- `fileChangeHistory.explorerContextMenu.enabled = false` のとき、Explorer のファイル右クリックに `Show File AI Change History` が表示されない
- History / Pinned のセッション右クリックで `Custom Title...` が表示され、QuickPick から設定 / 消去を選べる
- カスタムタイトル未設定のセッションでは QuickPick に消去アクションが出ない
- チャット履歴ビューアのピン留めボタン右にある pencil アイコンから、同じ QuickPick でカスタムタイトルを設定 / 消去できる
- チャット履歴ビューアからカスタムタイトルを設定 / 消去した後、タブタイトルと History / Pinned / Search の表示が更新される
- `fileChangeHistory.explorerContextMenu.enabled = true` のとき、Explorer のファイル右クリックに `Show File AI Change History` が表示される
- ワークスペース外ファイル、ディレクトリ、存在しないファイルではファイル履歴 Webview が安全に開かれない、または分かりやすいエラーになる
- Codex のみ有効 / Claude のみ有効 / 両方有効で、ファイル履歴の候補抽出、件数表示、source toggle が期待どおり動く
- `search.indexToolContent = conversationOnly` でもファイル履歴 Webview が利用できる
- `search.indexToolContent` に tool 情報を含めた場合、ファイル履歴の関連セッション優先付けヒントとして使われる
- 対象ファイルに対する Codex `patch_apply_end` がファイル履歴に表示される
- `apply_patch` 入力と `patch_apply_end` が同じ変更を表す場合、ファイル履歴 card が重複しない
- 失敗した `apply_patch` / verification failed はファイル履歴 card として表示されない
- Claude の `Edit` / `MultiEdit` / `Write` で復元可能な diff だけがファイル履歴に表示される
- move / rename で before path と after path のどちらに一致してもファイル履歴に表示される
- move / rename で before path と after path の両方が一致しても 1 card だけ表示される
- ファイル履歴 Webview の初期表示は対象ファイルだけ、Webview 幅いっぱいの diff card として表示される
- ファイル履歴 Webview の検索は読み込み済み diff card を case-insensitive で検索する
- 検索中に `続きを読み込む` を実行した場合、追加された card も検索対象に含まれる
- `続きを読み込む` の成功 / 失敗 / キャンセル後に scroll 位置が維持される
- 全候補解析後は `続きを読み込む` が消え、`これ以上の履歴はありません` が表示される
- `履歴で開く` を押すと、通常履歴 Webview が現在のエディタグループに別タブとして開き、該当 diff card へスクロールする
- ファイル履歴で Codex / Claude source toggle を切り替えた状態でも、前 / 次 card ナビゲーションが表示中 card だけを対象にする
- `履歴で開く` で通常履歴 Webview を開いても full detail mode が強制されず、対象 diff entry の詳細だけが必要時に読み込まれる
- ファイル履歴 Webview を見ながら通常履歴 Webview を別タブで確認でき、既存のファイル履歴 Webview が置き換わらない
- `対象ファイルを開く` で VS Code の通常エディタに対象ファイルが開く
- source icon は Light / Dark / High Contrast で視認できる
- `ui.timeGuide.enabled = false` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示されない
- `ui.timeGuide.enabled = true` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示される
- date guide は表示範囲に応じて、通常履歴では時刻 / 日付+時刻 / 日 / 月、ファイル履歴では day / month / year に自動スケールする
- date guide はマウスオーバー、wheel / trackpad、scrollbar drag、スクロールキーで表示される
- date guide は自動更新追従、先頭 / 末尾、前後 card 移動、reveal target への自動ジャンプでは表示されない
- date guide の tooltip は目盛り近辺だけで表示され、カード操作ボタン付近では表示されない
- date guide 外クリックで date guide が即座に閉じ、下の UI 操作は妨げられない
- date guide 上にマウスがある間は、目盛り以外をクリックしても date guide が閉じない
- `ui.timeGuide.enabled = true` のとき、通常履歴 Webview / ファイル履歴 Webview のカードにしおりボタンが表示される
- `ui.timeGuide.enabled = false` のとき、通常履歴 Webview / ファイル履歴 Webview のカードにしおりボタンが表示されない
- 通常履歴 Webview でしおりを付けると、同じセッション / 同じ diff group のファイル履歴 Webview 側にも反映される
- ファイル履歴 Webview でしおりを外すと、通常履歴 Webview 側の同じ diff group でも外れる
- Codex の同じ `turn_id` に含まれる複数ファイル diff は、通常履歴 Webview では同じ grouped diff のしおりとして同期される
- Codex の `turn_id` がなく `payload.timestamp` だけがある patch でも、通常履歴 Webview とファイル履歴 Webview のしおりが同期される
- Codex の `turn_id` / `call_id` / timestamp がない patch でも、JSONL 行番号 fallback により通常履歴 Webview とファイル履歴 Webview のしおりが同期される
- Claude の `tool_use.id` がない patch でも、JSONL 行番号と tool call index fallback により通常履歴 Webview とファイル履歴 Webview のしおりが同期される
- しおり保存失敗時は、Webview の表示が最終的に extension 側の `bookmarkState` と一致する
- セッション削除時に該当セッションのしおりが削除され、Undo で復元される
- date guide 上にしおりマーカーが黄色丸として表示される
- date guide 上に user マーカーが青系丸として表示される
- date guide の現在位置リングが user / しおりマーカーに隠れない
- 巨大履歴で date guide が密集している箇所にマウスオーバーすると、密集時だけ拡大レンズが表示される
- 拡大レンズでは右側の元レール hover 位置に連動して tooltip が表示される
- 右側の元レールをクリックすると、拡大レンズ内で tooltip が出ている item へ移動する
- 拡大レンズ内へポインタを移しても tooltip が二重表示されない
- 拡大レンズ内で user だけが並ばず、通常 item / しおり / 現在位置も確認できる
- `chat.performanceMode = auto` で大きい履歴が `simplified` として表示される
- チャットヘッダーのパフォーマンスモードボタンで、この画面だけ `auto` / `normal` / `simplified` を切り替えられる
- `simplified` では diff entry を開くまで重い diff 本文が描画されない
- 長い履歴のタブを切り替えて戻っても、本文領域の一瞬の縮小表示が restore cover で見えにくい
- Codex のみ有効 / Claude のみ有効 / 両方有効で履歴が正しく出る
- Codex / Claude のどちらか一方だけが有効な場合でも、表示中セッション右クリックに `他のAIへ引継ぎ` 階層メニューが表示される
- `他のAIへ引継ぎ` 配下で、Codex と Claude の両方が有効な Codex セッションには `Claude Code へ引き継ぐ` が表示され、Claude セッションや Claude 無効時の Codex セッションには表示されない
- `codexHistoryViewer.handoff.enabled = false` のとき、表示中セッション右クリックに `他のAIへ引継ぎ` 階層メニューが表示されず、Control の `Delete Handoff Files` と Status の Handoff 件数 / 容量は表示される
- `引き継ぎファイルを作成` で `globalStorageUri/handoffs/<source>/.../handoff.md` が作成され、同じセッションでは同じファイルが使われる
- 既存 Handoff ファイルがある状態で `Claude Code へ引き継ぐ` または `引き継ぎファイルを作成` を実行すると、既存利用 / 再作成の確認が出る
- `引き継ぎプロンプトをクリップボードにコピー` は、既存 Handoff ファイルがある場合に確認なしで既存ファイル参照プロンプトをコピーする
- Handoff ファイルがない状態で `引き継ぎプロンプトをクリップボードにコピー` を実行すると、Handoff ファイルを作成してからプロンプトをコピーし、作成したことも通知する。通知から Handoff ファイルを開ける
- Handoff ファイルがない状態で `引き継ぎファイルを開く` を実行すると、作成確認トーストが出て、承認時は作成後に開く
- Codex から Claude Code への Handoff では、Claude Code が localized prompt 付きで開く、または fallback 通知から Handoff ファイルを開く / プロンプトをコピーできる
- Claude から Codex への Handoff は、Handoff prompt がクリップボードへコピーされ、Codex 入力欄へ自動投入されない前提の案内になる
- Handoff prompt は `ui.language` に応じてローカライズされる
- `handoff.md` には `Source session file`、直近のユーザー依頼、末尾優先の transcript 抜粋、復元可能なファイル変更が含まれる
- `handoff.md` の本文ラベルは英語で、tool call / tool output 本文は含まれない
- `引き継ぎファイルを削除` 実行後、Status の Handoff 件数 / 容量が更新される
- `History` の日付 / プロジェクト / ソース / タグ絞り込みが期待どおり動く
- `History` の表示モードを `日付別` / `最新順` で切り替えられ、選択中セッションの操作が維持される
- History / Pinned の右クリックから QuickPick 経由でカスタムタイトルを設定 / 消去でき、History / Pinned / チャット Webview タイトルへ反映される
- カスタムタイトルがあるセッションの詳細ツールチップにオリジナルタイトルが表示される
- 121 文字以上のカスタムタイトル入力ではエラーになり、保存されない
- `preview.tooltipMode` を `full` / `compact` / `titleOnly` で切り替えると、ツリー項目ツールチップの表示量が変わる
- `full` / `compact` のツールチップでは、カスタムタイトルがなくても履歴ペイン表示と同じタイトルが表示される
- 履歴の自動更新設定が有効なとき、履歴ファイル作成 / 変更 / 削除で History が自動更新される
- 履歴の自動更新設定が有効なとき、チャットヘッダーに自動更新ボタンが表示される
- 新規チャットタブ、または再利用タブで別セッションへ切り替えたチャットタブは、自動更新が `off` で始まる
- 同じセッションの既存チャットタブを再表示した場合、自動更新モードが維持される
- チャットタブの自動更新ボタンで `off` / `preserve` / `follow` が循環し、ボタン色と tooltip が切り替わる
- 自動更新オンのチャットタブが開いているとき、History view が非表示でも対象チャットタブが自動更新される
- 自動更新オンのチャットタブが裏タブでも、VS Code ウィンドウがフォーカス中なら更新される
- History view が非表示かつ自動更新オンのチャットタブが開いていないとき、自動更新は保留される
- VS Code ウィンドウが非フォーカスのとき、自動更新は保留され、フォーカス復帰時に 1 回だけ反映される
- 起動直後の初回履歴ロード中、History に読み込み中ノードが表示され、ロード完了後に実データまたは空状態案内へ切り替わる
- 起動直後の初回履歴ロード中、Pinned に読み込み中ノードが表示され、ロード完了後に実データ、欠損ピン、またはドロップ案内へ切り替わる
- 履歴が 0 件の場合、History に履歴保存先確認・再読み込み・Claude 有効化に関する案内ノードが表示される
- 履歴絞り込みで一致件数が 0 件になった場合、History に絞り込み変更 / 解除を促す案内ノードが表示される
- `preserve` ではスクロール位置、選択メッセージ、詳細表示、開いているカード、開いている diff、検索サイドバー状態が維持される
- `follow` では UI 状態を維持しつつ、最新の表示カードへ移動する。末尾が grouped diff カードの場合は直前の非 diff カードへ移動する
- 自動更新で Search 結果が勝手にクリアされない
- `Show details` を ON/OFF しても、切り替え前に見ていたカードまたは次の表示カードへスクロールが復元される
- 詳細 OFF の大型セッションで tool 詳細、patch diff 行、画像 data URI が初回描画時にまとめて読み込まれず、詳細表示・diff 展開・画像表示時に必要分が読み込まれる
- 再利用タブで別セッションへ切り替えたとき、検索状態、画像プレビュー、画像データキャッシュ、画像保存先 CWD、patch entry 詳細の pending 要求が前セッションから残らない
- `Search` が履歴側の絞り込み条件に追従する
- `settings.json` で `preview.maxMessages` / `search.maxResults` に範囲外の値を入れても、設定読み取り時に許容範囲へ丸められる
- `Search` のロール設定、保存済み検索、再検索、タグ絞り込みが動く
- `search.indexToolContent` を `conversationOnly` / `toolCalls` / `toolCallsAndOutputs` で切り替えると、検索インデックスに入るツール情報の範囲が変わる
- `toolCalls` / `toolCallsAndOutputs` で Codex の `custom_tool_call` の tool 名、command、対象ファイルパスが検索にヒットする
- `conversationOnly` では Codex の `custom_tool_call` の tool 名、command、対象ファイルパスが検索にヒットしない
- Codex の `custom_tool_call` に patch / diff 本文が含まれる場合、対象ファイルパスは検索にヒットし、diff 本文の具体行は検索にヒットしない
- `toolCallsAndOutputs` でも Codex の `custom_tool_call_output` の stdout / stderr 全文や diff 本文は検索インデックスへ入らない
- `search.indexToolContent` 変更時に検索インデックス再作成の通知が出て、`Rebuild Search Index` で検索インデックスだけ再作成できる
- `Rebuild Cache` 実行前に確認が出て、履歴キャッシュと検索インデックスが再作成される
- `Delete` 実行後に `undo-delete` / `deleted` の扱いと `Undo Last Action` が整合する
- `Delete` 後に該当チャットパネルが閉じ、存在しないセッションを開こうとしてもゴーストパネルが残らない
- Undo 付き通知のボタンと Undo 完了メッセージが `ui.language` に応じて表示される
- `Empty Trash` 実行後に Status のゴミ箱件数が 0 になり、旧世代キャッシュも削除される
- Control ビューと Command Palette に `Debug Info (Copy)` が出ない
- `debug.logging.enabled` を `true` にすると OutputChannel に履歴 refresh / 検索インデックスの診断ログが出る
- 診断ログにセッションパス、セッションID、メッセージ本文が含まれない
- Status の容量表示と件数表示が更新される
- Status の最下部に拡張機能バージョンが表示される
- Import / Export が両ソースで正しく動く
- Markdown transcript にローカルパスが含まれるため、共有前確認が必要なことを案内できている
- `history.dateBasis` を `started` / `lastActivity` で切り替えると履歴ツリーの日付グループが正しく変わる
- `chat.openPosition = top` のとき、移動先指定のないチャット表示が先頭から開く
- `chat.openPosition = lastMessage` のとき、同じセッションを開き直すと最後に見ていたメッセージ付近へ戻る
- `chat.openPosition = latest` のとき、移動先指定のないチャット表示が最新の描画済みカードから開く
- 保存位置がない場合、または保存位置が現在の詳細表示設定で表示される先頭メッセージの場合は、タグ / メモカードが見えるスクロール最上部から開く
- `chat.openPosition = lastMessage` で tool / usage / diff など本文メッセージが画面内にない位置を最後に見ていた位置として保存した場合、開き直し時は直前の描画済み本文メッセージ付近、直前がなければ先頭へ戻る
- `chat.openPosition = lastMessage` で保存済みの本文メッセージが現在の表示条件で描画されない場合、直前の描画済み本文メッセージへ戻り、直前がなければ先頭から開く
- ツリー選択で同じセッションの `session` タブが開いている場合、そのタブがアクティブになり、`reusable` タブは差し替わらない
- ツリー選択で同じセッションの `reusable` タブだけが開いている場合、そのタブがアクティブになる
- 別タブ表示中に、既に選択されている履歴行を再クリックしても、同じセッションの既存チャットタブがアクティブになる
- メニューからチャットを開くと、未オープンのセッションは `session` タブとして開く
- メニューからチャットを開くと、同じセッションの `session` / `reusable` タブが既にあれば既存タブがアクティブになる
- `reusable` タブに表示中のセッションをメニューから開いた後、別履歴をツリー選択すると新しい `reusable` タブが使われ、昇格済みタブは差し替わらない
- `session` タブとして開いたセッションをツリー選択しても、`reusable` タブへ降格しない
- チャット表示で `toolDisplayMode` を `detailsOnly` / `compactCards` で切り替えるとツール行の表示が変わる
- `userLongMessageFolding` / `assistantLongMessageFolding` が `off` / `auto` / `always` で期待どおり折りたたみ動作する
- `Show details` ON 時は長文メッセージが常に全文表示になる
- `Show details` OFF 時は usage 行が表示されない
- `Show details` ON 時は Codex / Claude の assistant 応答後に usage 行が表示され、クリックで詳細が展開 / 折りたたみされる
- Codex の usage 行には取得できる場合、model / effort / in-out token / cached input / reasoning / cumulative / context window / rate limit が表示される
- Claude の usage 行には取得できる場合、model / in-out token / cache read-write / service tier / speed が表示される
- `Show details` ON 時は、取得できる場合に environment 行として CWD / Git branch / Git commit / dirty 状態が表示される
- `Show details` ON 時は、tool カードに取得できる場合の status / exit code / duration / interruption / error が表示される
- チャットのスクロールバーが固定ヘッダーの横ではなく、ヘッダー下のスクロール領域から始まる
- Codex / Claude の画像付きセッションで、対応画像がサムネイル表示される
- `<image></image>` だけが残るセッションで、プレースホルダー文字列が本文に残らず、表示不能状態の画像カードが出る
- `images.enabled = false` のとき、画像は読み込まれず表示不能状態になる
- `images.maxSizeMB` を超える画像は読み込まれず、サイズ超過として表示される
- `images.thumbnailSize` を `small` / `medium` / `large` で切り替えると本文内サムネイルサイズが変わる
- 画像サムネイルをクリックするとプレビューモーダルが開く
- 画像が 1 枚だけのときも、プレビューモーダル上部にサムネイルが表示される
- 複数画像のプレビューで、サムネイルクリック、前後ボタン、左右キーによる切り替えができる
- 複数画像のプレビューで、先頭 / 末尾を超えて移動しても反対側へループしない
- 画像が多いとき、プレビューモーダル上部のサムネイル列を横スクロールできる
- プレビューモーダルで fit / 原寸表示を切り替えられる
- プレビューモーダルで表示中の画像を保存できる
- プレビューモーダルを開いたまま別セッションを開くと、モーダルが閉じる
- `patch_apply_end` を含むセッションで差分カードが表示される（`Show details` OFF でも出る）
- 差分カードの折りたたみ展開、hunk ごとの折り返し切り替え、行ジャンプが動く
- diff カードの上下ナビゲーションで前後の diff へ移動できる
- 各カードの最大幅展開ボタンで対象カードだけが広がり、再クリックで通常幅に戻る
- 差分ハイライトが VS Code テーマに追従する
- 検索サイドバーがツールバー右端ボタンおよび `Ctrl+F` / `Cmd+F` で開閉する
- 検索サイドバーの幅をドラッグで変更でき、再表示後も保持される
- 未入力・一致なし時ともにカウントが `0/0` と表示される
- チャットヘッダーの先頭・末尾ボタンで、実際に表示されている最初 / 最後のカードへスクロールできる
- 自動更新 `follow` で最後が diff カードのとき、直前の非 diff カードへ追従し、チャット末尾ボタンでは最後の diff カードへ移動できる
- 自動更新 `follow` が pending のカードアンカー復元や reload 後のレイアウト更新に上書きされず、追従後の位置が最後に見ていた位置として保存される
- `Show details` OFF のとき、描画されていない詳細カードへ先頭 / 末尾スクロールしない
- ヘッダー幅が狭くなるとラベルボタンが自動的にアイコンのみに切り替わる
- Reload 後にスクロール位置と選択メッセージが復元される
- Reload 後に開いているカード、diff 展開、diff 折り返し、検索サイドバー状態が維持される
- diff カードを最大幅にした状態が、再読み込み後も同じ diff グループで維持される
- ローカルファイルリンク（相対パス・行番号指定）が VS Code 内で正しく開く
- `package.nls.*` と `l10n/bundle.l10n.*` のキー所有が混ざっていない
- `SECURITY.md` に v1.4.3 / 2026-04-30 のセキュリティ方針と `markdown-it` アドバイザリ対応が記載されている
- ソースコードコメントに日本語が残っていない
