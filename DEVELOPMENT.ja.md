# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-04-23
- 対象バージョン: 1.4.0

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

- 既定では無効 (`autoRefresh.enabled = false`)
- 有効時は Codex / Claude の履歴 `.jsonl` を監視する
- 変更イベントは `autoRefresh.debounceMs` でまとめ、`autoRefresh.minIntervalMs` より短い間隔では refresh しない
- 実際の refresh 実行条件:
  - History view が表示中
  - VS Code ウィンドウがフォーカス中
- History view 非表示中、またはウィンドウ非フォーカス中の変更は pending として保持する
- 表示 / フォーカス復帰時に pending があれば 1 回だけ更新予約する
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
- `chat.openPosition`:
  - `top`: 通常は先頭から開く
  - `lastMessage`: 最後に見えていたメッセージ付近を復元する
- ツリー選択で開くチャットは再利用タブとして扱い、次のツリー選択で中身を差し替える
- メニューから開くチャットはセッションタブとして扱い、別セッションを開いても差し替えない
- 再利用タブに表示中の同じセッションをメニューから開いた場合、そのタブをセッションタブへ昇格する
- ツリー選択 / メニュー操作のどちらでも、同じセッションのチャットタブが既に開いていれば既存タブをアクティブにする

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
  - `autoRefresh.enabled` が `true` のときだけ FileSystemWatcher を作成する
  - Codex は `**/rollout-*.jsonl`、Claude は `*/*.jsonl` を監視する
  - watcher イベントは即 refresh せず、pending 状態にして debounce / min interval を適用する
  - `History` view が非表示、または VS Code ウィンドウが非フォーカスの場合は timer を止めて pending を保持する
  - `vscode.window.state.focused` と `onDidChangeWindowState` により、フォーカス中のウィンドウだけ自動 refresh を実行する
  - 自動 refresh は `refreshHistoryIndex(false)` と view refresh のみを行い、Search 結果のクリアや検索インデックス再構築は行わない

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
  - `chatImageAttachments.ts` は Codex / Claude の画像データ、ローカル画像参照、画像プレースホルダーを正規化する
  - 対応画像は data URI として Webview へ渡し、未対応 / 欠損 / remote-only / サイズ超過 / 設定無効は表示不能理由としてモデル化する
  - `user` / `assistant` / tool / note / diff などのカードは個別に最大幅展開できる
  - grouped diff カードは前後の diff へ移動する上下ナビゲーションを持つ
  - 画像プレビューは Webview 内モーダルとして実装し、ヘッダーのサムネイル列、前後ボタン、左右キー、fit / 原寸切替、保存、閉じる操作を持つ
  - Webview のスクロール対象は `#scrollRoot` に限定し、固定ヘッダーをスクロール領域から分離する
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

## 6. 手動テスト観点

- Codex のみ有効 / Claude のみ有効 / 両方有効で履歴が正しく出る
- `History` の日付 / プロジェクト / ソース / タグ絞り込みが期待どおり動く
- `History` の表示モードを `日付別` / `最新順` で切り替えられ、選択中セッションの操作が維持される
- `autoRefresh.enabled = true` のとき、履歴ファイル作成 / 変更 / 削除で History が自動更新される
- `History` view が非表示のとき、自動更新は保留され、表示時に 1 回だけ反映される
- VS Code ウィンドウが非フォーカスのとき、自動更新は保留され、フォーカス復帰時に 1 回だけ反映される
- 自動更新で Search 結果が勝手にクリアされない
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
- チャットヘッダーの先頭・末尾ボタンでスクロールできる
- ヘッダー幅が狭くなるとラベルボタンが自動的にアイコンのみに切り替わる
- Reload 後にスクロール位置と選択メッセージが復元される
- ローカルファイルリンク（相対パス・行番号指定）が VS Code 内で正しく開く
- `package.nls.*` と `l10n/bundle.l10n.*` のキー所有が混ざっていない
- ソースコードコメントに日本語が残っていない
