# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-06-22
- 対象バージョン: 2.6.1

## 1. 概要

- 目的: Codex CLI / Claude Code のローカル履歴を VS Code 上で閲覧・検索・整理・再開しやすくする
- 対象データ:
  - Codex: `~/.codex/sessions` 配下の `rollout-*.jsonl`
  - Codex archived: `~/.codex/archived_sessions` 配下の `rollout-*.jsonl`（任意）
  - Claude: `~/.claude/projects/<project>/<session>.jsonl`
- 通信: ネットワーク通信は行わない。ローカルファイルと VS Code のストレージだけを扱う
- 対応ソース: `codexHistoryViewer.sources.enabled` で `codex` / `claude` を切り替える。Codex archived sessions は `codex` source が有効な場合だけ使える追加保存場所として扱う

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
  - `Clear Project Search History`
  - `Delete Handoff Files`
  - `Empty Trash`
- **Pinned**: ピン留め済みセッション一覧
  - 絞り込み: 日付スコープ / プロジェクト (`cwd`) / ソース / アーカイブ表示 / タグ
  - プロジェクト表示: `一覧表示` / `プロジェクト別表示`
  - プロジェクト対象範囲: `すべて` / `現在のプロジェクトグループ`
  - プロジェクト (`cwd`) に別名が設定されている場合は、プロジェクト見出し、セッション行の CWD 表示、tooltip、絞り込み表示で別名を優先する
  - 表示順: More Actions から `ピン留め順 新しい順 / 古い順`、`開始日時 新しい順 / 古い順`、`最終メッセージ日時 新しい順 / 古い順`、`名前 昇順 / 降順` を選択する
  - ヘッダー操作: プロジェクト表示、絞り込み、絞り込み解除、タグ絞り込み、タグ絞り込み解除、アーカイブ表示切替、ソース切替、再読み込み、エクスポート、Undo。表示順は toolbar には置かず More Actions に集約する
  - `History` / `Search` の絞り込み、ソース、アーカイブ表示とは独立して状態を保持する
  - 欠損ピンも表示対象
  - 欠損ピンは日付スコープまたは現在プロジェクト絞り込みでは非表示にし、プロジェクト別表示では `CWD なし` 配下に集約する
  - `History` / `Search` からのドラッグ&ドロップで追加可能
  - Codex アーカイブ済みセッションのピンは、Pinned 独自のソースとアーカイブ表示が対象に含めるときだけ表示する
  - 公式側でアーカイブされてパスが変わったピンは、session identity で追従する
- **History**: 年 / 月 / 日でグルーピングした履歴ツリー、またはセッション一覧のフラット一覧
  - 表示モード: `日付別` / `セッション一覧`
  - 表示順: More Actions から `開始日時 新しい順 / 古い順`、`最終メッセージ日時 新しい順 / 古い順`、`名前 昇順 / 降順` を選択する
  - 絞り込み: 日付スコープ / プロジェクト (`cwd`) / ソース / アーカイブ表示 / タグ
  - プロジェクト表示: `一覧表示` / `プロジェクト別表示`
  - プロジェクト対象範囲: `すべて` / `現在のプロジェクトグループ`
  - プロジェクト (`cwd`) に別名が設定されている場合は、プロジェクト見出し、セッション行の CWD 表示、tooltip、絞り込み表示で別名を優先する
  - `プロジェクト別表示` では、`セッション一覧` は `Project -> Session`、`日付別` は `Project -> Year -> Month -> Day -> Session` として表示する
  - ヘッダー操作: プロジェクト表示、絞り込み、絞り込み解除、表示モード切替、並び替え、タグ絞り込み、タグ絞り込み解除、アーカイブ表示切替、ソース切替、再読み込み、エクスポート、Undo など
  - `絞り込み解除` は日付 / プロジェクト CWD / ソース / アーカイブ表示 / タグを解除し、プロジェクト表示と対象範囲は表示状態として維持する
  - 複数選択で開く / エクスポート / Promote / Delete が可能
  - Codex アーカイブ済みセッションは、アーカイブ表示が `すべて` または `アーカイブのみ` のときに表示し、アイコン / 説明 / tooltip で通常履歴と区別する
  - 初回履歴ロード中は、空状態案内ではなく読み込み中ノードを表示する
  - 履歴が 0 件の場合は、履歴保存先確認・再読み込み・Claude 有効化に関する案内ノードを表示する
  - 絞り込み適用後に一致する履歴がない場合は、絞り込み条件の変更 / 解除を促す案内ノードを表示する
- **Search**: 検索結果ツリー
  - 表示構造: セッション -> ヒット一覧
  - ヘッダー操作: `Search...`、`Clear Results`、保存済み検索の実行、現在の検索を保存、`Rerun Search`、エクスポート、Undo
  - 既定ロール設定は Control view / Command Palette / settings から管理する
  - 検索対象は History 側の「日付 / プロジェクト / ソース / アーカイブ表示 / タグ / プロジェクト対象範囲」絞り込みに追従し、Pinned 側の独立した絞り込みには追従しない
  - 検索結果が空のとき、History 側の絞り込み変更だけでは Search にセッション一覧を生成しない。これらの条件は次回検索の対象範囲としてだけ使う
  - 検索結果が表示されているとき、History 側の絞り込み変更が実効値として変わった場合だけ、最後の検索条件で再検索する
  - 検索結果のセッション行と tooltip ではプロジェクト別名を表示に反映するが、検索 hit 対象には含めない
  - Search のヘッダーにはタグ / ソース / アーカイブ表示 / 日付 / プロジェクトの絞り込み操作を置かず、絞り込み操作は History 側に集約する
  - アーカイブ非表示時は archived hit を候補から除外し、`search.maxResults` は表示される hit 数として扱う
  - History 側でアーカイブ表示を切り替えた時点で検索結果がある場合は、最後の検索条件で再検索する
- **Status**: 実行時状態の要約
  - 有効ソースごとのセッション件数
  - Codex source と Codex archived sessions が有効な場合は archived 件数
  - ピン数 / 欠損ピン数 / 保存済み検索数 / 総タグ数
  - キャッシュフォルダ容量
  - Handoff 件数 / 容量
  - ゴミ箱件数（`undo-delete` + `deleted` の合算）
  - 現在の検索ロール / 検索タグ / 履歴絞り込み / 現在プロジェクト / 最終更新時刻
  - `Current project` はプロジェクト別名が設定されている場合、実パスではなく別名を表示名に使う
  - 有効ソースごとのセッションルート
  - Codex archived sessions root は、Codex source と archived sessions が有効な場合だけ表示する
  - 拡張機能バージョン
  - `Current project` と `Sessions root` 系のパスは行右側のコピーアイコンからクリップボードへコピーできる

### 3.2 セッション操作

- `Open in New Tab (Chat)`: Webview で会話をセッションタブとして表示
- `Custom Title...`: QuickPick からカスタムタイトルの設定 / 消去を選択する
- `Project Alias...`: History / Pinned のプロジェクトノード右クリックから、プロジェクト別名の設定 / 消去を選択する
- `Project Association...`: History / Pinned のプロジェクトノード右クリックから、別プロジェクトへの関連付け、関連付けモード変更、解除を選択する
- `Open Session (Markdown)`: 仮想ドキュメントとして Markdown 化して表示
- `Copy Quick Prompt`: チャット表示内で、タスクと直近メッセージだけの軽量な再開用プロンプトをクリップボードへコピー
- `Resume in OpenAI Codex`: OpenAI Codex 拡張へ引き継ぐ
- `Resume in Claude Code`: Claude Code 拡張へ引き継ぐ
- `他のAIへ引継ぎ`: Handoff 用の階層メニューを表示する
- `Move to Archive`: active Codex セッションを Codex archived sessions へ移動する
- `Move to Codex History`: archived Codex セッションを通常の Codex history へ戻す
- `Pin / Unpin`: ピン留めの追加 / 解除
- `Promote to Today (Copy)`: セッションを「今日」の履歴として複製する
- `Delete`: 削除確認後に削除する
- `Undo Last Action`: delete / pin / annotation / tag 操作などを 1 手戻す
- `Edit Session Annotation`: タグ / ノート編集
- `Export Sessions`: 生 JSONL または Markdown transcript を出力
- `Import Sessions`: フォルダ単位で `.jsonl` を再帰取り込み

### 3.2.1 Codex アーカイブ

- `codexHistoryViewer.sources.enabled` に `codex` が含まれ、かつ `codexHistoryViewer.codex.archivedSessions.enabled` が有効な場合、通常の Codex `sessions` に加えて Codex `archived_sessions` も読み込む
- `codexHistoryViewer.codex.archivedSessionsRoot` が空の場合は、Codex `sessionsRoot` と同階層の `archived_sessions` を既定値にする
- `codexHistoryViewer.sources.enabled` に `codex` が含まれていない場合は、`codexHistoryViewer.codex.archivedSessions.enabled = true` でも archived sessions を使用しない
- `archiveLocationFilter` は History と Search の検索対象範囲用として workspace ごとに保持し、既定は `通常のみ` とする
- Pinned は `pinnedArchiveLocationFilter` を別に保持し、History と Pinned の view title action からそれぞれ独立して `通常のみ` / `すべて` / `アーカイブのみ` を切り替えられる。Search は History 側のアーカイブ表示を検索対象範囲として参照する
- History のソース絞り込みが `claude` の場合、History のアーカイブ表示切替は toolbar では disabled 表示にし、More Actions ではアーカイブ表示 group を非表示にする
- Pinned のソース絞り込みが `claude` の場合、Pinned のアーカイブ表示切替は disabled 表示かつ実行しても状態を変更しない
- archived 由来の session は `storage.archiveState = "archived"`、`rootKind = "codexArchivedSessions"` として扱う
- active と archived に同じ session identity がある場合は active を優先し、重複表示を避ける
- archived Codex session の Markdown には `Location: Archived` を表示し、Chat では `Archived` 表示で通常履歴と区別する
- archived Codex session の Chat では `Resume in Codex` の位置に `Move to Codex History` を表示する
- active Codex session の Chat / 履歴 Webview には `Move to Archive` ボタンを置かない
- 右クリックメニューでは、active Codex session は `Move to Archive` だけ、archived Codex session は `Move to Codex History` だけを表示する
- 移動系 action はカスタムタイトル系 action の下に区切って配置し、Delete はさらに下に区切って配置する
- archived Codex session では `Resume in Codex` と `Promote to Today (Copy)` を表示しない
- `Move to Archive` は公式 Codex provider の `thread/archive` を使い、filesystem fallback は行わない
- `Move to Codex History` は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem provider で `<sessionsRoot>/<YYYY>/<MM>/<DD>/` へ Move する
- filesystem provider fallback の Move は、同名衝突時に suffix を付け、copy+verify+delete fallback と Undo で安全性を確保する
- archive / unarchive / pin reconcile では、annotation / bookmark / chat open position などの path-keyed metadata を移動先へ寄せる
- `chat.openPosition = lastMessage` の archived Codex Chat から `Move to Codex History` を実行した場合は、操作直前に見ていた本文メッセージへ復元後に移動する
- `PinEntry` は `identityKey` / `archiveState` / `rootKind` を保持し、公式側でアーカイブされて path が変わった場合も refresh 後に追従する
- archived sessions が無効またはアーカイブ非表示のとき、archived 由来と判断できる pin は Pinned に欠損として出さず、Status の missing pin count にも含めない
- archived 由来と判断できない missing pin は、通常の削除 / 外部移動と区別できないため従来通り missing として扱う

### 3.2.2 他のAIへ引継ぎ

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
  - 添付 / ファイル参照の label、path、MIME type、file kind
  - Claude text document から抽出した上限内テキスト
