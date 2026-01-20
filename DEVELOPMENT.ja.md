# Codex History Viewer 開発ドキュメント（日本語）

## 1. 概要

- 目的: Codex CLI のローカル履歴（既定: `~/.codex/sessions`）を VS Code 上で閲覧・検索・整理する
- 対象データ: `rollout-*.jsonl`（JSON Lines 形式）
- 通信: ネットワーク通信は行わない（ローカルファイルのみを読む）

## 2. ディレクトリ構成（主要）

- `src/`: TypeScript 実装
- `dist/`: ビルド成果物（拡張の `main`）
- `media/`: Webview（チャット表示）用の CSS/JS
- `l10n/`: ローカライズ用バンドル
- `resources/`: アイコン等

## 3. 機能仕様

### 3.1 ビュー

- **Pinned**: ピン留めしたセッション一覧
- **History**: 年/月/日でグルーピングした履歴ツリー（絞り込み対応）
  - 日付スコープ: 全て / 年 / 月 / 日
  - プロジェクト: セッション `cwd` 単位（実質的に「作業ディレクトリ」）
- **Search**: 検索結果ツリー（セッション → ヒット一覧）
  - 検索スコープは History 側の絞り込み（日付/プロジェクト）に追従する

### 3.2 コマンド（代表）

- Refresh / Rebuild Cache
- Search…（キャンセル対応、最大ヒット数と大小文字区別は設定で制御）
- Filter History… / Clear History Filters
- Open Session (Chat) / Open Session (Markdown)
- Pin / Unpin（Pinned ビューへドラッグ&ドロップしてピン留めも可能）
- Promote to Today (Copy)（元ファイルは変更しない）
- Delete（既定は OS のゴミ箱/リサイクルビン、失敗時は隔離フォルダへ退避）
- Debug Info (Copy)（トラブルシュート用の情報をクリップボードへコピー）

### 3.3 設定（`codexHistoryViewer.*`）

- `sessionsRoot`（既定: 空 → `~/.codex/sessions` を使用）
- `preview.openOnSelection`（ツリー選択時にプレビューを開く）
- `preview.maxMessages`（ツールチップ/簡易プレビュー用に読むメッセージ数の上限）
- `search.maxResults` / `search.caseSensitive`
- `delete.useTrash`（ゴミ箱使用の可否）
- `ui.language`（`auto` / `ja` / `en`）
- `ui.alwaysShowHeaderActions`（VS Code の `workbench.view.alwaysShowHeaderActions` を有効化してヘッダーアイコンを常時表示）

## 4. 実装仕様（要点）

### 4.1 セッション探索

- `src/sessions/sessionDiscovery.ts` が `sessionsRoot` 以下を再帰走査し、`rollout-*.jsonl` を収集する。

### 4.2 セッション要約（一覧表示用）

- `src/sessions/sessionSummary.ts` が以下を生成する:
  - 先頭行の `session_meta` からメタ情報を抽出（破損時は `null` 扱い）
  - `response_item` → `message`（`user`/`assistant`）を最大 `preview.maxMessages` 件だけ読み、スニペット/プレビューを生成
  - 先頭の巨大コンテキスト（`<environment_context>` など）はスニペット候補から除外する

### 4.3 インデックスとキャッシュ

- `src/services/historyService.ts` が履歴インデックスを構築し、`globalStorageUri/cache.v4.json` にキャッシュする。
- キャッシュは以下の条件が一致する場合に再利用される:
  - `sessionsRoot`
  - `preview.maxMessages`
  - `mtime`/`size`

### 4.4 検索

- `src/services/searchService.ts` が JSONL をストリーミングで走査し、本文の部分一致でヒットを収集する。
- 進捗表示/キャンセル（`CancellationToken`）に対応し、`search.maxResults` で上限を設ける。
- History の絞り込み（日付/プロジェクト）を候補セッションの段階で適用する。

### 4.5 表示

- チャット表示: `src/chat/*` の Webview でレンダリング（Markdown は `markdown-it` を使用）
- Markdown 表示: `src/transcript/*` が JSONL から Markdown を生成し、仮想ドキュメントとして開く
  - 生成した Markdown にはローカルのファイルパスや `cwd` が含まれるため、共有前に見直すこと

### 4.6 ピン留め

- `src/services/pinStore.ts` が `globalState` にピン留め情報を保存する（パスは正規化して重複を吸収）。

### 4.7 今日として最新化（Promote）

- `src/services/promoteService.ts` が「今日」のディレクトリへコピーを作成する。
  - セッション ID を新規生成
  - タイムラインが「今」始まるように `timestamp` を一定量シフト
  - 元ファイルは変更しない

### 4.8 削除

- `src/services/deleteService.ts` は削除前に確認ダイアログを出す。
- 既定は OS のゴミ箱/リサイクルビンへ移動し、失敗時は `globalStorageUri/deleted` に隔離する（データ損失回避を優先）。

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

### 5.3 VSIX 作成（配布前確認用）

```powershell
# VSIX を作成します（リポジトリ情報が無くても作成可能です）
npm run package
```

このプロジェクトでは `package.json` の `scripts.package` で `vsce package --allow-missing-repository` を実行しています。

- `vsce package`: VS Code 拡張を `.vsix` としてパッケージ化します。
- `--allow-missing-repository`: `package.json` に `repository` が未設定でも、エラーにせずパッケージ化を続行します（ローカル検証/社内配布向け）。
  - 公開配布を前提にする場合は、`repository` を正しく設定することを推奨します。

直接コマンドを実行したい場合は、次のように `npx` 経由でも実行できます。

```powershell
# 直接パッケージ化します（npm script と同等の内容です）
npx vsce package --allow-missing-repository

# パッケージに含まれるファイルを事前確認します（.vscodeignore の効き方の確認）
npx vsce ls --tree
```

※ 配布物に開発資料（このファイル等）を含めないよう、`.vscodeignore` を必ず更新・確認すること。

## 6. 手動テスト観点（例）

- 履歴が 0 件の場合に安全に案内表示される
- `sessionsRoot` が存在しない/読めない場合でもクラッシュしない
- ツリー選択でプレビューが開く（設定で無効化できる）
- 検索がキャンセルできる／上限 `search.maxResults` で止まる
- ピン留め（コンテキスト/ドラッグ&ドロップ）・解除が期待通り動作する
- Promote で「今日」に新規ファイルが作成され、元ファイルが変更されない
- Delete がゴミ箱へ移動し、失敗時に隔離フォルダへ退避する
