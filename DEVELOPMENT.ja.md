# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-04-30
- 対象バージョン: 1.4.3

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
  - `Cleanup Missing Pins`
  - `Bulk Rename Tag`
  - `Bulk Delete Tags`
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
  - ゴミ箱件数（`undo-delete` + `deleted` の合算）
  - 現在の検索ロール / 検索タグ / 履歴絞り込み / 現在プロジェクト / 最終更新時刻
  - 有効ソースごとのセッションルート
  - `Current project` と `Sessions root` 系のパスは行右側のコピーアイコンからクリップボードへコピーできる

### 3.2 セッション操作

- `Open in New Tab (Chat)`: Webview で会話をセッションタブとして表示
- `Open Session (Markdown)`: 仮想ドキュメントとして Markdown 化して表示
- `Copy Prompt Excerpt`: 連携用に短い抜粋をクリップボードへコピー
- `Resume in OpenAI Codex`: OpenAI Codex 拡張へ引き継ぐ
- `Resume in Claude Code`: Claude Code 拡張へ引き継ぐ
- `Pin / Unpin`: ピン留めの追加 / 解除
- `Promote to Today (Copy)`: セッションを「今日」の履歴として複製する
- `Delete`: 削除確認後に削除する
- `Undo Last Action`: delete / pin / annotation / tag 操作などを 1 手戻す
- `Edit Session Annotation`: タグ / ノート編集
- `Export Sessions`: 生 JSONL または Markdown transcript を出力
- `Import Sessions`: フォルダ単位で `.jsonl` を再帰取り込み

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
  - ツール引数 / ツール出力
  - セッション注釈のタグ / ノート
- 保存済み検索:
  - 実行
  - 保存
  - 削除
- `Rerun Search` は最後に使った検索条件を再実行する
- 検索対象にはセッションタイトルは含めず、表示タイトルだけを切り替える

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
- 検索インデックス:
  - 保存先: `globalStorageUri/search-index.v2.json`
  - 用途: 繰り返し検索を高速化する増分インデックス
  - 現在の履歴インデックスに存在しない孤立エントリは `ensureUpToDate()` で削除する
  - 再利用条件:
    - `sessionsRoot`
    - `claudeSessionsRoot`
    - 有効ソース設定
    - 各ファイルの `mtime` / `size`
  - 保存形式: 整形なし JSON（サイズ削減のため）
- `Rebuild Cache`:
  - 実行前に確認ダイアログを出す
  - 履歴キャッシュと検索インデックスを両方とも強制再作成する
  - 実行後は検索結果をクリアする
- `Delete`:
  - 既定は OS のゴミ箱 / リサイクルビンへ移動
  - 失敗時は `globalStorageUri/deleted` に退避
  - Undo 用バックアップを `globalStorageUri/undo-delete` に作成
  - Undo アクションの破棄 / clear / 完了時に不要バックアップを cleanup する
- `Undo Last Action`:
  - メモリ上の Undo スタックは直近 20 件を上限とする
  - 上限超過で破棄された Undo アクションは cleanup hook を実行する
- `Empty Trash`:
  - `deleted` と `undo-delete` を手動削除する
  - あわせて旧世代の `cache.v*.json` / `search-index.v*.json` も削除する
  - ダイアログと Status 表示上の件数は「ゴミ箱件数」のみを扱う
- 自動削除:
  - 行わない
  - 不要ファイル整理はユーザー操作 (`Empty Trash` / `Rebuild Cache`) に委ねる

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
- `follow` は UI 状態を維持し、最新の表示カードへスクロールする
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
- チャットタブの自動更新ボタンは、履歴の自動更新設定が有効なときだけ表示し、`off` / `preserve` / `follow` をクリックで循環する
- `preserve` / `follow` はボタンの背景色でオン状態を示し、`follow` はさらに別色で追従中であることを示す
- チャットの先頭 / 末尾スクロールは、スクロールコンテナの絶対端ではなく、実際に描画されている最初 / 最後のカードを対象にする
- `Show details` OFF で描画されないカードは、先頭 / 末尾スクロールおよび `follow` の対象に含めない
- `Show details` OFF では tool 引数 / tool 出力 / patch diff 行などの重い詳細を省略し、必要時に full detail を再読み込みする
- assistant の model / effort / token usage は `Show details` ON のときだけ、assistant 応答後の細い usage 行として表示する
- usage 行は初期状態では 1 行表示とし、クリックすると入力 / 出力 / キャッシュ / 推論 / 累計 / context window / rate limit / service tier など取得できた項目だけを展開表示する
- CWD / Git ブランチ / Git コミット / dirty 状態が取得できた場合は、`Show details` ON のときだけ environment 行として表示する
- tool の status / exit code / duration / interruption / error が取得できた場合は、`Show details` ON の tool カードにメタ情報として表示する
- `Show details` の ON/OFF では切り替え前に見えていたカードを基準にスクロールを復元し、対象カードが非表示なら次の表示カードへ移動する
- `chat.openPosition`:
  - `top`: 通常は先頭から開く
  - `lastMessage`: 最後に見えていたメッセージ付近を復元する