- Codex archived sessions は実効有効な場合に検索インデックスへ取り込み、表示時は `archiveLocationFilter` に従って hit を含める / 除外する
- archived 非表示時は archived hit を先に除外してから `search.maxResults` を適用するため、表示件数が最大件数に達する
- PDF / Office / binary / base64 document の内容や、Codex file reference の参照先ファイル内容は検索インデックスへ入れない
- 保存済み検索:
  - 実行: 保存済み検索 QuickPick で検索語を選択し、保存済みの検索語だけを再利用する。検索対象ロールと大文字小文字の扱いは現在設定を使う
  - 保存: 直近の検索語だけを保存する
  - 削除: 保存済み検索 QuickPick の項目右側にあるゴミ箱ボタンで個別削除する。Search ヘッダーには削除専用ボタンを置かない
- 検索履歴:
  - 全体検索、履歴ビュー内検索、ファイル変更履歴の検索で検索語履歴を共有する
  - 検索履歴はプロジェクト単位で保存する
  - 履歴候補には検索語だけを表示し、検索対象ロールや大文字小文字の扱いは保存しない
  - 全体検索 QuickPick では、検索履歴の項目選択で検索を実行し、項目右側のゴミ箱ボタンで個別削除する
  - 検索履歴の全消去は Control view の `Clear Project Search History` に集約し、検索 QuickPick には全消去項目を置かない
  - Webview 内検索の候補 dropdown は、非空入力で候補が 0 件になった場合は empty message を重ねず閉じる
- `Rerun Search` は最後に使った検索条件を再実行する
- カスタムタイトルは検索対象に含め、検索結果の表示タイトルにも反映する
- プロジェクト別名は大量 hit を避けるため検索対象に含めない。検索 scope label と検索結果の表示には反映する

### 3.4 キャッシュ / インデックス / 保守

- 履歴キャッシュ:
  - 保存先: `globalStorageUri/cache.v9.json`
  - 用途: 一覧表示用の要約キャッシュ
  - 通常起動時は、有効な cache context であれば filesystem scan / stat を待たずに cache から `HistoryIndex` を即時表示し、その後 background refresh で最新状態へ更新する
  - `cache.v9.json` が破損して JSON parse error になった場合は、破損内容を退避せず削除し、通常の refresh で再生成する
  - セッションファイル処理は上限付き並列で行う（無制限 `Promise.all` は使わない）
  - 再利用条件:
    - `sessionsRoot`
    - `codexArchivedSessionsRoot`
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
- プロジェクト別名:
  - 保存先: VS Code `globalState`
  - 用途: 本家履歴ファイルを変更せず、この拡張機能内だけでプロジェクト (`cwd`) の表示名を上書きする
  - 保存キーは `normalizeProjectKey(cwd)` の結果を使い、Codex / Claude Code で同じ CWD は同じ別名を共有する
  - CWD が空、または `CWD なし` の疑似プロジェクトには別名を保存しない
  - 最大 120 文字を超える入力はエラーにし、空入力または自動プロジェクト表示名と同じ入力は別名消去として扱う
- 検索インデックス:
  - 保存先: `globalStorageUri/search-index.v2.json`
  - 内部 file version: 9
  - 用途: 繰り返し検索を高速化する増分インデックス
  - `search-index.v2.json` が破損して JSON parse error になった場合は、破損内容を退避せず削除し、次回検索時に再構築する
  - 現在の履歴インデックスに存在しない孤立エントリは `ensureUpToDate()` で削除する
  - 再利用条件:
    - `sessionsRoot`
    - `codexArchivedSessionsRoot`
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
  - Chat attachment metadata は label、path、MIME type、file kind を検索対象に含める
  - Claude text document の text は上限内だけ検索対象にし、PDF / Office / binary / base64 document の本文は検索対象にしない
  - Codex file reference は履歴に保存された label / path だけを検索対象にし、参照先ファイルは読み込まない
  - 保存形式: 整形なし JSON（サイズ削減のため）
- JSON 永続化:
  - JSON 読み込み失敗は `missing` / `parseError` / `readError` に分け、parse error だけを再生成可能な破損ファイルとして削除する
  - 権限エラーや provider unavailable などの read error では既存ファイルを削除しない
  - JSON 書き込みは同一ディレクトリの一時ファイルへ書いた後に rename する。rename に失敗した場合は従来互換の直接書き込みへフォールバックし、フォールバックも失敗した場合は書き込み済み一時ファイルを残す
  - 診断ログには reason や削除成否だけを出し、JSON 本文やセッションパスは出さない
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
  - あわせて旧世代の `cache.v*.json` / `search-index.v*.json` と、1 時間以上古い `*.tmp-*.json` も削除する。ただし現在の `cache.v9.json` / `search-index.v2.json` は削除しない
  - ダイアログでは古い一時ファイルの件数を個別表示せず、ストレージ整理として扱う。Status 表示上の件数は「ゴミ箱件数」のみを扱う
- 自動削除:
  - 履歴キャッシュ、検索インデックス、ゴミ箱はユーザー操作 (`Empty Trash` / `Rebuild Cache`) に委ねる
  - Handoff 生成ファイルは作成時に古い世代だけを整理し、全削除はユーザー操作 (`Delete Handoff Files`) に委ねる

### 3.5 自動更新

- 履歴の自動更新設定は既定では無効 (`codexHistoryViewer.autoRefresh.enabled = false`)
- 有効時は Codex / Claude の履歴 `.jsonl` を監視する
- Codex source と Codex archived sessions が有効な場合は archived root も監視対象に含める
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

### 3.6 チャット表示 / 添付 / 画像

- チャット表示では Codex / Claude のメッセージ内に含まれる添付 / ファイル参照を `attachments` に統合して扱う
- `ChatMessageItem.images` は Chat model の出力としては使わず、画像も `attachments` の `type: "image"` として扱う
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
- Claude Code の `type: "document"` は document card として表示する
  - PDF は PDF document card として表示し、初期 Webview model へ base64 payload を渡さない
  - text document は text document card として表示し、プレビュー表示には上限内の抜粋だけを使う
  - unknown document は generic document card として表示する
- Claude Code の `<ide_opened_file>` / `<ide_selection>` は本文から除去し、file reference / selection reference card として表示する
- Codex の `# Files mentioned by the user:` block は、message 先頭または IDE context 後ろの本文途中から file reference card に変換し、raw block と `## My request for Codex:` ヘッダーは除去して前置 context と依頼本文を残す
- Codex の `## My request for Codex:` がない variant は、安全に file block と本文の境界を判定できる場合だけ分離する
- Codex file reference は参照先ファイルを自動で読まず、履歴に保存された label / path / line 情報だけを表示する
- Word / Excel / PowerPoint / PDF / zip / 任意拡張子は file reference として扱い、内容 preview はしない
- document / file reference / selection card は、file kind badge、ファイル名、必要な action icon を中心にした compact card とする
- path / MIME type / byte size は本文上に常時表示せず、card / badge / ファイル名の tooltip で確認できるようにする
- file kind ごとに badge icon / accent を変える。PDF / Word / Excel / PowerPoint / Text / Code / Archive / Image reference / Selection / Generic file を区別する
- Code / Image reference の badge text は generic `File` に落とさず、専用の l10n label で表示する
- text document preview は本文中の大きな `<details>` として常時表示せず、保存ボタン左の preview action icon で開閉する
- preview を開いた場合は同じ card 内の下段に full-width panel として展開する
- embedded document の Save As は Webview から `saveAttachment` message を送り、extension host 側の payload store から保存する
- local file reference の Open は Webview から `openAttachment` message を送り、extension host 側で VS Code API 経由で開く。shell command は使わない
- 本文が空で添付だけの user message も、詳細非表示時に context / empty message と誤判定せず表示する
- `attachments` は抽出時点から履歴 content の出現順を保つ。Webview 側でも kind 別に並べ替えず、連続する画像だけを image group としてまとめる
- Search / Markdown / Resume / Handoff など画像 payload を読まない経路では、画像実データを読み込まずに MIME type / 推定 label などの軽量 metadata だけを保持する
- `localimage` / `imageassetpointer` など normalize 後の image-like type も attachment-like 判定に含め、main path と patch detail path の messageIndex を揃える
- Claude Code の `type: "document"` は document extractor を優先し、image extractor では処理しない。MIME type 欠落時も document と image の二重 attachment にしない
- `saveImage` / `saveAttachment` は Webview から session `fsPath` を送り、extension host 側で現在の panel state と一致する場合だけ保存する。欠落 / stale request は保存せず、必要に応じて debug log に留める
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
- チャット本文では、現在のユーザープロンプトを上部に追従表示できる
- assistant 応答に Codex のメモリー引用情報が含まれる場合は、本文末尾ではなく折りたたみ表示として扱う
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
  - archived Codex Chat から `Move to Codex History` を実行する場合は、ボタン押下時に現在見えている本文メッセージ index を保存し、復元後の active Chat panel で同じ本文メッセージを明示的に reveal する
- ツリー選択で開くチャットは再利用タブとして扱い、次のツリー選択で中身を差し替える
- メニューから開くチャットはセッションタブとして扱い、別セッションを開いても差し替えない
- 再利用タブに表示中の同じセッションをメニューから開いた場合、そのタブをセッションタブへ昇格する
- ツリー選択 / メニュー操作のどちらでも、同じセッションのチャットタブが既に開いていれば既存タブをアクティブにする
- Reload とチャットタブの自動更新は、表示位置、選択メッセージ、詳細表示、展開カード、展開 diff、diff 折り返し、検索サイドバー状態を維持する
- 再利用タブで別セッションへ切り替わる場合は、検索状態、検索リサイズ状態、画像プレビュー、画像データキャッシュ、画像保存先 CWD、patch entry 詳細の pending 要求などのセッション依存 UI / panel-side 状態をリセットする
- grouped diff カードの最大幅状態は、再読み込みでカードの並び順が変わっても維持しやすいように安定キーで管理する

### 3.6.1 File AI Change History（ファイル単位の AI 更新履歴）

- 目的:
  - ワークスペース内の 1 ファイルを起点に、そのファイルへ影響した Codex / Claude の AI diff 履歴を時系列で確認できるようにする
  - diff から元の通常履歴 Webview の該当 diff カードへ戻り、会話文脈を確認できるようにする
- 起動方法:
  - Command Palette / Explorer ファイル右クリックメニューから `Show File AI Change History` を実行する
  - Explorer ファイル右クリックメニューへの表示は `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled` が `true` のときだけ有効
  - ディレクトリは対象外。ワークスペース外のファイルも対象外
- 対象範囲:
  - 現在開いているワークスペース配下の対象ファイルだけ
  - プロジェクト関連付けがある場合は、関連付け後の表示に沿って候補履歴と diff 表示を扱う
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
  - Webview 内検索（正規表現、完全一致、検索履歴候補に対応）
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
  - 添付 / 画像付き message は dot 外側の控えめな ring で表示する
  - 添付 indicator は通常添付、画像のみ、mixed を区別する
  - 添付 indicator と tooltip は `attachments` metadata だけを使い、payload store / 参照先ファイル / binary data にはアクセスしない
  - 添付あり message の tooltip には `user #18 (画像添付)` / `user #3 (PDF, テキスト)` のような attachment summary を含める
  - attachment summary の種類 label は既存の `chat.image.attachmentLabel` と `chat.attachment.*` の l10n label を再利用する。総添付数 suffix で `件` / `attachments` などの語を出す場合は l10n key を追加する
  - attachment summary は「種類の短い要約」と「総添付数」を分けて表示する。`+N` は hidden unique kind 数として残し、同一 kind が複数ある場合や 4 種類以上ある場合は `画像添付 ×5` / `PDF, テキスト, Word +1 / 4件` のように総添付数を別 suffix で出す
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

