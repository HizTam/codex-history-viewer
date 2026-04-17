# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-04-17
- 対象バージョン: 1.2.1

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
- `l10n/`: ローカライズ用バンドル
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
  - `Debug Info`
- **Pinned**: ピン留め済みセッション一覧
  - タグ絞り込み対応
  - 欠損ピンも表示対象
  - `History` / `Search` からのドラッグ&ドロップで追加可能
- **History**: 年 / 月 / 日でグルーピングした履歴ツリー
  - 絞り込み: 日付スコープ / プロジェクト (`cwd`) / ソース / タグ
  - ヘッダー操作: 再読み込み、絞り込み、現在のプロジェクトで絞り込み、ソース切替、絞り込み解除など
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

- `Open Session (Chat)`: Webview で会話表示
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

### 3.4 キャッシュ / インデックス / 保守

- 履歴キャッシュ:
  - 保存先: `globalStorageUri/cache.v6.json`
  - 用途: 一覧表示用の要約キャッシュ
  - 再利用条件:
    - `sessionsRoot`
    - `claudeSessionsRoot`
    - 有効ソース設定
    - `preview.maxMessages`
    - 日付時刻設定キー
    - 各ファイルの `mtime` / `size`
- 検索インデックス:
  - 保存先: `globalStorageUri/search-index.v2.json`
  - 用途: 繰り返し検索を高速化する増分インデックス
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
- `Empty Trash`:
  - `deleted` と `undo-delete` を手動削除する
  - あわせて旧世代の `cache.v*.json` / `search-index.v*.json` も削除する
  - ダイアログと Status 表示上の件数は「ゴミ箱件数」のみを扱う
- 自動削除:
  - 行わない
  - 不要ファイル整理はユーザー操作 (`Empty Trash` / `Rebuild Cache`) に委ねる

### 3.5 設定（`codexHistoryViewer.*`）

- `sessionsRoot`
- `claude.sessionsRoot`
- `sources.enabled`
- `preview.openOnSelection`
- `preview.maxMessages`
- `search.defaultRoles`
- `search.caseSensitive`
- `search.maxResults`
- `history.dateBasis`
- `chat.toolDisplayMode`
- `chat.userLongMessageFolding`
- `chat.assistantLongMessageFolding`
- `resume.openTarget`
- `delete.useTrash`
- `ui.language`
- `ui.alwaysShowHeaderActions`

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

### 4.3 履歴キャッシュ

- `src/services/historyService.ts`
  - `cache.v6.json` を読み書きする
  - 変更のないファイルはキャッシュ済み `summary` を再利用する
  - 最終的な一覧はローカル日付 / 時刻順で降順ソートする

### 4.4 検索インデックス

- `src/services/searchIndexService.ts`
  - `search-index.v2.json` を管理する
  - セッションごとに `mtime` / `size` を持ち、差分更新する
  - JSONL をストリーミングで読み、検索対象メッセージ列を構築する
  - `forceRebuild` 指定時は内部エントリをクリアして最初から作り直す

### 4.5 検索フロー

- `src/services/searchService.ts`
  - 検索開始時に検索インデックスの差分同期を行う
  - 削除済みファイルに対応してインデックスから不要エントリを落とす
  - 候補絞り込みは「日付 / プロジェクト / ソース / Search タグ」の順で適用する
  - 進捗表示とキャンセルに対応する

### 4.6 削除とゴミ箱

- `src/services/deleteService.ts`
  - 削除前に確認ダイアログを出す
  - Undo 用コピーを `undo-delete` に保存する
  - OS ゴミ箱失敗時は `deleted` へ退避してデータ損失を避ける
- `src/services/storageMaintenanceService.ts`
  - キャッシュフォルダ全体容量を集計する
  - `undo-delete` / `deleted` 件数を合算して返す
  - `Empty Trash` 実行時に旧世代キャッシュ / インデックスも整理する

### 4.7 注釈 / ピン / 保存済み検索

- `src/services/sessionAnnotationStore.ts`
  - タグ / ノートを `globalState` に保存する
- `src/services/pinStore.ts`
  - ピン留め情報を `globalState` に保存する
- `src/services/searchPresetStore.ts`
  - 保存済み検索条件を `workspaceState` に保存する

### 4.8 表示

- チャット表示: `src/chat/*`
- Markdown transcript: `src/transcript/*`
- Control / Status ビュー: `src/tree/utilityTrees.ts`
- History / Pinned / Search ツリー: `src/tree/*`

### 4.9 ツール意味付けレイヤー

- `src/tools/toolSemantics.ts`
  - ツール名からカード表示用のメタ情報（アイコン・アクセント・ラベル）を解決する
  - `detailsOnly` / `compactCards` の表示モードを制御するビルダーを提供する
- `src/tools/toolTypes.ts`
  - ツール関連の共通型定義

### 4.10 ローカルファイルリンク

- `src/utils/localFileLinks.ts`
  - Webview / transcript 内のローカルパス文字列を VS Code URI に変換する
  - ワークスペース相対パス・行番号指定（`#L39`・`#L39-L45`・`#L39C2`）に対応する
- `src/transcript/transcriptDocumentLinkProvider.ts`
  - Markdown transcript ドキュメント上のリンクを `DocumentLinkProvider` として解決する

### 4.11 設定

- `src/settings.ts`
  - 拡張設定の読み取りヘルパーをまとめる
  - `chat.toolDisplayMode`・`chat.userLongMessageFolding`・`chat.assistantLongMessageFolding` などチャット表示系設定もここで管理する

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
- `Search` が履歴側の絞り込み条件に追従する
- `Search` のロール設定、保存済み検索、再検索、タグ絞り込みが動く
- `Rebuild Cache` 実行前に確認が出て、履歴キャッシュと検索インデックスが再作成される
- `Delete` 実行後に `undo-delete` / `deleted` の扱いと `Undo Last Action` が整合する
- `Empty Trash` 実行後に Status のゴミ箱件数が 0 になり、旧世代キャッシュも削除される
- Status の容量表示と件数表示が更新される
- Import / Export が両ソースで正しく動く
- Markdown transcript にローカルパスが含まれるため、共有前確認が必要なことを案内できている
- `history.dateBasis` を `started` / `lastActivity` で切り替えると履歴ツリーの日付グループが正しく変わる
- チャット表示で `toolDisplayMode` を `detailsOnly` / `compactCards` で切り替えるとツール行の表示が変わる
- `userLongMessageFolding` / `assistantLongMessageFolding` が `off` / `auto` / `always` で期待どおり折りたたみ動作する
- `Show details` ON 時は長文メッセージが常に全文表示になる
- `patch_apply_end` を含むセッションで差分カードが表示される（`Show details` OFF でも出る）
- 差分カードの折りたたみ展開、hunk ごとの折り返し切り替え、行ジャンプが動く
- 差分ハイライトが VS Code テーマに追従する
- 検索サイドバーがツールバー右端ボタンおよび `Ctrl+F` / `Cmd+F` で開閉する
- 検索サイドバーの幅をドラッグで変更でき、再表示後も保持される
- 未入力・一致なし時ともにカウントが `0/0` と表示される
- チャットヘッダーの先頭・末尾ボタンでスクロールできる
- ヘッダー幅が狭くなるとラベルボタンが自動的にアイコンのみに切り替わる
- Reload 後にスクロール位置と選択メッセージが復元される
- ローカルファイルリンク（相対パス・行番号指定）が VS Code 内で正しく開く