- ツリー選択で開くチャットは再利用タブとして扱い、次のツリー選択で中身を差し替える
- メニューから開くチャットはセッションタブとして扱い、別セッションを開いても差し替えない
- 再利用タブに表示中の同じセッションをメニューから開いた場合、そのタブをセッションタブへ昇格する
- ツリー選択 / メニュー操作のどちらでも、同じセッションのチャットタブが既に開いていれば既存タブをアクティブにする
- Reload とチャットタブの自動更新は、表示位置、選択メッセージ、詳細表示、展開カード、展開 diff、diff 折り返し、検索サイドバー状態を維持する
- 再利用タブで別セッションへ切り替わる場合は、検索状態、検索リサイズ状態、画像プレビュー、画像データキャッシュなどのセッション依存 UI をリセットする
- grouped diff カードの最大幅状態は、再読み込みでカードの並び順が変わっても維持しやすいように安定キーで管理する

### 3.7 設定（`codexHistoryViewer.*`）

- `sessionsRoot`
- `claude.sessionsRoot`
- `sources.enabled`
- `preview.openOnSelection`
- `preview.maxMessages`
- `search.defaultRoles`
- `search.caseSensitive`
- `search.maxResults`
- `history.dateBasis`
- `history.titleSource`
- `autoRefresh.enabled`
- `autoRefresh.debounceMs`
- `autoRefresh.minIntervalMs`
- `chat.openPosition`
- `chat.toolDisplayMode`
- `chat.userLongMessageFolding`
- `chat.assistantLongMessageFolding`
- `images.enabled`
- `images.maxSizeMB`
- `images.thumbnailSize`
- `resume.openTarget`
- `delete.useTrash`
- `ui.language`
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
- `src/services/codexTitleStore.ts`
  - Codex の `session_index.jsonl` と `codex-title-cache.v1.json` を使ってネイティブタイトルを解決する
  - 既知セッションだけを保持しつつ、古い Codex タイトルを軽量キャッシュとして残す
- `src/sessions/sessionTitleResolver.ts`
  - `generated` / `nativeWhenAvailable` の設定値に応じて `displayTitle` を決定する

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
  - セッションごとに `mtime` / `size` を持ち、差分更新する
  - JSONL をストリーミングで読み、検索対象メッセージ列を構築する
  - `cleanupOrphanEntries()` で現在の履歴に存在しない cacheKey を削除する
  - 実ファイルが消えている場合は `stat` 失敗時に該当エントリを削除する
  - `forceRebuild` 指定時は内部エントリをクリアして最初から作り直す

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

### 4.9 表示

- チャット表示: `src/chat/*`
  - `ChatPanelManager` は対象ファイルの存在を確認してから開く / reload する
  - refresh や削除で元ファイルが消えたパネルは閉じる
  - `ChatPanelManager` はツリー選択用の `reusable` タブと、明示的に開いた `session` タブを区別する
  - 既存タブ検索では `session` タブを優先し、なければ同じセッションを表示中の `reusable` タブを使う
  - `ChatPanelManager` は `ChatOpenPositionStore` を使い、明示的な移動先がない場合だけ最後に見えていたメッセージ付近を復元する
  - `ChatPanelManager` は保存可能な画像をパネル単位で保持し、Webview からの保存要求時に `showSaveDialog` 経由で書き出す
  - `ChatPanelManager` は表示詳細を `summary` / `full` で管理し、`summary` では tool 引数 / tool 出力 / patch diff 行を Webview model から省略する
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
  - Webview 側は usage 行を折りたたみ可能カードとして描画し、展開状態を同一セッション reload 中は保持する
  - Webview 側は environment 行を軽量メタカードとして描画し、CWD など長い値は表示崩れしないよう省略 / 折り返しする
  - Webview 側は tool 実行メタ情報を tool カードの meta tag として表示し、status はローカライズ済みラベルへ正規化する
  - Webview 側は IntersectionObserver で表示範囲付近の画像だけ data URI を要求し、セッション切替時は画像データキャッシュを破棄する
  - `follow` モードとチャット末尾ボタンは、`#timeline` に描画済みの最後の `.row` へスクロールする
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
  - `history.titleSource`、`autoRefresh.*`、`chat.openPosition`、`chat.toolDisplayMode`、`images.*` などの設定もここで管理する
  - 数値設定は下限 / 上限を丸め、想定外の enum 値は既定値へ戻す
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