- `sources.enabled`
- `sessionsRoot`
- `codex.archivedSessions.enabled`
- `codex.archivedSessionsRoot`
- `claude.sessionsRoot`
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
  - Codex source と Codex archived sessions が有効な場合は archived root も `rollout-*.jsonl` の再帰走査対象にする
  - 収集結果には `rootKind` / `rootPath` を付与し、通常 Codex と archived Codex を区別する
  - Claude は `.claude/projects/<project>/<session>.jsonl` の 2 階層構造のみを対象にする

### 4.2 セッション要約

- `src/sessions/sessionSummary.ts`
  - `session_meta` を読み取り、一覧用メタ情報を構築する
  - `DiscoveredSessionFile` の root 情報から `storage.archiveState` と `rootKind` を設定する
  - Codex は session id から identity key を作り、path が active / archived 間で変わっても同一 session として扱えるようにする
  - `user` / `assistant` メッセージを先頭から最大 `preview.maxMessages` 件だけ読んでスニペットを作る
  - 大きすぎるコンテキスト断片は一覧スニペットから除外する
  - Claude のネイティブタイトルは `custom-title -> ai-title -> rename -> summary` の優先順で抽出する

### 4.3 履歴キャッシュ

- `src/storage/cacheFiles.ts`
  - 現行の履歴キャッシュ名 (`cache.v9.json`) と検索インデックス名 (`search-index.v2.json`) を一元管理する
  - `Empty Trash` の旧世代判定も同じ定数と pattern を使い、現行ファイル名の drift を防ぐ
- `src/storage/jsonStorage.ts`
  - `readJsonDetailed()` は JSON 読み込み結果を `ok` / `missing` / `parseError` / `readError` として返す
  - `readJsonOrDropCorrupt()` は parse error のときだけ対象 JSON を best-effort で削除し、履歴キャッシュ / 検索インデックスで共通利用する
  - read / delete result は `errorName` だけを保持し、JSON 本文や path を含み得る `errorMessage` は保持しない
  - `writeJson()` は同一ディレクトリの一時ファイルへ書いてから rename し、rename 失敗時は直接書き込みへフォールバックする。フォールバック失敗時は一時ファイルを残す
- `src/services/historyService.ts`
  - `cache.v9.json` を読み書きする。ファイル名は `src/storage/cacheFiles.ts` の共通定数を使う
  - 有効な cache context から `HistoryIndex` を復元し、初回表示を先に完了できるようにする
  - cache 読み込み時の parse error は cache を削除して `null` 扱いにし、read error は削除せず `null` 扱いにする
  - 変更のないファイルはキャッシュ済み `summary` を再利用する
  - ファイルごとの `stat` / キャッシュ判定 / `buildSessionSummary` は最大 4 並列で処理する
  - `HistoryIndex.byCacheKey` を構築し、`findByFsPath()` は `Map` で引く
  - `HistoryIndex.byIdentityKey` を構築し、active / archived 間の path 移動や pin 追従に使う
  - active と archived に同じ identity がある場合は active を優先して dedupe する
  - 最終的な一覧はローカル日付 / 時刻順で降順ソートする
  - `history.titleSource` に応じて `displayTitle` を後段で解決する
- `src/services/sessionTitleOverrideStore.ts`
  - カスタムタイトルを VS Code `globalState` に保存する
  - 本家の Codex / Claude 履歴ファイルは変更しない
  - セッション ID が取れる場合は `source:id:<sessionId>`、取れない場合は `source:path:<fsPath>` をキーにする
- `src/services/projectAliasStore.ts`
  - プロジェクト別名を VS Code `globalState` に保存する
  - 本家の Codex / Claude 履歴ファイルは変更しない
  - `normalizeProjectKey(cwd)` をキーにし、source に依存せず同じ CWD の別名を共有する
  - CWD 空、`CWD なし` 疑似プロジェクト、最大長超過、payload 不整合を保存 / 復元時に拒否し、入力中の制御文字はサニタイズする
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
  - Codex source と Codex archived sessions が有効な場合は archived root にも `**/rollout-*.jsonl` watcher を作成する
  - watcher root signature には `rootKind` を含め、通常 Codex と archived Codex の root を区別する
  - watcher イベントは即 refresh せず、変更された `fsPath` を pending 集合に入れて debounce / min interval を適用する
  - refresh callback には変更された `fsPath` の配列を渡す
  - `History` view が非表示かつ自動更新オンのチャットタブが開いていない場合、または VS Code ウィンドウが非フォーカスの場合は timer を止めて pending を保持する
  - `vscode.window.state.focused` と `onDidChangeWindowState` により、フォーカス中のウィンドウだけ自動 refresh を実行する
  - 自動 refresh は `refreshHistoryIndex(false)`、view refresh、チャットタイトル更新、対象チャットタブ更新を行い、Search 結果のクリアや検索インデックス再構築は行わない
- `src/extension.ts`
  - 自動更新 consumer は `History` view が表示中、または `ChatPanelManager` に自動更新オンの開いているチャットタブがある場合に存在するとみなす
  - `historyView.onDidChangeVisibility`、チャット consumer 変更イベント、`onDidChangeWindowState` で `AutoRefreshService` の実行条件を更新する
  - `codexHistoryViewer.manageProjectAlias` / `setProjectAlias` / `clearProjectAlias` を登録し、Project node 文脈がない direct / UI command では active project を推定せず no-op にする
  - プロジェクト別名の変更後は view description と tree view を更新し、`refreshHistoryIndex(false)` と `chatPanels.refreshTitles()` は呼ばない
- `src/chat/chatPanelManager.ts`
  - チャットタブごとに `autoRefreshMode` と `pendingAutoRefresh` を保持する
  - `codexHistoryViewer.webview.restoreAfterReload = true` のときだけ `codexHistoryViewer.chat` の `WebviewPanelSerializer` を登録し、Reload Window / VS Code 再起動後も session path、panel kind、detail mode、自動更新 mode を復元する
  - Webview serializer 復元時は、最後に見ていた scroll 位置も `scrollY` / `topMessageIndex` として保存し、復元後に同じ message 付近へ戻す
  - Webview 復元設定は実験的な opt-in 設定として既定無効にし、VS Code の復元遅延により同じ履歴を再度開いたときにタブが重複する場合があることを設定説明で明示する
  - serializer 復元時も通常生成と同じ `webview.options`、HTML、`onDidReceiveMessage`、`onDidChangeViewState`、`onDidDispose` を再アタッチする
  - 開いているチャットタブは裏タブでも自動更新対象にする
  - `refreshAutoRefreshPanels(changedFsPaths)` は変更されたセッションファイルに対応するチャットタブだけ再読み込みする
  - Webview がまだ ready でない場合のみ `pendingAutoRefresh` として保持し、ready 後に 1 回反映する
  - Webview 内検索は入力ごとの即時 DOM 全走査を避けるため短い debounce を入れ、Enter / 前へ / 次へ / query クリアは即時反映する
  - 新規チャットタブ、または別セッションへ差し替えた再利用チャットタブは `off` から開始する
  - 同じセッションの既存タブは自動更新モードを維持する

### 4.5 検索インデックス

- `src/services/searchIndexService.ts`
  - `search-index.v2.json` を管理する。ファイル名は `src/storage/cacheFiles.ts` の共通定数を使う
  - `SEARCH_INDEX_FILE_VERSION = 10` とし、archive context / file change hints / attachment metadata / request interruption filtering / user instructions filtering 追加前の既存インデックスは再構築対象にする
  - ファイル内 cache version が一致しない場合は既存インデックスを破棄し、次回検索時に再構築する
  - 検索インデックス読み込み時の parse error はインデックスを削除して `null` 扱いにし、次回検索時に再構築する
  - セッションごとに `mtime` / `size` を持ち、差分更新する
  - index context に `codexArchivedSessionsRoot` と `includeCodexArchived` を含め、archived root / 有効状態の変更を検知する
  - JSONL をストリーミングで読み、検索対象メッセージ列を構築する
  - `search.indexToolContent` に応じてツール名 / 引数 / 出力を検索インデックスへ入れる範囲を変える
  - Codex の `custom_tool_call` は既存 tool 検索と同じ `role: tool` / `source: toolArguments` 粒度で、軽量メタだけを入れる
  - Codex の `custom_tool_call_output` は `toolCallsAndOutputs` のときだけ `role: tool` / `source: toolOutput` として短い実行メタを入れる
  - `conversationOnly` のときは `custom_tool_call` の callId 紐付けだけを維持し、検索用メタ生成は行わない
  - `extractCodexMessageContent()` / `extractClaudeMessageContent()` を使い、clean text と attachment metadata を検索対象へ入れる
  - `buildAttachmentSearchText()` は attachment label、path、MIME type、file kind、Claude text document の上限内 text を返す
  - PDF / Office / binary / base64 document の本文と、Codex file reference の参照先ファイル本文は検索インデックスへ入れない
  - 旧キャッシュに `indexToolContent` がない場合は `toolCallsAndOutputs` とみなし、既定設定のままなら不要な再作成を避ける
  - `cleanupOrphanEntries()` で現在の履歴に存在しない cacheKey を削除する
  - 実ファイルが消えている場合は `stat` 失敗時に該当エントリを削除する
  - `forceRebuild` 指定時は内部エントリをクリアして最初から作り直す

### 4.5.1 File AI Change History 実装

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
  - `codexHistoryViewer.webview.restoreAfterReload = true` のときだけ `codexHistoryViewer.fileChangeHistory` の `WebviewPanelSerializer` を登録し、Reload Window / VS Code 再起動後も対象ファイルと読み込み済みカード件数を元に再読み込みする
  - Webview serializer 復元時は、最後に見ていた card anchor を `scrollAnchor` として保存し、復元後に同じ card 付近へ戻す
  - serializer 復元時は対象ファイルが存在し、保存された workspace root が現在の workspace に含まれる場合だけ復元する
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
  - Webview 内検索の Enter / 前へ / 次へでは pending debounce を flush し、flush 済みの場合は同じ検索 refresh を二重実行しない
  - 追加読み込み成功後も scroll 位置を維持する
  - `model` message 受信時は `render()` / scroll 復元前に restore state を保存せず、`restoreReloadScrollAnchor()` / `restoreScroll()` の適用後に `scrollAnchor` を保存する
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
  - 候補絞り込みは「日付 / プロジェクト / ソース / History タグ」の順で適用する
  - `includeArchivedSessions` に従って archived session を除外し、除外後に `search.maxResults` を適用する
  - プロジェクト別名は検索 hit 対象には含めず、検索実行時に SearchRootNode の scope label へだけ反映する
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
  - `Empty Trash` 実行時に旧世代キャッシュ / インデックスと、1 時間以上古い `*.tmp-*.json` も整理する

### 4.8 注釈 / ピン / 保存済み検索 / プロジェクト関連付け

- `src/services/sessionAnnotationStore.ts`
  - タグ / ノートを `globalState` に保存する
  - session path 移動時は `relocateSessionPath()` で annotation を新 path へ移す
  - path 移動時に移行先 annotation がある場合、tags は merge し、note は空文字でも移行先を優先する
- `src/services/pinStore.ts`
  - ピン留め情報を `globalState` に保存する
  - `PinEntry` は `identityKey` / `archiveState` / `rootKind` を保持する
  - refresh 後の `reconcile()` で identity key を使い、active / archived 間で移動した pin path を追従する
  - archived 由来 pin は archived sessions 無効時またはアーカイブ非表示時に missing として出さない
- View / filter state
  - History の日付 / project CWD / project display / project scope / source / tag / view mode は `workspaceState` に保存する
  - Pinned の日付 / project CWD / project display / project scope / source / archive location / sort mode / tag は `workspaceState` に保存し、History / Search とは独立して扱う
  - Search の `lastSearchRequest` は `workspaceState` に保存する。Search 独自の tag filter は持たず、History 側の tag filter を使う
  - `pinnedSourceFilter` の初回未保存時は `historySourceFilter` を初期値として移行し、`pinnedArchiveLocationFilter` の初回未保存時は `archiveLocationFilter` を初期値として移行する
  - プロジェクト判定用の key は `normalizeProjectKey()` で正規化し、全 OS で大文字小文字を区別しない
- `src/services/searchPresetStore.ts`
  - 保存済み検索語を `globalState` に保存する
  - 保存済み検索はプロジェクト単位に分けず全体共有とし、検索語だけを保存 / 表示 / 再利用する
- `src/services/searchHistoryStore.ts`
  - 検索履歴を `workspaceState` に保存する
  - 検索履歴は project bucket ごとに最大 20 件を保持する
  - 検索語だけを保存し、検索対象ロールや大文字小文字の扱いは保持しない
- `src/services/projectAssociationStore.ts`
  - プロジェクト関連付けを `globalState` に保存する
  - 関連付けは project key 間の display-side association として扱い、元の履歴ファイルは移動しない
- `src/services/chatOpenPositionStore.ts`
  - 最後に見えていた表示位置を `globalState` に最大 100 セッション分保存する
  - 復元には `chat.openPosition = lastMessage` のときだけ使用する
  - `chat.openPosition = latest` は保存位置を使わず、Webview 側で最新の描画済みカードへ移動する
  - session path 移動時は `relocateSessionPath()` で保存位置を新 path へ移す
  - path 移動時に移行先 entry が既にある場合は移行先を優先し、source 側で上書きしない

### 4.8.1 Handoff

- `src/services/handoffService.ts`
  - 元セッション JSONL を UTF-8 stream として読み取り、Handoff 用の transcript 抜粋とファイル変更を生成する
  - LLM による要約生成は行わず、末尾優先で transcript 本文をサイズ上限内に切り出す
  - Codex は `patch_apply_end` の `unified_diff` を復元可能なファイル変更として取り込む
  - Claude は `Edit` / `MultiEdit` / `Write` から復元可能な synthetic diff を作る
  - tool call / tool output 本文は Handoff ファイルへ含めない
  - Codex の `Files mentioned by the user` block と Claude の IDE tag は raw のまま再出力せず、clean text と attachment summary を使う
  - Codex 向け Handoff / Resume でも `# Files mentioned by the user:` block は再生成しない
  - バイナリ添付や参照先ファイルは再添付 / 自動読み込みせず、過去セッションに存在した添付 / 参照の summary として扱う
  - プロジェクト関連付けがある場合は、関連付け後の表示 CWD とパス変換情報を Handoff 内容へ反映する
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

### 4.8.2 Codex アーカイブ / 復元

- `src/services/restoreArchivedSessionService.ts`
  - `restoreArchivedSessionToActive()` は archived Codex session を通常 Codex history へ戻す
  - `archiveSessionToArchived()` は active Codex session を Codex archive へ移動する
  - restore は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem provider へ fallback する
  - archive は公式 Codex provider の `thread/archive` のみを使い、filesystem fallback は行わない
  - 公式 provider は bundled `codex` executable を見つけ、app-server initialization 後に `codexHome` が設定 root と整合する場合だけ使う
  - filesystem restore は作成日の `<YYYY>/<MM>/<DD>` 配下へ Move し、同名衝突時は suffix を付ける
  - filesystem restore の move 失敗時は copy to temp、size 検証、destination rename、source delete の順で fallback する
  - 公式 provider 成功後に移動先を解決できない場合は、active root / archived root の再スキャンで解決する
- `src/services/sessionReferenceRelocator.ts`
  - session path 移動時に annotation / bookmark / chat open position を可能な範囲で新 path へ移す
  - bookmark は `bm-<sessionHash>-<kind>-<targetHash>` の `<targetHash>` を維持し、移行先 path の `<sessionHash>` だけ差し替える
  - 個別 metadata の移行に失敗しても archive / restore 自体は破綻させず、診断ログに留める
- `src/extension.ts`
  - `codexHistoryViewer.restoreArchivedSession` は確認後に restore を実行し、成功後に履歴を refresh する
  - Chat WebView 由来の restore は direct 引数の `revealMessageIndex` を検証し、復元先 active path の `ChatOpenPositionStore` に保存する
  - restore が例外を投げた場合は `app.restoreArchivedFailed` を表示し、履歴と view を更新して部分移動済み状態にも追従する
  - filesystem restore の場合だけ Undo を出し、公式 provider restore では本家状態との整合を優先して Undo を出さない
  - `codexHistoryViewer.archiveSession` は Codex source と archived sessions が有効な active Codex session だけを対象にする
  - `archiveLocationFilter` は History / Search 用として `workspaceState` に保存し、VS Code context `codexHistoryViewer.archiveLocationFilter` に反映する
  - `pinnedArchiveLocationFilter` は Pinned 用として `workspaceState` に保存し、VS Code context `codexHistoryViewer.pinnedArchiveLocationFilter` に反映する

### 4.9 表示

- チャット表示: `src/chat/*`
  - `ChatPanelManager` は対象ファイルの存在を確認してから開く / reload する
  - refresh や削除で元ファイルが消えたパネルは閉じる
  - archived Codex session では `Resume in Codex` の代わりに `Move to Codex History` を表示する
  - `restoreArchivedSession` message を受け取り、復元成功後は同じ Webview panel を通常 session で開き直す
  - archived Codex Chat からの restore message は `lastMessage` 時に現在見えている `revealMessageIndex` を渡し、復元後 panel で明示 reveal する
  - `ChatPanelManager` はツリー選択用の `reusable` タブと、明示的に開いた `session` タブを区別する
  - 既存タブ検索では `session` タブを優先し、なければ同じセッションを表示中の `reusable` タブを使う
  - `ChatPanelManager` は `ChatOpenPositionStore` を使い、明示的な移動先がない場合だけ最後に見えていたメッセージ付近を復元する
  - `ChatPanelManager` は保存可能な画像をパネル単位で保持し、Webview からの保存要求時に `showSaveDialog` 経由で書き出す
  - `ChatPanelManager` は保存可能な embedded document をパネル単位で保持し、Webview からの `saveAttachment` 要求時に `showSaveDialog` 経由で書き出す
  - `ChatPanelManager` は `saveImage` / `saveAttachment` の session `fsPath` を検証し、現在の panel と一致しない stale request では保存処理を行わない
  - `ChatPanelManager` は Webview からの `openAttachment` message を受け取り、file reference を VS Code API 経由で開く
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
  - `chatModelBuilder.ts` は `extractCodexMessageContent()` / `extractClaudeMessageContent()` の結果から clean text と `attachments` を message item へ設定する
  - `chatTypes.ts` は `ChatImageAttachment` / `ChatDocumentAttachment` / `ChatFileReferenceAttachment` / `ChatSelectionReferenceAttachment` を `ChatAttachment` として定義する
  - `chatAttachments.ts` は画像、Claude document、Claude IDE tag、Codex `Files mentioned by the user` block を統合して抽出する
  - `chatAttachments.ts` は content item を出現順に走査し、image / document attachment の順序を保つ。IDE tag 由来の file / selection reference は clean text 抽出後の attachment として扱う
  - `chatAttachments.ts` は `localimage` / `imageassetpointer` などの image-like type を patch detail 側の attachment-like 判定にも含め、messageIndex のドリフトを防ぐ
  - Codex `Files mentioned by the user` block は message 先頭または IDE context 後ろの本文途中から file reference に変換し、raw block は本文に残さない
  - Claude `<ide_opened_file>` / `<ide_selection>` は file reference / selection reference に変換し、raw tag は本文に残さない
  - Claude text document は表示用抜粋と検索用テキストをそれぞれの上限内で保持し、Save As 用 payload は panel 側 store へ置く
  - PDF / generic base64 document は初期 Webview model へ payload を渡さず、metadata と `dataOmitted` だけを渡す
  - `chatImageAttachments.ts` は Codex / Claude の画像データ、ローカル画像参照、画像プレースホルダーを正規化する
  - `chatImageAttachments.ts` は `enabled: false` の抽出でも payload を読まずに MIME type / label などの metadata を保持し、検索や summary に利用できるようにする
  - `chatImageAttachments.ts` は Claude `type: "document"` を image extraction から除外し、MIME type 欠落 base64 document の二重抽出を防ぐ
  - 未対応 / 欠損 / remote-only / サイズ超過 / 設定無効の画像は表示不能理由としてモデル化する
  - `media/chatView.js` は `attachments` の順序を維持し、連続する画像だけを image group として描画する
  - `media/chatView.js` は Code / Image reference の file kind badge を dedicated l10n label で表示し、generic file label へフォールバックさせない
  - `media/chatView.js` は assistant message 内の `::code-comment{...}` directive を Markdown 本文から分離し、レビューコメントカードとして表示する
  - code comment directive parser は `file` / `title` / `body` / `start` / `end` / `priority` の既知キーを string 外で検出し、属性順序、optional comma、raw 改行、未知 segment の揺れを許容する
  - `start` / `end` は先頭の正整数部分を採用し、負数など正整数で始まらない値は不正として扱う
  - `::code-comment{...}` の範囲を特定できる parse 失敗は未解析カードへ fallback し、範囲を特定できない場合だけ raw text fallback にする
  - code comment card の本文は HTML / Markdown として解釈せず `textContent` で表示し、directive 由来文字列を `innerHTML` に渡さない
  - document / file reference / selection card は path / MIME type / byte size を本文上に常時表示せず、tooltip へ寄せる
  - text document preview は action icon から開閉し、開いた preview は同じ card 内の下段に full-width panel として表示する
  - 詳細非表示時の `canRenderMessage()` は `attachments` を見て、本文が空で添付だけの user message も描画対象にする
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
  - Webview 側は日付ガイド用 item に `attachmentKind` と attachment summary を渡し、添付あり message をガイド上で識別できるようにする
  - Webview 側の日付ガイド attachment summary では、最大 3 種類の要約、hidden unique kind 数の `+N`、必要時の総添付数 suffix を分けて扱う
  - Webview 側は IntersectionObserver で表示範囲付近の画像だけ data URI を要求し、セッション切替時は画像データキャッシュを破棄する
  - Webview 側の `saveImage` / `saveAttachment` message は現在の session `fsPath` を添えて送信し、host 側は stale / missing session request を保存処理から除外する
  - `follow` モードは、`#timeline` に描画済みの `.row` から追従対象を選ぶ。末尾が `patchGroup` の場合は直前の非 `patchGroup` 行を優先し、非 `patchGroup` 行がなければ最後の `patchGroup` 行へフォールバックする
  - チャット末尾ボタンは、`#timeline` に描画済みの最後の `.row` へスクロールする
  - patch group のカード幅保持キーは `turnId`、メッセージ index、変更ファイル情報などから安定的に作る
- Markdown transcript: `src/transcript/*`
  - Codex session の `Location: Active` / `Location: Archived` を transcript metadata として表示する
  - Export した Markdown transcript でも同じ Location metadata を出力する
  - 添付 / ファイル参照は本文へ raw tag / `Files mentioned` block を出さず、attachment summary として出力する
  - Resume 用 text は clean text と attachment summary を使い、バイナリ再添付や raw block の再生成は行わない
- Control / Status ビュー: `src/tree/utilityTrees.ts`
  - Status は Codex source と archived sessions が有効な場合だけ Codex archived 件数と Codex archived sessions root を表示する
  - Codex archived sessions root は、Codex source が無効な場合や archived sessions が無効な場合は表示しない
  - Current project 表示は、プロジェクト別名がある場合に alias label を使う