### 5.4 v1.4.3 リリースメモ（2026-04-30）

- `SECURITY.md` を追加し、`markdown-it` の GHSA-38c4-r59v-3vqw / CVE-2026-2327 について、v1.2.2 以降は `markdown-it@14.1.1` を同梱していることを明記した
- v1.2.1 以前の古い VSIX をインストールまたは再配布しないよう、セキュリティポリシーに明記した
- History の初回ロード中に、履歴 0 件の案内が先に表示されないよう、読み込み中ノードを表示するようにした
- Pinned の初回ロード中に、欠損ピンが先に表示されないよう、読み込み中ノードを表示するようにした
- 起動時の履歴キャッシュ / 検索インデックス処理前に、拡張機能の global storage ディレクトリを作成するようにした

## 6. 手動テスト観点

- Codex のみ有効 / Claude のみ有効 / 両方有効で履歴が正しく出る
- `History` の日付 / プロジェクト / ソース / タグ絞り込みが期待どおり動く
- `History` の表示モードを `日付別` / `最新順` で切り替えられ、選択中セッションの操作が維持される
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
- `follow` では UI 状態を維持しつつ、最新の表示カードへ移動する
- 自動更新で Search 結果が勝手にクリアされない
- `Show details` を ON/OFF しても、切り替え前に見ていたカードまたは次の表示カードへスクロールが復元される
- 詳細 OFF の大型セッションで tool 詳細、patch diff 行、画像 data URI が初回描画時にまとめて読み込まれず、詳細表示・diff 展開・画像表示時に必要分が読み込まれる
- 再利用タブで別セッションへ切り替えたとき、検索状態、画像プレビュー、画像データキャッシュが前セッションから残らない
- `Search` が履歴側の絞り込み条件に追従する
- `Search` のロール設定、保存済み検索、再検索、タグ絞り込みが動く
- `Rebuild Cache` 実行前に確認が出て、履歴キャッシュと検索インデックスが再作成される
- `Delete` 実行後に `undo-delete` / `deleted` の扱いと `Undo Last Action` が整合する
- `Delete` 後に該当チャットパネルが閉じ、存在しないセッションを開こうとしてもゴーストパネルが残らない
- Undo 付き通知のボタンと Undo 完了メッセージが `ui.language` に応じて表示される
- `Empty Trash` 実行後に Status のゴミ箱件数が 0 になり、旧世代キャッシュも削除される
- Control ビューと Command Palette に `Debug Info (Copy)` が出ない
- `debug.logging.enabled` を `true` にすると OutputChannel に履歴 refresh / 検索インデックスの診断ログが出る
- 診断ログにセッションパス、セッションID、メッセージ本文が含まれない
- Status の容量表示と件数表示が更新される
- Import / Export が両ソースで正しく動く
- Markdown transcript にローカルパスが含まれるため、共有前確認が必要なことを案内できている
- `history.dateBasis` を `started` / `lastActivity` で切り替えると履歴ツリーの日付グループが正しく変わる
- `chat.openPosition = top` のとき、移動先指定のないチャット表示が先頭から開く
- `chat.openPosition = lastMessage` のとき、同じセッションを開き直すと最後に見ていたメッセージ付近へ戻る
- 保存位置がない場合、または保存位置が現在の詳細表示設定で表示される先頭メッセージの場合は、タグ / メモカードが見えるスクロール最上部から開く
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
- `Show details` OFF のとき、描画されていない詳細カードへ先頭 / 末尾スクロールしない
- ヘッダー幅が狭くなるとラベルボタンが自動的にアイコンのみに切り替わる
- Reload 後にスクロール位置と選択メッセージが復元される
- Reload 後に開いているカード、diff 展開、diff 折り返し、検索サイドバー状態が維持される
- diff カードを最大幅にした状態が、再読み込み後も同じ diff グループで維持される
- ローカルファイルリンク（相対パス・行番号指定）が VS Code 内で正しく開く
- `package.nls.*` と `l10n/bundle.l10n.*` のキー所有が混ざっていない
- `SECURITY.md` に v1.4.3 / 2026-04-30 のセキュリティ方針と `markdown-it` アドバイザリ対応が記載されている
- ソースコードコメントに日本語が残っていない