- History / Pinned / Search ツリー: `src/tree/*`
  - History は `date` / `latest` の表示モードを持ち、`latest` ではセッションをフラットに降順表示する
  - プロジェクト別名がある場合は、Project node、session description、tooltip、Search の session 行表示に alias を反映する
  - Project node の contextValue は CWD 有無で `codexHistoryViewer.project.withCwd` / `codexHistoryViewer.project.noCwd` に分け、CWD なしには alias menu を出さない
  - archived Codex session は description / tooltip / icon 色で通常履歴と区別する
  - `archiveLocationFilter="activeOnly"` のときは archived Codex session を History / Pinned / Search から除外する

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
  - `codex.archivedSessions.enabled`、`codex.archivedSessionsRoot`、`preview.*`、`search.*`、`history.titleSource`、`autoRefresh.*`、`chat.openPosition`、`chat.toolDisplayMode`、`images.*`、`webview.restoreAfterReload` などの設定もここで管理する
  - 数値設定は下限 / 上限を丸め、想定外の enum 値は既定値へ戻す
  - `webview.restoreAfterReload` は実験的な opt-in 設定として既定 `false` とし、変更は次回の Reload Window / VS Code 再起動後に反映する
  - `preview.maxMessages` は `1..50`、`search.maxResults` は `1..10000` に丸め、`package.json` の `minimum` / `maximum` と一致させる
  - `codex.archivedSessionsRoot` が空の場合は `sessionsRoot` の兄弟 `archived_sessions` を使う
  - `sources.enabled` は最上位の親設定であり、`codex` が含まれない場合は `codex.archivedSessions.enabled` が true でも archived sessions を無効扱いにする
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
  - code comment card の通常 / 未解析時の表示ラベル (`Code Comment` / `File` / `Lines` / `Code comment (unparsed)` / `(empty directive)`) もここで管理する
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
  - `BookmarkKeyParams.fallbackId` は target identity 由来に限定し、session path / cache key / 既存 bookmark key は使わない
  - session path relocation では bookmark key の `<sessionHash>` だけ差し替え、`<targetHash>` は維持する
  - 既に不一致 key へ変換済みの旧 entry は互換救済しない
- `media/chatView.js` / `media/fileChangeHistory.js`
  - `bookmarkState` を受け取り、カード上のしおりボタンとカード強調を更新する
  - 日付ガイドが無効な場合は、カード上のしおり UI も生成しない
  - 日付ガイド用 item には `bookmarked` と user role を渡し、Webview DOM にも `data-bookmarked` / `data-time-guide-role` を反映する
- `media/sharedTimeGuide.js` / `media/sharedTimeGuide.css`
  - 日付ガイド上で user / しおり / 現在位置を別表現として描画する
  - Chat の日付ガイド item では `attachmentKind` を受け取り、添付あり / 画像のみ / mixed の dot ring を描画する
  - 添付 indicator は user / しおり / 現在位置と同時に表示されても潰れないよう、dot の塗りではなく外側 ring を使う
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

### 5.4 v2.6.1 リリースメモ（2026-06-22）

**追加された機能**

- Codex / Claude Code のリクエスト中断記録を、通常の user bubble ではなく timeline system event として表示するようにした。Codex の `<turn_aborted>` / `event_msg.turn_aborted` と、Claude Code の `[Request interrupted by user]` / `[Request interrupted by user for tool use]` を対象にする
- 中断 marker は `リクエスト中断` / `Request stopped` の専用 card として表示し、details off でも履歴上の区切りとして見えるようにした
- 中断詳細として、取得できる場合は理由、duration、turn id、ロールバック済み状態、ロールバック turn 数を details 表示に出せるようにした

**変更された機能**

- 中断 raw message は user / assistant の `messageIndex` 採番に含めず、通常履歴、patch detail、File History、search index の 4 経路で同じ raw content 判定 helper を使うようにした
- Codex の raw `<turn_aborted>` と structured `turn_aborted` event は近接 window 内で dedup し、`turn_id` が両方にある場合は一致時だけ merge するようにした
- Codex `<user_instructions>` は既存 boilerplate context と同じく、通常 user prompt 表示、session preview、検索 index の対象から外すようにした。ただし既存 boilerplate と同じく `messageIndex` 採番は維持する
- 検索 index cache version を `10` に更新し、中断 raw text や `<user_instructions>` が残った古い index は再構築対象にした

**修正された機能**

- Codex / Claude Code の中断制御メタが user message として表示されたり、検索・preview・sticky user header に混ざったりする問題を修正した
- Claude Code の中断 record を挟んだ後も、通常履歴、patch detail、File History、search index の `messageIndex` が揃うようにし、Claude diff bookmark group の同期ずれを防ぐようにした
- Claude Code の text-only 中断 record と tool result / attachment 混在 record を raw content で区別し、混在 record は通常 message として扱うようにした
- `package.json` / `package-lock.json` のバージョンを `2.6.1` に更新した

### 5.5 v2.6.0 リリースメモ（2026-06-12）

**追加された機能**

- History に開始日時、最終メッセージ日時、名前の昇順 / 降順ソートを追加した。ソート設定は workspaceState に保存し、次回起動後も維持する
- Pinned にピン留め順、開始日時、最終メッセージ日時、名前の昇順 / 降順ソートを追加した。Pinned のソート設定も workspaceState に保存する
- History / Pinned の More Actions に並び替え項目を追加し、現在の選択項目には `（現在）` / ` (Current)` を付けて表示する

**変更された機能**

- History の `最新順` 表示名を `セッション一覧` に変更した。内部の view mode 名は互換性のため `latest` を維持する
- History の表示形式、表示対象、表示モード、並び替えを変更したとき、選択中セッションを可能な範囲で新しいツリー上へ追従して reveal するようにした
- History の日付別表示では、Year / Month / Day の bucket は既存の日付基準を維持し、同一日内の session row だけを選択中の sort order で並び替える
- 日付系 sort の session row は sort 軸の日時を表示し、Date Basis と異なる場合は tooltip で Date Basis 側の日時を補足する。`titleOnly` tooltip では Date Basis 側のみ、`compact` / `full` tooltip では開始日時と最終メッセージ日時の両方を確認できる
- Project 表示では、History / Pinned ともに選択中の sort order に沿って Project node と配下セッションを並べる。名前順ではカスタムタイトル解決後の表示名を使う
- More Actions には操作できる項目だけを表示し、ソースが 1 種類だけ有効な場合の source 選択や、History で Claude Code のみ選択中の archive 表示は group ごと非表示にする
- Pinned の sort toggle icon は toolbar から外し、表示順の変更は More Actions に集約した
- Pinned project tooltip の代表日時表現を `最終ピン留め` / `最新セッション` から、昇順や名前順でも破綻しにくい `ピン留め日時` / `セッション日時` に変更した

**修正された機能**

- sort / 表示状態の切り替え後に、選択中の履歴が見失われやすい問題を軽減した
- `package.json` / `package-lock.json` のバージョンを `2.6.0` に更新した

### 5.6 v2.5.1 リリースメモ（2026-06-10）

**修正された機能**

- `Empty Trash` が現行の `cache.v9.json` を旧世代キャッシュとして削除し得る問題を修正した
- 履歴キャッシュ / 検索インデックスの現行ファイル名を `src/storage/cacheFiles.ts` に一元化し、書き込み先と保守処理の drift を防ぐようにした
- 履歴キャッシュ / 検索インデックスの JSON parse error を missing / read error と切り分け、破損時は退避せず削除して再生成できるようにした
- JSON 書き込みを一時ファイル経由の best-effort atomic write に変更し、rename に失敗する provider では直接書き込みへフォールバックするようにした。古い孤立一時ファイルは `Empty Trash` で内部的に回収できるようにした
- `package.json` / `package-lock.json` のバージョンを `2.5.1` に更新した

### 5.7 v2.5.0 リリースメモ（2026-06-07）

**追加された機能**

- **プロジェクト関連付け**を追加した。別プロジェクトの履歴を現在のプロジェクトに紐づけて表示したり、関連プロジェクトとしてまとめて扱える
- 履歴ビュー / ピン留めビューに、**一覧表示 / プロジェクト別表示** と、**すべて / 現在のプロジェクトグループ** の切り替えを追加した
- 検索履歴を追加した。全体検索、履歴ビュー内検索、ファイル変更履歴の検索で、検索語の履歴を共有できる
- 検索結果を開いたとき、同じ検索語を履歴ビュー内検索に引き継げるようにした
- 履歴ビュー内検索とファイル変更履歴の検索で、正規表現や完全一致など、より柔軟な検索表現に対応した
- 履歴ビュー内検索とファイル変更履歴の検索に、検索履歴候補の表示・選択・削除を追加した
- Codex のメモリー引用情報を、履歴ビュー内で折りたたみ表示できるようにした
- チャット履歴で、現在のユーザープロンプトを上部に追従表示できるようにした
- Handoff がプロジェクト関連付けを考慮するようになり、関連付け後のプロジェクト表示に沿った引き継ぎ内容を作れるようにした

**変更された機能**

- 履歴ビュー / ピン留めビューのプロジェクト表示まわりを整理し、「表示方法」と「対象範囲」を別々に切り替えられるようにした
- 全体検索は、履歴ビューで選んでいる表示対象に連動するようにした。プロジェクト範囲、タグ、Codex / Claude などの種類、アーカイブ対象、日付など、現在の表示条件に沿って検索する
- 全体検索の入力欄を改善し、手入力・検索履歴からの再検索・検索履歴の個別削除を同じ画面から行えるようにした
- 保存済み検索は「検索語だけ」を保存・表示・再利用する方式に変更した。実行時の検索対象や大文字小文字の扱いはその時点の現在設定を使う。保存済み検索はプロジェクト単位で分けず全体で共有し、実行 QuickPick のゴミ箱ボタンで個別削除する
- Search ペインの絞り込み操作を History 側に集約した。Search が空のときは History 側の絞り込み変更だけでは結果を生成せず、既存の Search 結果がある場合だけ実効値変更時に再検索する
- 履歴ビュー / ピン留めビューの再読み込みと Search ペインの再検索を、それぞれエクスポートのすぐ左に配置した
- 履歴ビュー内検索は、入力中・履歴選択時・検索結果からの引き継ぎ時に勝手にスクロールしない挙動へ整理した
- ファイル変更履歴でも、プロジェクト関連付け後の表示に沿って履歴を扱えるようにした

**修正された機能**

- ファイル変更履歴の検索で、「これ以上の履歴はありません」/ “No more history” が検索に引っかからないように修正した
- 履歴ビュー内検索 / ファイル変更履歴の検索で、入力中に候補が無くなった場合に「検索履歴はありません」が検索結果へ重ならないように修正した
- ピン留めビューのプロジェクト並び順が、同じ時間に更新された場合に崩れることがある問題を修正した
- `package.json` / `package-lock.json` のバージョンを `2.5.0` に更新した

### 5.8 v2.4.1 リリースメモ（2026-05-26）

- プロジェクト (`cwd`) に、この拡張機能内だけの別名を設定 / 消去できるようにした
- プロジェクト別名は History / Pinned のプロジェクト見出し、セッション行、tooltip、絞り込み表示、Status、Search の scope / セッション表示に反映する
- プロジェクト別名は検索 hit 対象には含めず、検索結果 root の scope label は次回検索または `Rerun Search` 時に更新する
- Project node の contextValue を CWD 有無で分け、CWD なしプロジェクトには別名メニューを出さないようにした
- 実験的な opt-in 設定 `webview.restoreAfterReload = true` で、通常履歴 Webview とファイル履歴 Webview を Reload Window / VS Code 再起動後に復元できるようにした
- Webview 内検索の入力を debounce し、通常履歴 Webview / ファイル履歴 Webview の検索中の入力負荷を抑えた
- 通常履歴 Webview / ファイル履歴 Webview の検索パネルがウィンドウ幅 860px 以下で強制的に画面全幅になり、リサイズハンドルが消える挙動を修正した
- Webview 復元時に、通常履歴 Webview は最後に見ていた message 付近、ファイル履歴 Webview は最後に見ていた card 付近へ戻るようにした
- Chat Webview で `::code-comment{...}` directive をレビューコメントカードとして表示し、comma 区切りや複数行、未知 segment を含む出力も既知キーから復元できるようにした
- `package.json` のバージョンを `2.4.1` に更新した

### 5.9 v2.4.0 リリースメモ（2026-05-23）

- History に `絞り込みなし` / `現在のプロジェクト` / `プロジェクト単位` のプロジェクト表示 mode を追加した
- プロジェクト判定用 key を全 OS で大文字小文字非区別に統一した
- History の `プロジェクト単位` では、`最新順` は `Project -> Session`、`日付別` は `Project -> Year -> Month -> Day -> Session` で表示するようにした
- History の絞り込み解除 action は非絞り込み時も disabled として表示し、プロジェクト単位表示は解除対象から外した
- プロジェクト表示の toolbar icon を、操作後の状態ではなく現在の状態を示すように変更した
- Pinned に History とは独立したプロジェクト表示 mode を追加した
- Pinned に History / Search とは独立したアーカイブ表示切替を追加した
- Pinned に `ピン留め日順` / `セッション日付順` の表示順切替を追加した
- Pinned に日付スコープ / プロジェクト / ソース / アーカイブ表示 / タグをまとめて扱う絞り込み action と、絞り込み解除 action を追加した
- Pinned に `all` / `codex` / `claude` のソース切替を追加し、History 側のソース切替とは独立して保持するようにした
- Pinned のソースが `claude` のとき、Pinned のアーカイブ表示切替を disabled 表示かつ no-op にした
- Pinned のプロジェクト tooltip を表示順に合わせて `最終ピン留め` / `最新セッション` として分けた
- Search view title の `Clear Results` と `Rerun Search` の表示順を入れ替えた
- Codex の `# Files mentioned by the user:` block が IDE context 後ろにある場合も、HTML / log / JSON などの file reference attachment として表示されるように修正した
- `package.json` / `package-lock.json` のバージョンを `2.4.0` に更新した

### 5.10 v2.3.0 リリースメモ（2026-05-22）

- Chat message の添付モデルを `attachments` に統合し、画像も `type: "image"` の attachment として扱うようにした
- Claude Code の `type: "document"` を document card として表示できるようにした
- Claude Code の PDF document は PDF card、text document は text card、unknown document は generic document card として表示するようにした
- Claude text document の preview / search / Save As に上限を設け、巨大 text / binary payload を初期 Webview model へ渡さないようにした
- Claude Code の `<ide_opened_file>` / `<ide_selection>` を本文から除去し、file reference / selection reference card として表示するようにした
- Claude Code 公式の `<ide_opened_file>The user opened the file ... in the IDE...</ide_opened_file>` 形式に対応し、拡張子なしの well-known text file を text kind として扱うようにした
- Codex の `# Files mentioned by the user:` block を解析し、file reference card に変換するようにした
- Codex の `## My request for Codex:` 以降だけを本文として残し、区切りがない variant は安全に判定できる場合だけ file block と本文を分離するようにした
- Codex file reference は参照先ファイルを自動で読まず、履歴に保存された label / path / line 情報だけを使うようにした
- Word / Excel / PowerPoint / PDF / zip / 任意拡張子を file reference として扱えるようにした
- Chat attachment card は file kind badge、ファイル名、action icon 中心の compact 表示にし、path / MIME type / byte size は tooltip へ寄せた
- text document preview は保存ボタン左の preview action icon から開閉し、開いた場合は同じ card 内の下段に full-width panel として表示するようにした
- file kind ごとに badge icon / accent を変え、PDF / Word / Excel / PowerPoint / Text / Code / Archive / Image reference / Selection / Generic file を区別できるようにした
- Code / Image reference の badge text が generic `File` に落ちないよう、専用 l10n label を追加した
- 添付の表示順は `attachments` の順序を保ち、連続する画像だけを既存の image group としてまとめるようにした
- 同一 message 内で画像 group が分かれても、画像 preview の前後移動は message 全体の previewable images を対象にするようにした
- Search / Markdown / Resume / Handoff など画像 payload を読まない経路でも、画像の MIME type / 推定 label metadata を保持するようにした
- `localimage` / `imageassetpointer` などの image-like type を attachment-like 判定に含め、main path と patch detail path の messageIndex がズレないようにした
- Claude `type: "document"` を image extractor から除外し、MIME type 欠落時も document と image に二重抽出されないようにした
- embedded document の Save As は panel 側 payload store から on-demand で保存するようにした
- `saveImage` / `saveAttachment` は session `fsPath` を検証し、セッション切替直後の stale request で別セッションの payload を保存しないようにした
- file reference の Open は shell command を使わず、VS Code API 経由で開くようにした
- 詳細非表示時の描画可否判定を `attachments` ベースへ修正し、本文が空で添付だけの user message でも Webview 描画が止まらないようにした
- 日付ガイドに添付あり message の indicator を追加し、tooltip に attachment summary を含めるようにした
- 日付ガイドの添付 indicator は通常添付、画像のみ、mixed を dot 外側の控えめな ring で区別するようにした
- 日付ガイドの attachment summary を、最大 3 種類の要約、hidden unique kind 数の `+N`、必要時の総添付数 suffix に分ける方針にした
- Search index に attachment label、path、MIME type、file kind、Claude text document の上限内 text を含めるようにした
- PDF / Office / binary / base64 document の本文と、Codex file reference の参照先ファイル本文は検索インデックスへ入れないようにした
- Markdown transcript に attachment summary を出し、raw IDE tag や `Files mentioned` block をそのまま出さないようにした
- Resume / Handoff では clean text と attachment summary を使い、raw tag / `Files mentioned` block の重複やバイナリ再添付を避けるようにした
- `package.json` / `package-lock.json` のバージョンを `2.3.0` に更新した

### 5.11 v2.2.0 リリースメモ（2026-05-21）

- Codex の通常 `sessions` に加えて、任意で `archived_sessions` を読み込めるようにした
- `codexHistoryViewer.codex.archivedSessions.enabled` と `codexHistoryViewer.codex.archivedSessionsRoot` を追加した
- `sources.enabled` は `codex` / `claude` の最上位ソース設定のままとし、`codex` が含まれる場合だけ archived sessions 設定を適用するようにした
- 設定 UI では `Sources: Enabled` を先頭に置き、Codex archived sessions 設定がその子設定だと分かるようにした
- archived sessions root の既定値を、Codex `sessionsRoot` と同階層の `archived_sessions` にした
- History / Pinned / Search に `通常のみ` / `すべて` / `アーカイブのみ` のアーカイブ表示切り替え view title action を追加した
- `通常のみ` のときは、History / Pinned / Search から archived Codex session を即時に除外するようにした
- Search はアーカイブ非表示時に archived hit を候補から除外し、表示される hit 数が `search.maxResults` に達するようにした
- Codex archived session を History / Pinned / Search / Markdown / Chat で通常 session と区別できるようにした
- Markdown transcript に `Location: Active` / `Location: Archived` を表示し、Chat では archived Codex session を `Archived` 表示で識別できるようにした
- archived Codex session の Chat では、`Resume in Codex` の代わりに `Move to Codex History` を表示するようにした
- active Codex session の右クリックメニューに `Move to Archive` を追加した
- archived Codex session の右クリックメニューに `Move to Codex History` を追加した
- 移動系 action は active / archived で相互排他にし、カスタムタイトル系 action の下、Delete より上に区切って配置した
- archived Codex session では `Resume in Codex` と `Promote to Today (Copy)` を表示しないようにした
- `Move to Archive` は公式 Codex provider の `thread/archive` を使うようにした
- `Move to Codex History` は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem provider の Move に fallback するようにした
- filesystem restore では作成日の `<YYYY>/<MM>/<DD>` へ戻し、同名衝突時は suffix を付けるようにした
- filesystem restore の Move には Undo を提供し、公式 provider restore では本家状態との整合を優先して Undo を出さないようにした
- restore / archive / pin reconcile 時に、annotation / bookmark / chat open position を移動先 path へ寄せるようにした
- archive / unarchive 時の bookmark key 移行で target hash を維持し、WebView で同じしおりとして認識できるようにした
- archived Chat の `Move to Codex History` は `chat.openPosition = lastMessage` のとき操作直前の表示位置へ復元後に移動するようにした
- Export した Markdown transcript にも `Location: Active` / `Location: Archived` を出すようにした
- metadata relocation の衝突時は、annotation note と chat open position で移行先を優先するようにした
- pin に `identityKey` / `archiveState` / `rootKind` を追加し、公式側でアーカイブされた Codex session の path 変更へ追従できるようにした
- archived sessions が無効または非表示のとき、archived 由来 pin を Pinned の missing として表示せず、Status の missing pin count にも含めないようにした
- Status に、Codex source と archived sessions がどちらも有効な場合だけ Codex archived session count と Codex archived sessions root を表示するようにした
- Auto Refresh で archived root の `rollout-*.jsonl` も監視できるようにした
- 履歴キャッシュを `cache.v9.json` に更新し、archived root / archived 有効状態 / identity dedupe を含めるようにした
- 検索インデックスの context に archived root / archived 有効状態を含めるようにした
- `package.json` のバージョンを `2.2.0` に更新した

### 5.12 v2.1.0 リリースメモ（2026-05-19）

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

### 5.13 v2.0.1 リリースメモ（2026-05-15）

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

### 5.14 v2.0.0 リリースメモ（2026-05-14）

- ワークスペース内のファイルを起点に、Codex / Claude の diff 履歴を時系列で確認できる File AI Change History を追加した
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

### 5.15 v1.5.1 リリースメモ（2026-05-08）

- 自動更新 `follow` で、末尾が grouped diff カードの場合に本文追従が diff に奪われないよう、直前の非 diff カードを追従対象にするようにした
- 自動更新 `follow` では pending のカードアンカー復元より追従を優先し、レイアウト更新後に追従位置がずれにくいよう再スクロールするようにした
- `chat.openPosition = lastMessage` で、画面内に本文メッセージがない位置の保存や、復元対象メッセージが描画されない場合に、直前の描画済み本文メッセージまたは先頭へフォールバックするようにした
- `chat.openPosition = latest` で、移動先指定のないチャット表示を最新の描画済みカードから開けるようにした
- チャット末尾ボタンは最後に描画されたカードへ移動するため、diff そのものを確認できる
- Codex の `custom_tool_call` を、`toolCalls` / `toolCallsAndOutputs` の検索インデックスに軽量メタとして含めるようにした
- `custom_tool_call` の patch / diff 本文は検索インデックスに入れず、対象ファイルや command など検索の入口になる情報だけを入れるようにした
- 検索インデックスの cache version を更新し、既存 cache は次回検索時に自動再構築されるようにした

### 5.16 v1.5.0 リリースメモ（2026-05-07）

- Codex / Claude セッションに対して、この拡張機能内だけのカスタムタイトルを設定 / 消去できるようにした
- カスタムタイトルは History / Pinned / チャット Webview のタイトルへ反映し、詳細ツールチップではオリジナルタイトルも確認できるようにした
- ツリー項目ツールチップの表示量を `full` / `compact` / `titleOnly` から選べるようにした
- 検索インデックスに保存するツール情報の範囲を `conversationOnly` / `toolCalls` / `toolCallsAndOutputs` から選べるようにした
- `Rebuild Search Index` コマンドを追加し、検索インデックス設定変更時に再作成へ誘導するようにした
- Status に拡張機能バージョンを表示するようにした

### 5.17 v1.4.3 リリースメモ（2026-04-30）

- `SECURITY.md` を追加し、`markdown-it` の GHSA-38c4-r59v-3vqw / CVE-2026-2327 について、v1.2.2 以降は `markdown-it@14.1.1` を同梱していることを明記した
- v1.2.1 以前の古い VSIX をインストールまたは再配布しないよう、セキュリティポリシーに明記した
- History の初回ロード中に、履歴 0 件の案内が先に表示されないよう、読み込み中ノードを表示するようにした
- Pinned の初回ロード中に、欠損ピンが先に表示されないよう、読み込み中ノードを表示するようにした
- 起動時の履歴キャッシュ / 検索インデックス処理前に、拡張機能の global storage ディレクトリを作成するようにした

## 6. 手動テスト観点

- `codexHistoryViewer.codex.archivedSessions.enabled = false` のとき、通常の Codex / Claude 履歴表示が従来通り動く
- 有効な `cache.v9.json` がある通常起動では、History / Pinned / Status が cache から先に表示され、その後 background refresh 完了時に最新状態へ更新される
- cache context が設定と一致しない場合や `Rebuild Cache` では、cache 即時表示を使わず従来通り最新 refresh を待つ
- `codexHistoryViewer.codex.archivedSessions.enabled = false` のとき、Status に Codex archived sessions root が表示されない
- `codexHistoryViewer.sources.enabled` に `codex` がない場合、`codexHistoryViewer.codex.archivedSessions.enabled = true` でも Codex archived sessions が読み込まれない
- `codexHistoryViewer.sources.enabled` に `codex` がない場合、Status に Codex archived session count / root が表示されない
- Codex source と archived sessions が有効な状態で archived root が存在しない場合もエラーにならない
- Codex source と archived sessions が有効、かつアーカイブ表示が `通常のみ` のとき、History / Pinned / Search に archived Codex session が出ない
- アーカイブ表示を `すべて` または `アーカイブのみ` にすると、History / Pinned / Search に archived Codex session が出る
- アーカイブ表示を切り替えると、History / Pinned は再スキャンなしで即時に更新される
- Search 結果がある状態でアーカイブ表示を切り替えると、最後の検索条件で再検索される
- アーカイブ非表示時の Search は、表示される通常履歴 hit 数が `search.maxResults` に達する
- archived Codex session の Markdown に `Location: Archived` が表示され、Chat では `Archived` 表示で通常履歴と区別できる
- active Codex session の Markdown に `Location: Active` が表示される
- archived Codex session の Chat では `Resume in Codex` の位置に `Move to Codex History` が表示される
- active Codex session の Chat / 履歴 Webview には `Move to Archive` ボタンが表示されない
- active Codex session の右クリックメニューには `Move to Archive` だけが表示され、`Move to Codex History` は表示されない
- archived Codex session の右クリックメニューには `Move to Codex History` だけが表示され、`Move to Archive` は表示されない
- `Move to Archive` / `Move to Codex History` はカスタムタイトル系 action の下に区切って表示され、Delete はさらに下に区切って表示される
- archived Codex session では `Resume in Codex` と `Promote to Today (Copy)` が表示されない
- `Move to Archive` は公式 Codex provider の `thread/archive` を使い、filesystem fallback しない
- `Move to Codex History` は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem Move に fallback する
- `Move to Codex History` の filesystem fallback では、作成日の `<YYYY>/<MM>/<DD>` へ移動される
- `Move to Codex History` 失敗時は、ユーザー向けの失敗メッセージが表示され、履歴表示が更新される
- filesystem fallback で戻した session は Undo で archived path へ戻せる
- 公式 provider で戻した session には filesystem Undo が出ない
- 公式側でアーカイブされた pinned session は、refresh 後に archived path へ追従する
- archived sessions が無効またはアーカイブ非表示のとき、archived 由来 pin が Pinned に `見つからない` として出ない
- archived sessions が無効またはアーカイブ非表示のとき、archived 由来 pin が Status の missing pin count に含まれない
- archive / unarchive / pin reconcile 後に、annotation / bookmark / chat open position が可能な範囲で新 path へ移行される
- active で付けたしおりは archive / unarchive 後も同じカードのしおりとして表示される
- archived 側で付けたしおりは `Move to Codex History` 後も同じカードのしおりとして表示される
- `chat.openPosition = lastMessage` の archived Chat で `Move to Codex History` を実行した場合、復元後の Chat は操作直前に見ていた本文メッセージ付近へ移動する
- Export した active / archived Codex Markdown transcript に `Location: Active` / `Location: Archived` が表示される
- Codex source と archived sessions が有効な場合、Auto Refresh 有効時に archived root の `rollout-*.jsonl` 変更で履歴が更新される
- `fileChangeHistory.explorerContextMenu.enabled = false` のとき、Explorer のファイル右クリックに `Show File AI Change History` が表示されない
- History / Pinned のセッション右クリックで `Custom Title...` が表示され、QuickPick から設定 / 消去を選べる
- カスタムタイトル未設定のセッションでは QuickPick に消去アクションが出ない
- チャット履歴ビューアのピン留めボタン右にある pencil アイコンから、同じ QuickPick でカスタムタイトルを設定 / 消去できる
- チャット履歴ビューアからカスタムタイトルを設定 / 消去した後、タブタイトルと History / Pinned / Search の表示が更新される
- History / Pinned のプロジェクトノード右クリックで `Project Alias...` が表示され、QuickPick から設定 / 消去を選べる
- CWD なしプロジェクトには `Project Alias...` が表示されない
- プロジェクト別名は History / Pinned / Search / Status の表示に反映されるが、検索 hit 対象にはならない
- プロジェクト別名の設定 / 消去を `Undo Last Action` で戻せる
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
- ファイル履歴 Webview の検索は読み込み済み diff card を対象にし、正規表現、完全一致、検索履歴候補を扱える
- 検索中に `続きを読み込む` を実行した場合、追加された card も検索対象に含まれる
- `続きを読み込む` の成功 / 失敗 / キャンセル後に scroll 位置が維持される
- 全候補解析後は `続きを読み込む` が消え、`これ以上の履歴はありません` が表示される。この表示は Webview 内検索の対象に含めない
- `履歴で開く` を押すと、通常履歴 Webview が現在のエディタグループに別タブとして開き、該当 diff card へスクロールする
- ファイル履歴で Codex / Claude source toggle を切り替えた状態でも、前 / 次 card ナビゲーションが表示中 card だけを対象にする
- `履歴で開く` で通常履歴 Webview を開いても full detail mode が強制されず、対象 diff entry の詳細だけが必要時に読み込まれる
- ファイル履歴 Webview を見ながら通常履歴 Webview を別タブで確認でき、既存のファイル履歴 Webview が置き換わらない
- `対象ファイルを開く` で VS Code の通常エディタに対象ファイルが開く
- source icon は Light / Dark / High Contrast で視認できる
- `ui.timeGuide.enabled = false` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示されない
- `ui.timeGuide.enabled = true` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示される
- date guide は表示範囲に応じて、通常履歴では時刻 / 日付+時刻 / 日 / 月、ファイル履歴では day / month / year に自動スケールする
- 通常履歴 Webview の date guide で、添付あり message に控えめな ring indicator が表示される
- date guide の添付 indicator は通常添付、画像のみ、mixed を区別できる
- date guide の tooltip に `user #N (PDF, テキスト)` のような attachment summary が表示される
- date guide の attachment summary で、画像 5 件のみの message は `画像添付 ×5` のように総添付数が分かり、4 種類以上の mixed attachment は hidden unique kind 数の `+N` と総添付数 suffix が別々に読める
- date guide の添付 indicator が user / しおり / 現在位置と重なっても視認性が崩れない
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
- `History` の日付 / プロジェクト / ソース / アーカイブ表示 / タグ絞り込みが期待どおり動く
- `History` の表示モードを `日付別` / `セッション一覧` で切り替えられ、選択中セッションが可能な範囲で新しいツリー上へ追従する
- `History` の More Actions から、開始日時 / 最終メッセージ日時 / 名前の昇順 / 降順を切り替えられ、現在値には `（現在）` が表示される
- Date Basis と日付系 sort 軸が異なる場合、History / Pinned の session row は sort 軸の日時を表示し、tooltip は Date Basis 側の日時を補足する。`titleOnly` は Date Basis 側のみ、`compact` / `full` は両方の日時を表示する
- `History` の More Actions では、ソースが 1 種類だけ有効な場合に source 選択が表示されず、ソースが `Claude Code` の場合に archive 表示 group が表示されない
- `History` のプロジェクト表示を `一覧表示` / `プロジェクト別表示` で切り替えられ、対象範囲を `すべて` / `現在のプロジェクトグループ` で切り替えられる
- `History` の `プロジェクト別表示` で、`セッション一覧` と `日付別` の階層がそれぞれ期待どおりになる
- `History` の絞り込み解除は、非絞り込み時に disabled 表示になり、日付 / プロジェクト CWD / ソース / アーカイブ表示 / タグを解除して、プロジェクト表示と対象範囲は解除しない
- `Pinned` のプロジェクト表示を `一覧表示` / `プロジェクト別表示` で切り替えられ、対象範囲を `すべて` / `現在のプロジェクトグループ` で切り替えられる。History のプロジェクト表示には影響しない
- `Pinned` の日付 / プロジェクト / ソース / アーカイブ表示 / タグ絞り込みが期待どおり動き、History / Search 側の絞り込みに影響しない
- `Pinned` のソース切替を `all` / `codex` / `claude` で切り替えられ、History 側のソース切替に影響しない
- `Pinned` のソースが `claude` のとき、Pinned のアーカイブ表示切替が disabled になり、Command Palette から実行しても状態が変わらない
- `Pinned` の More Actions から、ピン留め順 / 開始日時 / 最終メッセージ日時 / 名前の昇順 / 降順を切り替えられ、現在値には `（現在）` が表示される
- `Pinned` の toolbar には表示順切替 icon が表示されず、表示順の変更は More Actions に集約される
- `Pinned` のプロジェクト tooltip は、表示順に応じた代表日時を `ピン留め日時` / `セッション日時` として表示する
- `Pinned` の絞り込み解除は日付 / プロジェクト / ソース / アーカイブ表示 / タグを解除し、プロジェクト表示、対象範囲、表示順は維持する
- `History` の再読み込み、`Pinned` の再読み込み、`Search` の `Rerun Search` が、それぞれセッションのエクスポートのすぐ左に表示される
- History / Pinned の右クリックから QuickPick 経由でカスタムタイトルを設定 / 消去でき、History / Pinned / チャット Webview タイトルへ反映される
- カスタムタイトルがあるセッションの詳細ツールチップにオリジナルタイトルが表示される
- 121 文字以上のカスタムタイトル入力ではエラーになり、保存されない
- History / Pinned のプロジェクトノード右クリックからプロジェクト別名を設定 / 消去でき、Project 見出し、session description、tooltip、filter 表示、Status、Search scope / session 表示へ反映される
- プロジェクト別名は検索 hit 対象には含まれず、既存検索結果 root の scope label は alias 変更だけでは書き換わらない
- CWD なしプロジェクトノードにはプロジェクト別名メニューが表示されず、direct / UI command でも active project 推定を行わない
- 121 文字以上のプロジェクト別名入力ではエラーになり、保存されない
- プロジェクト別名の設定 / 消去を `Undo Last Action` で戻せる
- History / Pinned のプロジェクトノード右クリックからプロジェクト関連付けを設定 / 解除でき、関連プロジェクトとしてまとめて表示される
- プロジェクト関連付けの設定 / 解除を `Undo Last Action` で戻せる
- 全体検索は History の表示対象範囲、タグ、Codex / Claude などの種類、アーカイブ対象、日付に沿って検索される
- 検索履歴候補と保存済み検索には検索語だけが表示され、検索対象ロールや大文字小文字の扱いは現在設定を使う。項目選択は検索実行、ゴミ箱ボタンは個別削除として動く
- Webview 内検索の候補 dropdown は、非空入力で一致する候補が無くなった場合に閉じ、「検索履歴はありません」を検索結果へ重ねない
- Search が空の状態で History 側の絞り込みを変更しても Search 結果が復活せず、既存の Search 結果がある場合だけ実効値変更時に再検索される
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
- `Search` の view title action に `Search...`、`Clear Results`、保存済み検索実行、現在検索保存、`Rerun Search`、エクスポート、Undo が表示され、`Rerun Search` はエクスポートのすぐ左に配置される。タグ / ソース / アーカイブ表示 / 日付 / プロジェクトの絞り込み操作や保存済み検索削除は表示されない
- `Search` が History 側の絞り込み条件を検索対象範囲として使い、Pinned 側の独立した絞り込み条件には追従しない。Search が空のときは History 側の絞り込み変更だけで結果を生成しない
- `settings.json` で `preview.maxMessages` / `search.maxResults` に範囲外の値を入れても、設定読み取り時に許容範囲へ丸められる
- `Search` のロール設定、保存済み検索、再検索が動き、保存済み検索は選択で実行、ゴミ箱ボタンで個別削除できる
- `search.indexToolContent` を `conversationOnly` / `toolCalls` / `toolCallsAndOutputs` で切り替えると、検索インデックスに入るツール情報の範囲が変わる
- `toolCalls` / `toolCallsAndOutputs` で Codex の `custom_tool_call` の tool 名、command、対象ファイルパスが検索にヒットする
- `conversationOnly` では Codex の `custom_tool_call` の tool 名、command、対象ファイルパスが検索にヒットしない
- Codex の `custom_tool_call` に patch / diff 本文が含まれる場合、対象ファイルパスは検索にヒットし、diff 本文の具体行は検索にヒットしない
- `toolCallsAndOutputs` でも Codex の `custom_tool_call_output` の stdout / stderr 全文や diff 本文は検索インデックスへ入らない
- `search.indexToolContent` 変更時に検索インデックス再作成の通知が出て、`Rebuild Search Index` で検索インデックスだけ再作成できる
- `Rebuild Cache` 実行前に確認が出て、履歴キャッシュと検索インデックスが再作成される
- 破損した `cache.v9.json` がある状態で起動 / refresh すると、parse error として削除され、履歴キャッシュが再生成される
- 破損した `search-index.v2.json` がある状態で検索すると、parse error として削除され、検索インデックスが再構築される
- `Delete` 実行後に `undo-delete` / `deleted` の扱いと `Undo Last Action` が整合する
- `Delete` 後に該当チャットパネルが閉じ、存在しないセッションを開こうとしてもゴーストパネルが残らない
- Undo 付き通知のボタンと Undo 完了メッセージが `ui.language` に応じて表示される
- `Empty Trash` 実行後に Status のゴミ箱件数が 0 になり、旧世代キャッシュも削除される
- `Empty Trash` 実行後も現行の `cache.v9.json` / `search-index.v2.json` は削除されず、旧世代の `cache.v*.json` / `search-index.v*.json` と 1 時間以上古い `*.tmp-*.json` だけが削除される
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
- Claude の PDF document が document card として表示され、本文に混ざらない
- Claude の text document が text document card として表示され、preview action icon から card 内 full-width preview を開閉できる
- Claude の `<ide_opened_file>` / `<ide_selection>` が raw tag ではなく file reference / selection reference card として表示される
- Claude 公式形式の `ide_opened_file` で拡張子なしファイルが file reference card として表示され、Open できる
- Codex の `# Files mentioned by the user:` block が本文に残らず、PDF / txt / xlsx / docx などが file reference card として表示される
- Codex の `# Files mentioned by the user:` block が IDE context 後ろにある場合も、HTML / log / JSON などが file reference card として表示される
- Codex の `## My request for Codex:` ヘッダー自体は本文に残らず、依頼本文が表示される
- document / file reference card では path / MIME type / byte size が本文上に常時表示されず、tooltip で確認できる
- Codex `Files mentioned` の `.js` / `.ts` など code 系ファイル参照と `.png` / `.jpg` など image 系ファイル参照で、badge text が generic `File` ではなく `Code` / `Image` として表示される
- 本文が空で添付だけの user message が、詳細 OFF でも表示される
- 画像のみ / document のみ / file reference のみ / mixed attachments の message で表示順とレイアウトが崩れない
- synthetic mixed content で `document -> image -> file reference` の順に現れる場合、抽出結果と Webview 表示が同じ順序になる
- `<image></image>` だけが残るセッションで、プレースホルダー文字列が本文に残らず、表示不能状態の画像カードが出る
- `images.enabled = false` のとき、画像は読み込まれず表示不能状態になる
- `images.enabled = false` または Search / Markdown / Resume / Handoff 用抽出でも、画像 payload を読み込まずに MIME type / 推定 label metadata が残る
- `images.maxSizeMB` を超える画像は読み込まれず、サイズ超過として表示される
- `localimage` / `imageassetpointer` を含む synthetic content で、main path と patch detail path の messageIndex がズレない
- MIME type 欠落の Claude base64 document が、document と image の二重 attachment として抽出されない
- `images.thumbnailSize` を `small` / `medium` / `large` で切り替えると本文内サムネイルサイズが変わる
- 画像サムネイルをクリックするとプレビューモーダルが開く
- 画像が 1 枚だけのときも、プレビューモーダル上部にサムネイルが表示される
- 複数画像のプレビューで、サムネイルクリック、前後ボタン、左右キーによる切り替えができる
- 複数画像のプレビューで、先頭 / 末尾を超えて移動しても反対側へループしない
- 画像が多いとき、プレビューモーダル上部のサムネイル列を横スクロールできる
- プレビューモーダルで fit / 原寸表示を切り替えられる
- プレビューモーダルで表示中の画像を保存できる
- embedded document の Save As が Webview から実行できる
- stale / missing `fsPath` の `saveImage` / `saveAttachment` request で、別セッションの payload が保存されない
- file reference の Open が VS Code API 経由で実行され、shell command を使わない
- 検索で添付ファイル名 / path / MIME type / file kind に hit する
- PDF / Office / binary / base64 document の本文や、Codex file reference の参照先ファイル本文が検索に入らない
- Markdown transcript に attachment summary が出て、raw IDE tag や `Files mentioned` block が出ない
- Resume / Handoff の context に raw tag / `Files mentioned` block が重複せず、バイナリ添付が再添付されない
- プレビューモーダルを開いたまま別セッションを開くと、モーダルが閉じる
- `patch_apply_end` を含むセッションで差分カードが表示される（`Show details` OFF でも出る）
- 差分カードの折りたたみ展開、hunk ごとの折り返し切り替え、行ジャンプが動く
- diff カードの上下ナビゲーションで前後の diff へ移動できる
- 各カードの最大幅展開ボタンで対象カードだけが広がり、再クリックで通常幅に戻る
- 差分ハイライトが VS Code テーマに追従する
- 検索サイドバーがツールバー右端ボタンおよび `Ctrl+F` / `Cmd+F` で開閉する
- 検索サイドバーの幅をドラッグで変更でき、再表示後も保持される
- Webview 内検索の文字入力では連続入力中に検索が連発せず、短い待ち時間の後に最新 query で検索される
- Webview 内検索で query を空にすると、待ち時間なしで highlight と検索結果 status が消える
- Webview 内検索で Enter / 前へ / 次へを押すと、待ち時間なしで現在 query の結果へ移動できる
- ファイル履歴 Webview の Webview 内検索で debounce pending 中に Enter / 前へ / 次へを押しても、検索 refresh が二重実行されない
- Webview 内検索の幅をドラッグで狭めた状態でウィンドウ幅を 860px 以下に縮めても、検索パネルが現在幅より広がらず、リサイズハンドルで幅を変更できる
- 極端に狭い viewport でも検索パネルが画面外にはみ出さず、検索 input / close button を操作できる
- 未入力・一致なし時ともにカウントが `0/0` と表示される
- チャットヘッダーの先頭・末尾ボタンで、実際に表示されている最初 / 最後のカードへスクロールできる
- 自動更新 `follow` で最後が diff カードのとき、直前の非 diff カードへ追従し、チャット末尾ボタンでは最後の diff カードへ移動できる
- 自動更新 `follow` が pending のカードアンカー復元や reload 後のレイアウト更新に上書きされず、追従後の位置が最後に見ていた位置として保存される
- `Show details` OFF のとき、描画されていない詳細カードへ先頭 / 末尾スクロールしない
- assistant message 内の `::code-comment{...}` が raw directive ではなくレビューコメントカードとして表示される
- 複数の `::code-comment{...}` が出現順に複数カードとして表示される
- comma 区切り、複数行、未知 segment を含む `::code-comment{...}` でも、既知キーから `file` / `title` / `body` を復元できれば通常カードとして表示される
- `::code-comment{...}` の string value 内の comma や `file=` 風文字列が属性 separator / key と誤認されない
- `start=3.14` は `start=3` として扱われ、`start=-5` は未解析カードへ fallback する
- directive の前後に通常 Markdown がある場合、表示順と Markdown 描画が維持される
- 範囲を特定できる壊れた `::code-comment{...}` は未解析カードへ fallback し、closing brace 欠落など範囲を特定できない場合だけ raw text fallback になる
- code comment card の本文に HTML 風文字列が含まれても、HTML として実行されずテキスト表示になる
- code comment card の表示ラベルが日本語 / 英語 UI でローカライズされる
- ヘッダー幅が狭くなるとラベルボタンが自動的にアイコンのみに切り替わる
- `webview.restoreAfterReload = false` のとき、`Developer: Reload Window` 後に通常履歴 Webview とファイル履歴 Webview が自動復元されない
- `webview.restoreAfterReload = true` のとき、`Show details` を切り替えた直後に `Developer: Reload Window` を実行しても、切り替え後の詳細表示状態で復元される
- `webview.restoreAfterReload = true` のとき、Reload 後にスクロール位置と選択メッセージが復元される
- `webview.restoreAfterReload = true` のとき、通常履歴 Webview は Reload Window / VS Code 再起動後に最後に見ていた message 付近へ戻る
- `webview.restoreAfterReload = true` のとき、ファイル履歴 Webview は Reload Window / VS Code 再起動後に最後に見ていた card 付近へ戻る
- ファイル履歴 Webview 復元直後に再度 Reload Window / VS Code 再起動しても、復元前の DOM 位置で `scrollAnchor` が上書きされず、最後に見ていた card 付近へ戻る
- `webview.restoreAfterReload = true` のとき、Reload 後に開いているカード、diff 展開、diff 折り返し、検索サイドバー状態が維持される
- `webview.restoreAfterReload = true` のとき、通常履歴 Webview とファイル履歴 Webview を同時に開いた状態で `Developer: Reload Window` を実行しても、両方が個別に復元される
- `webview.restoreAfterReload = true` のとき、VS Code を完全再起動しても、通常履歴 Webview とファイル履歴 Webview が保存済み state から再読み込みされる
- Webview 復元設定の説明から、実験的な設定であることと、復元遅延によって同じ履歴を再度開いたときにタブが重複する場合があることが分かる
- diff カードを最大幅にした状態が、再読み込み後も同じ diff グループで維持される
- ローカルファイルリンク（相対パス・行番号指定）が VS Code 内で正しく開く
- `package.nls.*` と `l10n/bundle.l10n.*` のキー所有が混ざっていない
- `SECURITY.md` に v1.4.3 / 2026-04-30 のセキュリティ方針と `markdown-it` アドバイザリ対応が記載されている
- ソースコードコメントに日本語が残っていない
