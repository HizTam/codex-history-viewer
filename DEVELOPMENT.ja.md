# Codex History Viewer 開発ドキュメント（日本語）

- 最終更新: 2026-07-21
- 対象バージョン: 2.8.0

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
  - `analysis/`: History Insights / Claude Branch Navigation 共通のセッション解析基盤
  - `insights/`: History Insights の snapshot、集計、Webview 管理
  - `branchMap/`: Branch Navigation（Codex / Claude）の関係解析、表示モデル、遷移解決
- `dist/`: ビルド成果物
- `media/`: セッションビュー / File AI Change History / History Insights Webview 用の CSS / JS
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
  - 絞り込み: 日付スコープ / プロジェクト選択 (`ProjectSelection`: `all` / `groups` / `none`) / ソース / アーカイブ表示 / タグ
  - プロジェクト表示: `一覧表示` / `プロジェクト別表示`
  - プロジェクト対象範囲: `すべて` / `現在のプロジェクトグループ`。実効対象は`ProjectSelection`を正本とし、後者は現在workspaceの1groupを選んだことを表す保存UI状態として扱う
  - プロジェクト (`cwd`) に別名が設定されている場合は、プロジェクト見出し、セッション行の CWD 表示、tooltip、絞り込み表示で別名を優先する
  - `プロジェクト別表示` では、`セッション一覧` は `Project -> Session`、`日付別` は `Project -> Year -> Month -> Day -> Session` として表示する
  - ヘッダー操作: プロジェクト表示、絞り込み、絞り込み解除、表示モード切替、並び替え、タグ絞り込み、タグ絞り込み解除、アーカイブ表示切替、ソース切替、履歴インサイト、再読み込み、エクスポート、Undo など
  - `絞り込み解除`は日付 / 明示的なプロジェクト選択 / ソース / アーカイブ表示 / タグを解除し、プロジェクト表示と対象範囲は表示状態として維持する。対象範囲が`現在のプロジェクトグループ`なら、その裏付けとなる1groupの`ProjectSelection`も維持する
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

### 3.1.1 History Insights

- History ビューのタイトルメニューまたは Command Palette の `履歴インサイトを表示` から、現在の History 条件に一致するセッションを集計する editor Webview を開く
- 起動時の対象セッション集合は snapshot として固定する。History 側の条件変更や新規セッションを自動追従せず、`再集計` は同じ対象集合の更新分だけを解析し、`履歴の条件を適用` は現在の History 条件から snapshot を作り直す
- 対象条件はソース、両端包含の From / To、Codex の保存場所、関連付け後の複数プロジェクト、タグを扱う
- Webview 内のフィルターは未適用 draft として保持し、`適用` するまで snapshot を変更しない。既定では History / Search の条件を変更せず、`履歴にも適用` を選択してから `適用` した場合だけ同じ検証済み条件を History へ原子的に反映する
- フィルター適用では、新しい snapshot の保存、必要な History 条件の保存、panel state の公開をこの順で行う。保存前に表示状態を切り替えず、History 条件の保存に失敗した場合は snapshot を以前の値へ補償ロールバックする
- `open`、`refreshCurrent`、フィルター適用は開始順に直列化する。先行処理が公開した snapshot を後着loadで上書きせず、後発の検証済みフィルター適用を黙って破棄しない。保存失敗時は直前のpanel stateと解析lifecycleを復旧する
- serializer から復元した panel は、初回 full History refresh が完了するまで待ち、現在設定と同じ同期区間で full scan された session inventory を確認できた場合だけ保存 snapshot を再解決する。fresh cache または初期空 index だけで対象 0 件へ確定せず、refresh 失敗、待機中の cancel / panel 破棄 / state 置換では保存 snapshot を変更しない。full scan 後の current index が正当に 0 件の場合だけ対象 0 件へ確定する
- authoritative History index の待機は serializer 復元時だけに適用する。通常 command からの open、`履歴の条件を適用`、フィルター適用で作成した snapshot は、開始時の current index を使い、cache 採用後の background refresh を無条件に待たない
- History 条件の保存後に History の再描画、選択位置復元、Search の再実行だけが失敗した場合は条件を巻き戻さず、適用済み条件から表示を再試行できる通知を出す
- 概要、活動ヒートマップ、ソース / モデル / プロジェクト内訳、ツール利用内訳、指標別のアクティブセッション、変更頻度が高いファイル、利用詳細、データ品質を表示する。概要には推論トークンと変更イベント数を含め、活動ヒートマップでは推論トークンを選択できる。プロンプト本文や応答本文は集計画面へ転載しない
- 折りたたみパネルの初期状態は活動ヒートマップだけを開き、それ以外を閉じる。利用者が変更した開閉状態は Webview state に保存し、同じタブ内の再描画、再集計、非表示からの復帰では維持する。タブを閉じて新規作成した場合は引き継がず、初期状態へ戻す
- ツール利用内訳は Chat model builder が生成した tool item を正規化済みツール名ごとに集計し、呼び出し回数と利用セッション数を切り替えて表示する。ツール名は前後空白を除去し、空値を `unknown`、長さを 256 文字、1セッションあたりの種類数を 2,000 件に制限する。上限超過や名前切り詰めがある解析結果は `partial` とし、集計表示は各指標の上位32件の和集合を最大128件まで保持する
- アクティブセッションはユーザー依頼数、ツール呼び出し数、推論トークン数、合計トークン数、変更行数を切り替えて表示し、各指標の上位20件の和集合だけをmodelへ含める。取得不能な値を0とみなさず、同値時は最終アクティビティ、タイトル、opaque IDで決定的に整列する。Webviewからセッションを開く操作はmodelに含まれるopaque IDをhost側のsnapshot内セッションへ再解決し、任意パスを受け付けない
- 利用詳細は、キャッシュ済み / キャッシュ読み取り / キャッシュ作成の入力トークンと推論トークン、ユーザー依頼 / アシスタント応答 / developer メッセージ / ツール呼び出し / ツール出力、全 / 完了 / 中断 / ロールバックのターン数、変更ファイル種別ごとの重複除外後のファイル数 / 変更イベント数を表示する。トークン、メッセージ、ターンの各指標は概要と同じ取得可否と下限表示を使い、変更ファイル種別は解析できたファイル変更の範囲を集計する
- トークン、変更行数などは確定値、取得できた下限、取得不能を区別し、不完全なログを 0 として扱わない。safe integerを超える合計は最大安全整数へ飽和させ、データ品質にoverflowを表示する
- 日付の drill-down は History、プロジェクトの drill-down は History / Search へ、snapshot の他条件を維持して適用する。欠損referenceが混在する場合は、現在のindexで同じprojectを解決できる行だけ操作を表示する。ファイル行からは既存 File AI Change History または対象ファイルを開く
- 集計は Session Analysis Index を必要時に差分更新する。同じcache contextの同時要求は共有jobへまとめ、consumerごとの進捗とキャンセルを維持する。2秒を超えたloadだけVS Codeのキャンセル可能な進捗通知を1件表示し、キャンセル、部分解析、stale 表示に対応する。失敗しても History / Search / Pinned / セッションビューの通常機能へ波及させない

### 3.2 セッション操作

- `Open Session in New Tab`: Webview のセッションビューとして別タブに表示
- `Custom Title...`: QuickPick からカスタムタイトルの設定 / 消去を選択する
- `Project Alias...`: History / Pinned のプロジェクトノード右クリックから、プロジェクト別名の設定 / 消去を選択する
- `Project Association...`: History / Pinned のプロジェクトノード右クリックから、別プロジェクトへの関連付け、関連付けモード変更、解除を選択する
- `Open Session as Markdown`: 仮想ドキュメントとして Markdown 化して表示
- `Copy Quick Prompt`: セッションビュー内で、タスクと直近メッセージだけの軽量な再開用プロンプトをクリップボードへコピー
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
- History / Search の Codex 用 `archiveLocationFilter` は workspace ごとに保持し、既定は `通常のみ` とする。Claude のみを選択している間の実効条件は `すべて` に固定するが、この値で Codex 用の保存値を上書きせず、Codex または All へ戻したときと再起動後に直前の Codex 条件を復元する
- Pinned は `pinnedArchiveLocationFilter` を別に保持し、History と Pinned の view title action からそれぞれ独立して `通常のみ` / `すべて` / `アーカイブのみ` を切り替えられる。Search は History 側のアーカイブ表示を検索対象範囲として参照する
- History のソース絞り込みが `claude` の場合、History のアーカイブ表示切替は toolbar では disabled 表示にし、More Actions ではアーカイブ表示 group を非表示にする
- Pinned のソース絞り込みが `claude` の場合、Pinned のアーカイブ表示切替は disabled 表示かつ実行しても状態を変更しない
- archived 由来の session は `storage.archiveState = "archived"`、`rootKind = "codexArchivedSessions"` として扱う
- active と archived に同じ session identity がある場合は active を優先し、重複表示を避ける
- archived Codex session の Markdown には `Location: Archived` を表示し、セッションビューでは `Archived` 表示で通常履歴と区別する
- archived Codex session のセッションビューでは `Resume in Codex` の位置に `Move to Codex History` を表示する
- active Codex session のセッションビュー / 履歴 Webview には `Move to Archive` ボタンを置かない
- 右クリックメニューでは、active Codex session は `Move to Archive` だけ、archived Codex session は `Move to Codex History` だけを表示する
- 移動系 action はカスタムタイトル系 action の下に区切って配置し、Delete はさらに下に区切って配置する
- archived Codex session では `Resume in Codex` と `Promote to Today (Copy)` を表示しない
- `Move to Archive` は公式 Codex provider の `thread/archive` を使い、filesystem fallback は行わない
- `Move to Codex History` は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem provider で `<sessionsRoot>/<YYYY>/<MM>/<DD>/` へ Move する
- filesystem provider fallback の Move は、同名衝突時に suffix を付け、copy+verify+delete fallback と Undo で安全性を確保する
- archive / unarchive / pin reconcile では、annotation / bookmark / chat open position などの path-keyed metadata を移動先へ寄せる
- `chat.openPosition = lastMessage` の archived Codex セッションビューから `Move to Codex History` を実行した場合は、操作直前に見ていた本文メッセージへ復元後に移動する
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
  - 内部 file version: 10
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
    - `conversationOnly`: メッセージ本文とタイトル / 注釈だけを保存する
    - `toolCalls`: メッセージ本文に加えてツール名 / 引数を保存する
    - `toolCallsAndOutputs`: メッセージ本文、ツール名 / 引数、ツール出力を保存する（互換性維持の既定値）
  - Codex の `custom_tool_call` は `toolCalls` / `toolCallsAndOutputs` のとき、tool 名、action、command、files、paths などの軽量メタだけを保存する
  - `custom_tool_call` の patch / diff 本文、巨大 JSON、base64 / data URI、secret / token / password 系キーの値は保存しない
  - Codex の `custom_tool_call_output` は `toolCallsAndOutputs` のときだけ、取得できる場合に status / exitCode / durationMs / success / error などの短い実行メタだけを保存する
  - ファイル履歴向けの `fileChangeHints` は関連セッションの優先付け補助として使う。最終的な diff 抽出結果の正しさは元のセッション JSONL の再解析で担保する
  - セッションの attachment metadata は label、path、MIME type、file kind を検索対象に含める
  - Claude text document の text は上限内だけ検索対象にし、PDF / Office / binary / base64 document の本文は検索対象にしない
  - Codex file reference は履歴に保存された label / path だけを検索対象にし、参照先ファイルは読み込まない
  - 保存形式: 整形なし JSON（サイズ削減のため）
- Session Analysis Index:
  - 保存先: `globalStorageUri/session-analysis-index.v1.json`
  - 用途: History Insights の統計と Claude Branch Navigation の構造化 occurrence を共用する差分解析キャッシュ。履歴キャッシュや検索インデックスの代替にはしない
  - History Insights、Claude Branch Navigation、または `Rebuild Cache` を要求したときだけ lazy load / lazy build し、拡張機能の起動や通常の History / Search 表示を待たせない
  - セッションごとの `cacheKey`、source、`mtime`、`size`、parser version と、sessions root / 有効ソースを含む cache context を検証し、変更された entry だけを再解析する
  - 2.8.0最終状態のsource parser versionはCodex / Claudeともに`8`とする。cache hardening後の旧entry、Codex session-start protocol contextを通常user件数へ含めていた旧Codex entry、`used_percent`の小数を欠損扱いしていた旧Codex entry、Claudeの`<local-command-stdout>`を通常user件数へ含めていた旧Claude entry、ツール名別利用回数を保持しないversion 7 entryは再解析する
  - 既存 Chat model builder と同じ抽出結果を使って message index、turn、usage、file change、ツール名別呼び出し回数を集計し、解析側で独自の message index を採番しない
  - 同一セッションの重複解析を共有し、全体の更新、保存、clear は直列化する。進捗通知とキャンセルに対応する
  - 破損 JSON は削除して次回要求時に再生成し、権限エラーなどの read error では既存ファイルを削除しない
  - 通常の lazy 解析は cache 保存失敗時も process-local の解析結果を利用できる best-effort とし、History Insights / Claude Branch Navigation の可用性を維持する
  - `Rebuild Cache` からの手動再作成は `rebuildAll()` の strict 経路を使う。既存 index の削除では FileNotFound だけを無視し、権限 / lock / I/O error と新 index の保存失敗は呼び出し元へ伝播する。保存失敗時は新しい process-local cache を公開しない
  - 256 MiB を超えるセッションは `unsupported`、壊れた JSONL 行や解析上限超過は `partial` として保持し、取得不能と確定値を区別する
  - Claude の構造化 graph record は 1 セッション 100,000 件を上限とし、上限へ到達した後に追加 record があった場合だけ `partial` とする
- JSON 永続化:
  - JSON 読み込み失敗は `missing` / `parseError` / `readError` に分け、parse error だけを再生成可能な破損ファイルとして削除する
  - 権限エラーや provider unavailable などの read error では既存ファイルを削除しない
  - JSON 書き込みは同一ディレクトリの一時ファイルへ書いた後に rename する。rename に失敗した場合は commit guard を再確認してから従来互換の直接書き込みへフォールバックし、その成否にかかわらず一時ファイルを best-effort で削除する
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
  - 確認ダイアログの承認直後に設定と日時条件を固定し、その条件で履歴キャッシュ、検索インデックス、Session Analysis Index を順番に強制再作成する。途中の History refresh、Auto Refresh、filter / scope、関連設定、index generation の変更は中断条件にせず、進捗通知からの明示キャンセルだけを中断条件にする
  - 履歴の強制再作成直後に固定した同一の readonly session inventory を検索と分析へ渡す。開始設定が途中で current ではなくなった場合も detached snapshot として後続段階を完走し、新しい設定の live History Index は上書きしない
  - 検索インデックスは専用 working state と明示キャンセルだけを確認する commit guard を使い、保存成功後にだけ disk / process-local index を一括更新する。保存前のキャンセルや保存失敗では直前の index を維持し、保存成功後のキャンセルでは完成済み検索インデックスを維持したまま後続段階へ進まない
  - 進捗表示とキャンセルに対応する。Session Analysis Index を削除する前にキャンセルされた場合は既存の解析結果を維持し、削除後にキャンセルされた場合は不完全な現行 index を保存せず次回要求時に lazy 再構築できる状態にする
  - Session Analysis Index の削除または保存に失敗した場合は再作成全体を失敗として通知し、成功通知を出さない
  - 履歴 snapshot が current として採用されている場合だけ live History UI を更新し、既存検索結果の clear を要求する。検索実行中に発生した clear 要求は旧表示結果だけを対象とし、実行中検索が新しい結果を公開した場合はその結果を消さない。再作成全体が成功し、同じ snapshot が引き続き current の場合だけ、開いている History Insights と Branch Navigation を更新する
- `Rebuild Search Index`:
  - 検索インデックスだけを強制再作成する
  - 開始時に互換性のある current History snapshot がなければ、その時点で捕捉した History refresh queue を一度だけ待つ。待機後も開始設定と互換な snapshot を取得できなければ失敗とし、後発の queue や別設定の snapshot へ切り替えない
  - snapshot を取得した後は readonly session inventory と設定を処理終了まで固定する。待機中または再作成中の History refresh、Auto Refresh、filter / scope、関連設定、index generation の変更では取り直しや中断を行わず、進捗通知からの明示キャンセルだけを中断条件にする。対象 session が 0 件でも空 index を保存する
  - `Rebuild Cache` と単独の `Rebuild Search Index` は共通 maintenance queue で投入順に直列化し、全キャッシュ再作成の段階間を単独再作成が追い越さない
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
  - あわせて旧世代の `cache.v*.json` / `search-index.v*.json` / `session-analysis-index.v*.json` と、1 時間以上古い `*.tmp-*.json` も削除する。ただし現在の `cache.v9.json` / `search-index.v2.json` / `session-analysis-index.v1.json` は削除しない
  - ダイアログでは古い一時ファイルの件数を個別表示せず、ストレージ整理として扱う。Status 表示上の件数は「ゴミ箱件数」のみを扱う
- 自動削除:
  - 履歴キャッシュ、検索インデックス、Session Analysis Index、ゴミ箱は自動で全削除せず、`Empty Trash`、`Rebuild Cache`、`Rebuild Search Index` などの明示的なユーザー操作に委ねる
  - Handoff 生成ファイルは作成時に古い世代だけを整理し、全削除はユーザー操作 (`Delete Handoff Files`) に委ねる

### 3.5 自動更新

- 履歴の自動更新設定は既定では無効 (`codexHistoryViewer.autoRefresh.enabled = false`)
- 有効時は Codex / Claude の履歴 `.jsonl` を監視する
- Codex source と Codex archived sessions が有効な場合は archived root も監視対象に含める
- 変更イベントは `autoRefresh.debounceMs` でまとめ、`autoRefresh.minIntervalMs` より短い間隔では refresh しない
- 実際の refresh 実行条件:
  - History view が表示中、または自動更新オンのセッションタブが開いている
  - VS Code ウィンドウがフォーカス中
- 自動更新オンのセッションタブは、エディタ上で裏タブになっていても更新対象にする
- VS Code ウィンドウ非フォーカス中、または更新対象 consumer がない間の変更は pending として保持する
- フォーカス復帰時、または更新対象 consumer が現れた時に pending があれば更新予約する
- セッションビューのヘッダーにある自動更新ボタンは、履歴の自動更新設定が有効なときだけ表示する
- セッションタブの自動更新モードは `off` / `preserve` / `follow` を持つ
- 新規セッションタブ、または再利用タブで別セッションへ切り替わったタブは `off` から開始する
- 同じセッションの既存タブを再表示する場合は、そのタブの自動更新モードを維持する
- `preserve` は現在の表示位置と UI 状態を維持して再読み込みする
- `follow` は UI 状態を維持し、`liveRunningTurnId` / `latestTurnId` がある場合はその turn 内の live running marker、completed end marker、最後の意味ある表示カードの順にスクロール対象を選ぶ。末尾が patch group の場合は、同じ turn 内の直前の非 patch group 表示カードを優先する
- 自動更新では Search 結果を消さない
- 自動更新では検索インデックス再構築を行わない

### 3.6 セッションタイムライン / 添付 / 画像

- セッションタイムラインでは Codex / Claude のメッセージ内に含まれる添付 / ファイル参照を `attachments` に統合して扱う
- `ChatMessageItem.images` は Chat model の出力としては使わず、画像も `attachments` の `type: "image"` として扱う
- セッションタイムラインでは Codex / Claude のメッセージ内に含まれる対応画像をサムネイル表示する
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
- `images.thumbnailSize` はセッションタイムライン内のサムネイルサイズだけを切り替える
- Claude Code の `type: "document"` は document card として表示する
  - PDF は PDF document card として表示し、初期 Webview model へ base64 payload を渡さない
  - text document は text document card として表示し、プレビュー表示には上限内の抜粋だけを使う
  - unknown document は generic document card として表示する
- Claude Code の `<ide_opened_file>` / `<ide_selection>` は本文から除去し、file reference / selection reference card として表示する
- Claude Code の `<task-notification>` は user message の通常本文ではなく task notification attachment として扱う。`summary` / `result` / `usage` はカード、検索、Markdown transcript、Resume / Handoff の用途別 policy に従って使い、`taskId` / `toolUseId` / `outputFile` / system preamble / 定型 `note` は通常表示や Webview model へ出さない
- Claude Code の assistant message に raw text として残る `<invoke name="...">` は tool invocation attachment として扱う。Markdown の fenced code / inline code / blockquote 内に引用された `<invoke>` は抽出せず、壊れた block や境界が曖昧な block は raw text として残す
- `<task-notification>` / `<invoke>` の共通 scanner は open / close 候補を tag 種別ごとに一度だけ列挙し、close 欠落や malformed open が大量にある履歴でも open ごとに EOF まで再走査しない
- Claude Code の `queue-operation` / `attachment.type = "queued_command"` に含まれる task notification / invoke 風 text は、メッセージとして materialize された user / assistant item ではないためカード化しない
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
- structured attachment の抽出は source offset で merge し、Claude IDE reference、task notification、invoke、image placeholder などを種類別に並べ替えない
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
- セッションビューのスクロール領域は固定ヘッダーの下に分離し、スクロールバーがヘッダー横から始まらないようにする
- セッションビューのヘッダーには、検索ボタンと再読み込みボタンの間に自動更新ボタンを置く
- セッションビューのヘッダーには、ピン留めボタンの右にカスタムタイトルの pencil アイコンを置き、QuickPick から設定 / 消去を選べるようにする
- セッションタイムラインでは、現在のユーザープロンプトを上部に追従表示できる
- assistant 応答に Codex のメモリー引用情報が含まれる場合は、本文末尾ではなく折りたたみ表示として扱う
- Codex の最初の通常会話より前にある text-only protocol bundle は、既知の完全 block だけで構成され、開始 marker を持つ場合に限って専用 `protocolContext` item へ変換する。通常 user message とは分離し、既定で閉じた `Codex 実行コンテキスト` カードとして通常表示・詳細表示の両方に出す
- protocol context 判定は可変の本文、件数、path、hash ではなく raw content の block 構造で行う。未知 content type、raw 添付、閉じ tag 欠落、余剰の自然文があれば通常 user message へ fail-open し、単独の environment / user instructions は従来どおり詳細表示用 context とする。strict 判定後に本文から file reference attachment が派生しても、raw 判定を覆さず context のまま扱う
- 専用 context card は raw message index を消費して後続番号を維持するが、user 件数、sticky user、user 前後移動、role filter、branch anchor、全体 Search、ページ内検索、Resume / Handoff の通常依頼には含めない。展開本文は `textContent` で描画し、同一セッション自動更新では開閉状態を維持する
- セッションタブの自動更新ボタンは、履歴の自動更新設定が有効なときだけ表示し、`off` / `preserve` / `follow` をクリックで循環する
- `preserve` / `follow` はボタンの背景色でオン状態を示し、`follow` はさらに別色で追従中であることを示す
- セッションタイムラインの先頭 / 末尾スクロールは、スクロールコンテナの絶対端ではなく、実際に描画されている最初 / 最後の visual target を対象にする。先頭ボタンは target を toolbar 直下へ貼り付けず小さな上端余白を残し、先頭 user card で sticky user header が不要に出ないようにする。末尾ボタンと `chat.openPosition=latest` は reveal 操作ではないため、ユーザーが折りたたんだ turn を勝手に展開しない
- 自動更新 `follow` は、`liveRunningTurnId` / `latestTurnId` がある場合はその turn 内の live running marker、completed end marker、最後の意味あるカードの順に追従する。末尾が patch group の場合は同じ turn 内の直前の非 patch group カードを優先し、該当 turn の描画カードがない場合は描画済み marker / visual target へフォールバックする。手動で折りたたまれた completed turn は勝手に展開せず、collapsed summary marker を追従対象にできる
- 末尾スクロールと `follow` の着地点では、最後の card / marker が Webview 下端に貼り付かないよう小さな下端余白を残す。通常 card / diff card は 10px、running / completed / collapsed marker は 12px 程度の余白を目安にする
- Codex turn は timeline 上で start marker、end marker、turn rail に分けて表示し、`live` mode では running anchored chip / running fallback chip を追加する。`basic` mode では live running 状態を表示せず、turn は JSONL 由来の永続 status のまま表示する
- turn の主表示は `ターン N` とし、message / card index の `#N` とは混同させない。`ターン N` は狭い viewport でも 2 行に割らず、full `turn_id` は tooltip / aria-label に出す
- start marker は turn 開始位置だけを示し、`完了` などの終了状態は end marker にだけ出す
- start marker には activity / status dot を出さず、静的な開始境界として表示する
- end marker は turn の最後の表示 item の直後に出し、item 数、tool 数、変更数、入力 / 出力 / 合計 token を表示する。token 合計がない場合だけ usage 記録件数へフォールバックする
- completed turn は start marker 側の toggle で手動折りたたみ / 展開できる。折りたたみ状態は Webview 内の同一セッション UI 状態として保持し、JSONL / globalState / 検索 index には保存しない
- 折りたたみ中の completed turn は、本文 row と通常 end marker を隠し、start marker を collapsed summary marker に切り替える。summary には `開始` / `終了`、開始時刻、終了時刻、所要時間、item / tool / patch / token summary を集約する。狭い viewport では `ターン N`、toggle、`開始` / `終了` badge を折り返さず、時刻、所要時間、件数、token summary などの補助情報を ellipsis または非表示にして表示崩れを避ける
- turn marker の toggle は本文側の固定幅 slot ではなく、turn rail 上または rail-control lane に置き、`ターン N` の開始位置を rail のすぐ右で揃える
- `live` mode の running anchored chip は同じ turn 内の最後の意味ある表示カードの直後に、turn rail 基準の独立 anchored row として左寄せ表示する。user card の後でも右寄せせず、patch group / ファイル変更 card の内部には入れない
- anchored chip が viewport 外に流れた場合だけ、左下 fixed の running fallback sticky を表示する。fallback sticky は Webview 内の running marker と同じ表示部品を固定表示し、中身の font size / pill / meta text は Webview 内 marker と同一にする。本文上でも読めるよう、外側には user sticky と同系統の座布団 surface / border / shadow を敷く。座布団は内側の running marker より縦方向に余白を持たせ、outer surface 側の最小高さと上下 padding で枠が text / pill に密着して細く見えないようにする。独自の大きな chip や別 typography にはしない。本文カードの下に潜らず、`ターン N` / `実行中` / `経過` / `最終活動` が潰れない幅を確保する。クリック / Enter / Space で running turn へ移動する
- running chip は user bubble 内や sticky user header 内には入れず、sticky user header の切り替え条件とは独立させる
- running chip は `実行中` を `開始` / `完了` と同系統の pill として表示し、`経過 N` と `最終活動 ...` は muted meta text として表示する。経過時間は `startedAtIso` から live 更新し、1時間以上でも秒を省略しない。最終活動時刻は `updatedAtIso` が変わるまで進めない。文字サイズ、pill、meta text、余白、teal-green 系の running 色は start / end marker と同系統にし、省略時は ellipsis と tooltip / title で全文を確認できる
- running chip には小さな dot / ring の activity cue を表示し、実行中であることだけを opacity / box-shadow の控えめな pulse で示す。dot は start marker には出さず、anchored row では turn rail 側の左端、左下 fallback sticky では marker 先頭に同じ見た目で出す
- running turn の `updatedAtIso` / `lastItemIndex` / `itemCount` が変わったときだけ短い update flash を出し、初回描画、scroll、resize、anchored / fallback の表示切り替えだけでは flash しない
- running chip の枠は常時回転させない。進捗更新時だけ、update flash と同じ activity signature 変化で薄い border glint を 1 回だけ流す
- `prefers-reduced-motion: reduce` では running chip の pulse / flash / border glint と running marker dot pulse を止め、静的な accent 表示だけにする
- sticky user header は、次の user card の上端が sticky 表示領域に到達した時点で次の user に切り替える
- patch group card は collapsed state で compact file summary を表示し、先頭 3 file rows と `あと N 個のファイルを表示` / `表示を減らす` を持つ。全ファイルの diff をまとめて読む操作は `レビューする` ではなく、`全差分を開く` / `全差分を閉じる` として扱う。`元に戻す` は初期実装に含めない
- `全差分を開く` は patch group card 内の in-place all-diff mode として動作し、オーバーレイ、別タブ、別パネルは使わない。押下時は対象 card だけを全幅にし、file list を全件表示し、全 file の patch detail を同じ card 内で展開する
- `全差分を閉じる` は同じ card の全 patch detail を閉じ、compact file summary に戻す。解除時は all-diff mode に入る前の card 幅状態を復元する。file row の個別クリックによる単体 patch detail 展開は従来どおり残す
- all-diff mode でも diff body は既存の deferred rendering / loading 表示を使い、全 entry の wrapper は描画しつつ、diff body の実体を同期的に一括描画しない
- `Show details` OFF で描画されないカードは、先頭 / 末尾スクロールおよび `follow` の対象に含めない
- `Show details` OFF では tool 引数 / tool 出力 / patch diff 行などの重い詳細を省略し、必要時に full detail を再読み込みする
- `chat.performanceMode` は `auto` / `normal` / `simplified` を持つ
  - `auto`: ファイルサイズ、item 数、diff entry 数、diff 行見積もり、画像数に応じて `normal` / `simplified` を選ぶ
  - `normal`: 表示状態をできるだけ保持する
  - `simplified`: diff 本文や詳細を必要時に読み込み、タブ再表示時は重い描画済み section を一時的に軽量化する
- セッションビューのヘッダーにあるパフォーマンスモードボタンは、この画面だけの一時設定として `auto` / `normal` / `simplified` を循環する。永続化は設定側で行う
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
  - archived Codex セッションビューから `Move to Codex History` を実行する場合は、ボタン押下時に現在見えている本文メッセージ index を保存し、復元後の active セッションパネルで同じ本文メッセージを明示的に reveal する
- ツリー選択で開くセッションビューは再利用タブとして扱い、次のツリー選択で中身を差し替える
- メニューから開くセッションビューはセッションタブとして扱い、別セッションを開いても差し替えない
- 再利用タブに表示中の同じセッションをメニューから開いた場合、そのタブをセッションタブへ昇格する
- ツリー選択 / メニュー操作のどちらでも、同じセッションを表示するタブが既に開いていれば既存タブをアクティブにする
- Reload とセッションタブの自動更新は、表示位置、選択メッセージ、詳細表示、展開カード、展開 diff、diff 折り返し、検索サイドバー状態を維持する
- 再利用タブで別セッションへ切り替わる場合は、検索状態、検索リサイズ状態、画像プレビュー、画像データキャッシュ、画像保存先 CWD、patch entry 詳細の pending 要求などのセッション依存 UI / panel-side 状態をリセットする
- grouped diff カードの最大幅状態は、再読み込みでカードの並び順が変わっても維持しやすいように安定キーで管理する

### 3.6.1 File AI Change History（ファイル単位の AI 更新履歴）

- 目的:
  - ワークスペース内の 1 ファイルを起点に、そのファイルへ影響した Codex / Claude の AI diff 履歴を時系列で確認できるようにする
  - diff から元の通常履歴 Webview の該当 diff カードへ戻り、セッション文脈を確認できるようにする
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
  - 初期表示と追加読み込みは、セッション開始時刻ではなく diff card の変更時刻昇順
  - Codex / Claude の source toggle 後も、表示中 card の変更時刻順を維持し、card 番号 `#N` は読み込み済み mixed timeline 上の番号を維持する
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
  - 追加分が既存表示の途中に挿入される場合でも、閲覧中 card の anchor を基準に scroll を復元する
  - 初回読み込み / 再読み込み後にまだ続きがある場合は、`続きを読み込む` で追加できることを toast で案内する
  - `続きを読み込む` 成功後もまだ続きがある場合は、追加件数と続きがある旨を同じ toast にまとめ、同系統の toast は重ねず置き換える
  - 全候補を解析済みの場合は `これ以上の履歴はありません` を表示し、`続きを読み込む` を消す
- date guide:
  - `codexHistoryViewer.ui.timeGuide.enabled` が `true` のときだけ表示する
  - ファイル履歴では範囲に応じて day / month / year に自動スケールする
  - ファイル履歴の major tick では、対応する mixed timeline card 番号を `#12 7/1` や `#12-#18 7/1` のように日付と併記する
  - ファイル履歴の minor tick は dot のみ表示し、card 番号は tooltip / aria-label に保持する
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

### 3.6.3 Codex Branch Navigation

- 共通設定 `codexHistoryViewer.branchNavigation.enabled` が `true` のときだけ有効になる実験的機能で、既定は無効とする。公開前の旧 `claudeBranches.enabled` と開発途中の `codexForks.enabled` は残さず、aliasやmigrationも設けない
- Codex のローカル Fork 操作が先頭 `session_meta.payload.forked_from_id` に保存した direct parent IDだけを関係の正本とする。Codex アプリの `ローカルにフォークする` と Codex 拡張機能の `新しいタスクで続ける` のどちらも対象とし、本文の類似、開始時刻、同じ `cwd` だけを根拠に Fork を推定しない
- Codex subagent も `forked_from_id` を持つため、検証済みの `session_meta.payload.source.subagent.thread_spawn` を Fork metadata より優先する。`codexAgent` と `codexFork` の両方を持つ session は Agent Runs の対象とし、Branch Navigation の node / edge に含めない
- Agent Runs の設定に依存せず、Codex Branch Navigation の load 前に未確認 agent metadata を補完する。一部を確認できない場合は未確認 session を Fork と推測せず除外し、確認済みの関係だけを partial として扱う
- parent / child の正規化済み absolute `cwd` が同一の場合だけ local Fork の resolved edge とする。`新しい Worktree にフォークする`、異なる `cwd`、relative path、比較不能な `cwd` は 2.8.0 の対象外とし、通常の Fork 経路へ混在させない
- direct Fork、同じ parent からの複数 Fork、nested Forkを current session の component 内で表示する。parent 欠落、ID 重複、self reference、cycle、上限超過は任意の別sessionへ補完せず、確認できる経路だけを partial として扱う
- parent / child にmaterializeされた可視 user / assistant messageの共通prefixから、既存Chatと同じ1-based message indexのFork anchorを求める。Codexがコピー履歴へtimestampを再付与する場合があるため、timestampを同一messageの必須条件にしない
- Codexセッションビューのヘッダー、タイムライン上の前後操作、経路ツリーoverlayはClaude Branch Navigationと同じ操作・paging・focus・Escape契約を共用する。ヘッダーアイコンはCodexの向きに合わせて上2点から下1点へ合流する形とし、Agent Runsボタンとは併存するが両overlayは同時に開かない
- 経路選択は同じセッションWebviewを`stateOverride`の二相commitで切り替える。History generation、snapshot、opaque target、対象fileの`mtime` / `size`、最新request IDを非同期境界で再検証し、stale targetでは現在表示を変更しない
- relation node 500件、depth 64、1 sessionの可視message 100,000件、対象file 256 MiBを上限とする。evidence cacheは`cacheKey`、`mtime`、`size`へ結び付け、History更新、設定無効化、明示的cache再作成で失効させる
- bookmark / tag / noteは各load時のpresentation stateとして反映し、relation topologyや永続cacheへ混在させない。元のCodex JSONL、workspace、Fork、注釈を作成・変更・merge・削除しない

### 3.6.4 Claude Branch Navigation

- タイムラインカード右上の前／次ボタンは隣接する履歴へ切り替える。hover / focus では occurrence 数にかかわらず、同じ #番号の本文と取得済みの履歴末尾を preview card にすべて表示し、各 occurrence card の click で該当履歴へ直接切り替える。未 load occurrence がある場合だけ省略表示を出す。前／次ボタン自体の click は、単一なら直接切り替え、複数なら既存の履歴位置 picker を開く。pointer がボタンと card の間を移動する間は card を維持する。
- 中央の `履歴 N / M` は全候補の一覧を開く。各 group header は `履歴 N / M` badge、同じ位置の1行本文、role / #番号 / timestamp を表示する。子の履歴位置はインデントと guide line で分け、各履歴末尾を1行表示し、移動可能な card だけ移動 icon と hover / focus 装飾を持つ。
- 全候補一覧の現在 occurrence は静的 card とし、現在 badge は表示するが移動 icon と hover を付けない。overlay の occurrence picker では current session 内の別 anchor へ移動できるため操作可能なままとする。
- occurrence の表示契約には `isCurrent`、`historyEnd`、bookmark / tag / note の有無を含める。Webview は absolute path や occurrence ID を候補ラベルとして表示しない。
- 候補一覧は choice と choice ごとの occurrence をそれぞれ最大20件に制限する。Extension Host と Webview の受信正規化で同じ上限を独立に適用し、総件数を維持して未表示候補の省略案内を出す。

- 共通設定 `codexHistoryViewer.branchNavigation.enabled` が `true` のときだけ有効になる実験的機能で、既定は無効とする。この設定は Codex / Claude の Branch Navigation を一括で切り替える
- 対象は同じ物理 Claude project folder にある top-level primary Claude セッションだけとし、Codex、sidechain、別 project folder のセッションは分岐関係へ含めない
- Claude のセッションビューのヘッダーとタイムラインカードから分岐解析を要求できる。独立した全体マップ、セッション右クリック、Command Paletteの専用表示コマンドは設けず、現在のセッション Webview 内の切り替え操作と経路ツリー overlay で完結する
- タイムラインカード上の前後操作は同じ分岐点の履歴を切り替え、overlay は履歴の開始、分岐直前、各履歴の分岐開始、各履歴の末尾だけを landmark node として表示する。通常メッセージのすべてを node 化しない
- Codex / Claude 共通の経路ツリー node は role、#番号、秒までの timestamp を省略せず表示する。幅が不足する場合は metadata 行を折り返し、anchor と分岐前補助行の完全値を native tooltip でも確認できるようにする
- 分岐先を選ぶと同じセッション Webview で対象セッションへ切り替え、既存のセッションタイムラインと同じ 1-based message index の位置を表示する。bookmark、annotation、Search、File AI Change History の anchor を再採番しない
- primary candidate が 2 件未満の場合は追加解析を開始しない。分岐 0 件が確定した場合は理由を toast で通知し、解析中や遷移中は重複操作を無効化する
- 関係解析は raw メッセージ本文を ID やログへ保存せず、確定できない関係を内容類似だけで推測しない。部分的な関係しか保証できない場合は、確認できた分岐だけを表示して warning を出す
- 無効化しても Session Analysis Index、現在のセッションビュー、bookmark、annotation、元の Claude JSONL を変更しない

### 3.6.5 Agent Runs（Codex 対応）

- `codexHistoryViewer.agentRuns.enabled` が `true` のときだけ有効になる実験的機能で、既定は無効とする。現在は Codex セッションのみに対応する。設定が有効なら Codex のセッションビューのヘッダーへ常に操作アイコンを表示し、関連する実行がない場合は toast で通知する
- Codex JSONL の `session_meta.payload.source.subagent.thread_spawn` だけを親子関係の正本とし、親セッション ID、depth、agent nickname、agent role、task path を bounded に取得する。本文の類似度、時刻の近さ、同じ `cwd` だけを根拠に関係を推測しない
- relation presentation の準備完了後は、利用可能な親を解決できたサブエージェントだけを History から抑制する。親不明、削除済み親、cycle / self-parent、未確認 metadata のサブエージェントは fail-open で History に残す。Pinned / Search では全サブエージェントを専用アイコン、説明、tooltip で区別して独立表示し、検索・集計の対象集合は変更しない
- セッションビューの右側ペインは、現在セッションを含む component の root、ancestor、sibling、descendant を縦方向の pre-order tree で表示する。主見出しは利用可能な root session title、副見出しは機能名と関連 agent 件数とする
- node card は task label、設定されている場合の agent role、必要な場合の session title、開始日時、最終アクティビティ、bookmark / tag / note、直接の子件数を表示する。固定の最小高さを設けず、情報を省略しない範囲で compact にする
- current node と root から current までの経路は青、他の agent 経路はオレンジで表示する。connector は parent ごとの共有幹線と短い枝線で描き、通常 depth では parent 下辺から同じ X 座標へ真下に伸ばす。視覚インデント上限で card を避ける必要がある場合だけ短い折れを許可する
- card 本体は静的な treeitem とし、利用可能な別 node の header 右端にある `セッションを開く` アイコンだけを移動操作にする。hover / focus-within では card と icon を強調し、icon の active 中は押下状態を示す。current、missing parent、省略 node は移動可能に見せない
- 移動先のセッションタブが開いていれば reveal し、未 open なら通常の固定 session panel を開く。元 panel の session、scroll、search、details state を別 session へ置き換えない
- ペイン幅はドラッグで変更して Webview state に保存するが、ペインの open 状態は Reload Window 後に復元しない。Branch Navigation overlay、page search と同時には開かない
- Webview では表示 node 500 件、depth 64、parent ごとの child 200 件を上限とし、current path を優先して省略件数を表示する。partial relation、missing parent、stale navigation target は確認できた範囲だけを表示し、元の JSONL や注釈を変更しない

### 3.7 設定（`codexHistoryViewer.*`）

- `sources.enabled`
- `sessionsRoot`
- `codex.archivedSessions.enabled`
- `codex.archivedSessionsRoot`
- `claude.sessionsRoot`
- `agentRuns.enabled`
- `branchNavigation.enabled`
- `handoff.enabled`
- `preview.openOnSelection`
- `preview.maxMessages`
- `preview.tooltipMode`
- `search.defaultRoles`
- `search.indexToolContent`
- `search.caseSensitive`
- `search.maxResults`
- `fileChangeHistory.explorerContextMenu.enabled`
- `webview.restoreAfterReload`
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
- `chat.stickyUserPrompt`
- `chat.turnTimeline.mode`
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
  - `writeJson()` は同一ディレクトリの一時ファイルへ書いてから rename し、rename 失敗時は `beforeCommit` を再確認してから直接書き込みへフォールバックする。フォールバックの成功 / 失敗にかかわらず一時ファイルを best-effort で削除する
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
  - `History` view が非表示かつ自動更新オンのセッションタブが開いていない場合、または VS Code ウィンドウが非フォーカスの場合は timer を止めて pending を保持する
  - `vscode.window.state.focused` と `onDidChangeWindowState` により、フォーカス中のウィンドウだけ自動 refresh を実行する
  - 自動 refresh は `refreshHistoryIndex(false)`、view refresh、セッションビューのタイトル更新、対象セッションタブ更新を行い、Search 結果のクリアや検索インデックス再構築は行わない
- `src/extension.ts`
  - 自動更新 consumer は `History` view が表示中、または `ChatPanelManager` に自動更新オンの開いているセッションタブがある場合に存在するとみなす
  - `historyView.onDidChangeVisibility`、セッションビュー consumer 変更イベント、`onDidChangeWindowState` で `AutoRefreshService` の実行条件を更新する
  - `codexHistoryViewer.manageProjectAlias` / `setProjectAlias` / `clearProjectAlias` を登録し、Project node 文脈がない direct / UI command では active project を推定せず no-op にする
  - プロジェクト別名の変更後は view description と tree view を更新し、`refreshHistoryIndex(false)` と `chatPanels.refreshTitles()` は呼ばない
- `src/chat/chatPanelManager.ts`
  - セッションタブごとに `autoRefreshMode` と `pendingAutoRefresh` を保持する
  - `codexHistoryViewer.webview.restoreAfterReload = true` のときだけ `codexHistoryViewer.chat` の `WebviewPanelSerializer` を登録し、Reload Window / VS Code 再起動後も session path、panel kind、detail mode、自動更新 mode を復元する
  - Webview serializer 復元時は、最後に見ていた scroll 位置も `scrollY` / `topMessageIndex` として保存し、復元後に同じ message 付近へ戻す
  - Webview 復元設定は実験的な opt-in 設定として既定無効にし、VS Code の復元遅延により同じ履歴を再度開いたときにタブが重複する場合があることを設定説明で明示する
  - serializer 復元時も通常生成と同じ `webview.options`、HTML、`onDidReceiveMessage`、`onDidChangeViewState`、`onDidDispose` を再アタッチする
  - 開いているセッションタブは裏タブでも自動更新対象にする
  - `refreshAutoRefreshPanels(changedFsPaths)` は変更されたセッションファイルに対応するセッションタブだけ再読み込みする
  - Webview がまだ ready でない場合のみ `pendingAutoRefresh` として保持し、ready 後に 1 回反映する
  - Webview 内検索は入力ごとの即時 DOM 全走査を避けるため短い debounce を入れ、Enter / 前へ / 次へ / query クリアは即時反映する
  - 新規セッションタブ、または別セッションへ差し替えた再利用タブは `off` から開始する
  - 同じセッションの既存タブは自動更新モードを維持する

### 4.5 検索インデックス

- `src/services/searchIndexService.ts`
  - `search-index.v2.json` を管理する。ファイル名は `src/storage/cacheFiles.ts` の共通定数を使う
  - `SEARCH_INDEX_FILE_VERSION = 12` とし、archive context / file change hints / attachment metadata / request interruption filtering / user instructions filtering / Codex session-start protocol context filtering / Claude local command output filtering 追加前の既存インデックスは再構築対象にする
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
  - 初回読み込みと追加読み込みで `state.cards` を更新する直前に、読み込み済み card 全体を変更時刻昇順で安定 sort する
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
  - Webview 内検索の検索結果は、所属 card の mixed timeline 番号 `#N` を常時表示し、diff 本文 hit では `変更前 L...` / `変更後 L...` の行番号 badge を併記する
  - source toggle 後も検索結果 badge の `#N` は mixed timeline 番号として維持し、`続きを読み込む` 後は View 内の `#N` と同じ基準で再計算する
  - `model` message 受信時に `card.id` から mixed timeline 番号を引く Map を作り直し、card header、date guide、検索結果 badge、source toggle 復元の近傍計算で同じ番号を使う
  - mixed timeline lookup は `card.id -> index` と `card.id -> card` を O(1) で引ける形にし、`resetUi` で `model` を残す場合は Map だけを空にしない
  - Webview 内検索の diff 行番号 badge は、通常幅では `変更前 L...` / `変更後 L...` を表示し、検索パネル幅が不足する場合は CSS container query で visible text を `L...` に圧縮する。圧縮時も tooltip / aria-label には変更前 / 変更後を含める
  - Webview 内検索の compact badge 切り替えは render 後の overflow 測定ではなく検索パネル幅だけを基準にし、`scrollWidth` / `clientWidth` の layout read を行わない
  - Webview 内検索結果の `occurrenceIndex` は検索 refresh ごとの `cardId -> count` Map で生成し、hit ごとに既存 results 全体を走査しない
  - Webview 内検索の Enter / 前へ / 次へでは pending debounce を flush し、flush 済みの場合は同じ検索 refresh を二重実行しない
  - 追加読み込み成功後も、card id と card 内 offset を使って閲覧中 card 付近へ scroll を復元する
  - source toggle では先頭へ戻さず、表示対象に残る閲覧中 card、または時刻と表示位置が近い card へ scroll を復元する
  - `model` message 受信時は `render()` / scroll 復元前に restore state を保存せず、`restoreReloadScrollAnchor()` / `restoreScroll()` の適用後に `scrollAnchor` を保存する
  - 初回 / 再読み込み後に `hasMore` が残る場合は `続きを読み込む` の存在を toast で案内し、load more 後も続きがある場合は現在の source filter で見える追加件数と同じ toast にまとめる
  - load more で hidden source の card だけが追加された場合は、visible card が増えたように見える文言を避け、非表示中 source 用 toast へ分ける。現行の追加 source 件数は `{ codex, claude }` の閉じた契約として扱い、将来 source を増やす場合は host payload と Webview filter を同じ source model へ拡張する
  - 前 / 次 card ナビゲーションは、source toggle 適用後の表示中 card 配列を基準にする
- `media/sharedTimeGuide.js` / `media/sharedTimeGuide.css`
  - 通常履歴 Webview とファイル履歴 Webview で共通の date guide を提供する
  - 設定が無効な場合は date guide DOM を生成しない
  - 表示単位はモードと範囲に応じて自動スケールする
  - date bucket は先頭 item だけでなく bucket 内 item 集合を集計し、File History から opt-in の mixed timeline card ordinal metadata が渡された場合だけ `#N` / `#N-#M` を組み立てる
  - File History の card ordinal は major tick の visible label にだけ表示し、minor tick では tooltip / aria-label にだけ含める
  - File History の ordinal summary は visible label 生成に必要な label だけを返し、未使用の start / end 情報は共有 date guide API に残さない
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
  - hidden source のみが追加された load more 用の toast 文言を英日両方で管理する

### 4.6 History Insights / Session Analysis / Branch Navigation 実装

- `src/analysis/sessionAnalysisTypes.ts`
  - source 共通の message / usage / tool usage / file change 統計、解析完全性、Claude occurrence、cache context / file schema を定義する
  - `complete` / `partial` / `unsupported` / `failed` と、指標単位の `available` / `partial` / `unavailable` を分離する
- `src/analysis/sessionAnalysisAdapter.ts`
  - 1 セッション単位で JSONL を streaming 解析し、既存 `buildChatSessionModel()` の message item / turn / tool / patch / usage を共通の意味として再利用する
  - tool item は正規化済みの名前ごとに呼び出し回数を集計し、名前長と種類数をboundedに保持する。切り詰めまたは種類数上限超過を検出したentryは `partial` とする
  - Codex と Claude の token 規則を混同せず、Claude だけは branch relation 用の bounded occurrence と既存のセッションタイムライン表示に一致する visible message anchor を追加する
  - prompt / response 本文、tool output、認証情報候補を cache ID や debug log へ保存しない
- `src/analysis/sessionAnalysisIndexService.ts`
  - `session-analysis-index.v1.json` の lazy load、context / version 検証、mtime / size による差分更新、orphan cleanup、single-flight、キャンセル、進捗、atomic save、clear、strict な `rebuildAll()` を担当する
  - 解析要求を直列化し、再構築と通常の Insights / Branch 要求が同じ cache を競合更新しないようにする
  - 通常の `ensureEntries()` は保存失敗後も process-local 結果を返すが、`rebuildAll()` は削除 / 保存失敗を伝播し、保存成功前の結果を current cache として公開しない
- `src/insights/historyInsightsSnapshot.ts` / `src/insights/historyInsightsAggregator.ts`
  - History provider が確定した session reference 集合と `bucketLocalDate` を snapshot の正本にし、Webview や集計側で History の条件述語 / 日付境界を再実装しない
  - snapshot と解析 entry を `cacheKey` / `identityKey` で結合し、推論トークン / 変更イベント数を含む概要、推論トークンを含む日別 bucket、ソース / モデル / プロジェクト / ツール内訳、指標別アクティブセッション、ファイル統計、利用詳細、充足率を構築する
  - 利用詳細では入力キャッシュと推論、メッセージ構成、ターン状態を指標単位で集計し、変更ファイル種別は共通の `FilePresentationKind` ごとに重複除外後のファイル数と変更イベント数を構築する
  - ツール内訳とアクティブセッションは指標ごとの上位候補だけをmodelへ含め、safe integer飽和と取得可否を他の集計指標と同じ規則で扱う
- `src/types/dateScope.ts` / `src/types/historyFilterState.ts` / `src/types/projectSelection.ts`
  - 両端包含の日付 range、関連付け後の複数プロジェクト選択、source / archive / tag を含む History filter state V2 の検証、canonicalize、比較、永続化契約を定義する
  - History Tree と Insights の一括適用は同じ型と検証規則を使い、不正な range や project selection を暗黙に `すべて` へ広げない
- `src/storage/mementoTransaction.ts`
  - 複数の `workspaceState` key を直列更新し、途中失敗時は成功済み key を逆順で旧値へ戻す補償 transaction を提供する
  - 通常の commit 失敗と補償ロールバック失敗を区別し、呼び出し側が後者を利用者へ通知できるようにする
- `src/tree/historyTree.ts`
  - History の確定条件を適用した Insights snapshot を作り、各 session reference へ既存の日付基準を適用済みの `bucketLocalDate` を付与する
  - Insights の filter / drill-down は History Tree の共通条件適用経路を使い、Webview 側の独自述語で対象集合を作らない
- `src/insights/historyInsightsPanelManager.ts`
  - panel の作成 / 再利用 / serializer、snapshot の置換と同一集合の再集計、フィルター適用、進捗、キャンセル、drill-down を管理する
  - フィルター適用を副作用のない prepared application、snapshot 保存、任意の History commit、panel state 公開に分離し、全 commit 成功後だけ新しい state を Webview へ送る
  - filter 適用の進行中 Promise を保持し、適用中の外部 `open()` は完了後に現在の History 条件を再取得してから snapshot を保存する
  - request generation、panel instance、state instance を照合し、閉じた旧 panel の非同期結果を新しい panel へ送らない
  - Webview から受け取る filter / opaque ID を Host 側でも検証し、物理 path や session 集合の判定を Webview に委ねない
  - serializer から復元した state だけに authoritative History index 必須フラグを付け、初回 full refresh の待機中も panel、state generation、load ownership、明示 cancel を検証する。authoritative index で reference を再解決してから snapshot を保存し、待機中の cancel / dispose / state 置換後に遅れて完了した処理は公開しない
  - snapshot と current config の date context が不一致の場合は旧 model、file ID map、project ID map を破棄し、cache model と最終 model の公開直前にも再確認して stale な drill-down 操作を残さない
- `src/extension.ts` / `src/services/historyService.ts`
  - serializer 復元用に初回 full History refresh の完了、authoritative config、session inventory generation を管理し、同じ同期区間の current sessions を copy して Insights へ渡す
  - full refresh と fresh cache 採用は inventory generation を更新し、Codex agent metadata backfill のような session inventory を変えない更新は generation を維持する。History index 条件変更時は authoritative marker を無効化し、source constraint を含む refresh operation を待機前に History refresh queue へ登録する
- `media/historyInsights.js` / `media/historyInsights.css` / `media/sharedFileKind.css`
  - 履歴インサイトの toolbar、filter overlay、概要、ヒートマップ、ソース / モデル / プロジェクト / ツール内訳、指標別アクティブセッション、ファイル一覧、データ品質、状態表示を描画する
  - セッションビューと Insights の file kind は `src/utils/fileKind.ts` と shared CSS を使い、同じファイルを画面ごとに別分類しない
- `src/analysis/claudeBranchAnalysisService.ts`
  - 同一物理 project folder の解析 entry を canonicalize し、確定した parent / child、branch group、lane を process-local snapshot として構築する
  - relation node 数と処理 occurrence 数に上限を設け、cycle、missing parent、identity conflict を推測で補完しない
- `src/branchMap/claudeBranchNavigationService.ts` / `src/branchMap/claudeBranchMapTypes.ts`
  - セッションビュー用 branch control、経路ツリー overlay、opaque navigation target、同一 Webview 内の session / message anchor 遷移を解決する
  - bookmark / annotation の表示状態は永続 topology に混ぜず、表示 payload を作る時点で反映する
- `src/chat/chatPanelManager.ts` / `media/chatView.js`
  - Codex / Claudeそれぞれの有効なセッションビューへsource固有のbranch modelを共通のcontrol / overlay payloadとして追加し、既存のChat itemやmessage indexは変更しない
  - 既存 panel が ready 前でも session、reveal index、overlay 自動表示要求を candidate state として保持し、初回 bootstrap 後に適用する

### 4.6.1 Codex Branch Navigation 実装

- `src/branchMap/codexForkMetadata.ts` / `src/sessions/sessionSummary.ts` / `src/services/historyService.ts`
  - Codexの先頭`session_meta`からboundedな`forked_from_id`だけを抽出し、通常summaryとHistory cacheへ保存する。後続のmaterialize済みancestor metadataでcurrent sessionのparentを上書きしない
  - cache復元時にも同じsanitizerを適用し、不正metadataを持つentryだけを元JSONLから再生成する。Claude summaryへCodex専用metadataを残さない
- `src/branchMap/codexForkRelationService.ts` / `src/branchMap/codexForkRelationTypes.ts`
  - 明示parent IDと同一absolute `cwd`からlocal Fork graphを構築し、current component、nested parent / child、sibling、missing parent、cycle、上限を決定的に解決する
  - sanitize済み`codexAgent`を持つsessionは、`codexFork`も持っていてもFork graphのparent / child / current候補から除外する
  - 既存Chat modelの可視messageからrole、1-based message index、本文・attachmentの安定hash、利用可能なsource item ID / turn IDを取得し、timestampに依存しない共通prefixとFork anchorを求める
- `src/branchMap/codexForkNavigationService.ts` / `src/branchMap/codexForkNavigationTypes.ts`
  - relation構築前にHistory cacheのCodex agent metadataを補完し、補完後のHistory generationをsnapshot基準にする。未確認entryはfail-closedで除外し、partial snapshotへ反映する
  - current componentのfile inventoryを検証しながら最大4並列でevidenceを構築し、boundedなprocess-local cache、opaque target、Claudeと共通shapeのinline control / overlay page / cursorへ変換する
  - 解析中のfile変化はservice内で1回再読込し、load全体のsuperseded後に行うHost再起動も1回までに制限する。実行中JSONLが継続更新されても無制限な解析loopにせず、次の手動reload / 自動更新 / History更新で再試行する
  - History generation、file inventory、active lineage、group / choice / occurrenceの所属をHost側で再検証し、別component、stale cursor、変更済みfileへ移動しない
  - bookmark / tag / noteはload時に注入したpresentation providerから取得し、evidence cacheを再解析せず最新表示へ更新する
- `src/chat/chatPanelManager.ts` / `media/chatView.js`
  - session sourceと設定に応じてCodex / Claudeのnavigation serviceを選び、共通ヘッダーボタン、件数badge、timeline control、route tree、paging、same-Webview transitionへ公開する
  - 共通route treeのanchor / 分岐前metadataは秒までの時刻を折り返して全文表示し、同じ完全値をtitleへ設定する
  - sourceごとにsnapshot型、失敗文言、target validatorを分離しながら、共通設定、generation、request ID、Escape、focus、overlay相互排他、auto-refresh中の表示維持は共通契約を使う。新generation開始時はHostの旧snapshotを失効させ、Webviewも旧paging応答を最新global generationで拒否する
  - 同一sessionかつcurrent group / choice / occurrenceから成るcurrent route nodeが存続する自動更新ではtree scroll、scale、stable focusを維持し、current route node変更またはsession境界だけで再fitする。別sessionのoverlayを直接開くcommandは設けず、cross-sessionのone-shot open intentやsuspend stateを持たない
  - Codex切替はtarget準備前とcommit直前の2回、同じsnapshot、target包含関係、History generation、全component inventoryを検証する。別sessionのmodel構築中だけでなく、同一sessionのsource file確認中にfileが変化した要求も古いmessage indexへcommitしない
- `src/extension.ts` / `src/settings.ts` / `package.json`
  - application scope、default falseの共通`branchNavigation.enabled`を登録する。Branch Navigation専用のcanonical command、英日alias、Codex / Claude session context menuは登録しない
  - 共通設定はCodex / Claudeの両navigationを一括で切り替え、公開前のsource別設定には互換aliasやmigrationを設けない
  - 設定変更、History generation更新、bookmark / annotation変更、cache再作成で開いているCodex sessionのFork modelを再取得する

### 4.6.2 Agent Runs（Codex）実装

- `src/agents/codexAgentMetadata.ts` / `src/agents/codexAgentRunsTypes.ts`
  - `thread_spawn` の外部入力を検証し、親 rollout ID、recorded depth、task path、nickname、role だけを bounded metadata として保持する
  - raw prompt、response、tool output、absolute session path は relation ID や表示名として使用しない
- `src/services/historyService.ts` / `src/sessions/sessionSummary.ts`
  - 新規・更新 Codex session の通常 summary 作成時に agent metadata を同時抽出する
  - 既存 `cache.v9.json` は設定無効時もそのまま利用し、有効化時だけ未確認 entry の `session_meta` を bounded scan して metadata marker version 1 を補完する。成功済み entry は再走査せず、全 Codex entry を確認できた場合だけ file marker を付ける
  - metadata backfill は通常の History summary、mtime、size、Search Index、Session Analysis Index を再生成しない。read / save の部分失敗では確認済み結果を利用しつつ、未確認 entry を次回再試行できる状態にする
  - process-local の Index / cache snapshot は構築時の History config key と generation に結び付ける。現在設定、要求設定、Index構築時設定、cacheのtime zone keyが一致する場合だけcurrentと判定し、date basis / title source変更後の旧IndexをAgent Runsへ流用しない
- `src/agents/codexAgentRunsService.ts`
  - History Index から rollout identity と明示的な parent edge を解決し、cycle / self-parent を除外した component、presentation、opaque navigation target を process-local に構築する
  - root / ancestor / sibling / descendant の順序、missing parent placeholder、current path、node / child 上限を決定的に解決する。annotation や project alias は topology へ混ぜず表示時に反映する
- `src/ui/sessionIconResolver.ts` / `resources/icons/*/source-codex-subagent.svg`
  - History で fail-open により残るサブエージェントと、Pinned / Search に残す全サブエージェントについて、source icon と subagent icon を一元的に解決し、Light / Dark theme 用 asset を使い分ける
- `src/tree/historyTree.ts` / `src/tree/pinnedTree.ts` / `src/tree/searchTree.ts`
  - 設定有効かつ relation presentation の準備完了後、History では利用可能な親を持つサブエージェントだけを抑制し、親セッションの直接の agent 件数と、History に残す orphan / 不正 edge の presentation を構築する。Pinned / Search では全サブエージェントの専用アイコン、description、tooltipと、利用可能な子セッション用の`親セッションを開く` context値を構築する。`Agent Runs を表示` context値は作らない
  - 通常の filter、sort、session count、Search hit、archive、bookmark、annotation の意味は変更しない
- `src/chat/chatPanelManager.ts` / `media/chatView.js` / `media/chatView.css`
  - Branch Navigation とは独立した generation、snapshot、opaque target、右側ペインを管理し、stale target や別 panel の message を fail closed にする
  - root title を panel heading、機能名と件数を副見出しにし、compact card、agent role 補助ラベル、共有幹線、青い current path、オレンジの他経路、header 右端の移動 icon、hover / focus / active stateを描画する
  - resize、scroll、focus、Escape、相互排他 overlay の状態を明示的に破棄・復元し、一時 listener、古い DOM、旧 session の model を残さない。`ChatPanelManager` 自体も extension subscription として dispose し、store listener と進行中の分岐解析を解放する
- `src/extension.ts` / `src/settings.ts`
  - application scope の実験的設定を監視し、有効化時だけ metadata backfill と presentation refresh を開始する。無効化時は実行中 generation を無効化し、relation 表示を消すが履歴 cache や元 JSONL は削除しない
  - History関連設定変更とAgent Runs有効化が同時に発生した場合、またはAgent Runs ON中にHistory関連設定が変わった場合は旧snapshotとopaque targetを破棄してloadingかつfail-openを維持し、新設定のHistory refreshがcurrent Indexをcommitした後だけrelationを有効化する。replacement refreshが失敗しても旧ready表示へ戻さず、設定変更のない通常refreshでは既存overlayを維持する

### 4.7 検索フロー

- `src/extension.ts` / `src/services/searchExecutionCoordinator.ts`
  - 検索 generation を発行した直後、最初の await より前に、設定、History の date / project / source / tag / archive 条件、project association resolver、current History refresh queue を固定する
  - 実行中検索を非公開にする通常条件は、進捗通知からの明示キャンセルと新しい検索開始だけとする。History filter / scope、project association、関連設定、Auto Refresh、手動 History refresh、明示 maintenance の開始では generation を変更せず、開始時条件の検索を完走させる
  - 実行中に filter / scope が変わった場合は自動再検索要求を1件へまとめ、開始時条件の結果を公開した後に最新条件で一度だけ再検索する。旧検索が明示キャンセル、入力キャンセル、失敗で結果を公開しなかった場合は自動再検索しない
  - 実行中の `refreshViews({ clearSearch: true })` は保留し、検索が新結果を公開した場合は旧結果向けの clear 要求を破棄する。検索が結果を公開せず終了した場合だけ保留した clear を実行する
- `src/services/searchService.ts`
  - 開始時に互換性のある History Index がなければ、呼び出し時に捕捉した History refresh queue を一度だけ待つ。待機後も開始設定と互換な Index を取得できなければ `historyUnavailable` とし、後発 queue または後発設定を追わない
  - current History Index から readonly session inventory を copy し、検索インデックスの差分同期、候補抽出、結果作成まで同じ開始時 snapshot を使う
  - 削除済みファイルに対応してインデックスから不要エントリを落とす
  - 候補絞り込みは「日付 / プロジェクト / ソース / History タグ」の順で適用する
  - `includeArchivedSessions` に従って archived session を除外し、除外後に `search.maxResults` を適用する
  - プロジェクト別名は検索 hit 対象には含めず、検索実行時に SearchRootNode の scope label へだけ反映する
  - 進捗表示とキャンセルに対応する
- `src/services/searchIndexService.ts`
  - operation ごとに専用 working Map を構築し、保存成功後にだけ process-local current を一括更新する。後発 operation が別 context を公開しても、先行検索は当該 operation から受け取った readonly read snapshot を最後まで使う
  - 通常検索と再作成の token が確認する外部中断条件を分離し、History generation や関連設定の変更を暗黙のキャンセルへ変換しない

### 4.8 削除とゴミ箱

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

### 4.9 注釈 / ピン / 保存済み検索 / プロジェクト関連付け

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
  - Historyの日付 / `ProjectSelection` / source / tag / archive locationは`HistoryFilterStateV2`として`workspaceState`に保存する。`ProjectSelection`がHistory / Searchの実効project集合の正本で、project display / project scope / view modeはV2の対象集合に含めず独立して保存する。`historyProjectScope=currentGroup`は、V2 selectionが現在workspaceのcanonical group 1件と一致する場合だけ有効なtoolbar由来状態とする
  - Reload時はV2とproject scopeを両方復元し、current-group不変条件を検証する。不一致ならV2 selectionを安全な明示条件として維持してscopeだけ`all`へ正規化し、scopeが`all`でも明示selectionは保持する。scopeが`all`のときにV2 selectionから`currentGroup`を推測しない
  - V2が破損している場合は旧条件へfallbackせず`ProjectSelection.none`とscope=`all`を使い、古いscope markerも`all`へ保存する。V2本体はユーザーが条件をリセットまたは再適用するまで自動上書きしない
  - date / source / tag / archive locationだけの変更ではproject selectionを維持し、現在workspace groupとの一致が続く場合だけ`currentGroup` scopeも維持する。不一致またはworkspaceなしならselectionを変えずscopeだけ`all`へ正規化する。明示project選択、History InsightsからのHistory適用、drill-downではscopeを`all`へする。clearはscopeが`currentGroup`なら現在group selectionを維持する
  - archive preferenceと`HistoryFilterStateV2`、または`ProjectSelection`とdisplay / scopeのように複数keyの値を同時更新する場合は、変更するkeyを同じ補償transactionへ含める。成功済みkeyの旧値を保持し、後段失敗時に逆順で補償ロールバックする。初回V2移行時もV2、必要なarchive preference、display、scope、一度限りのlegacy project filter補正を1 transactionにまとめる。保存完了前にin-memory state、provider、context、view descriptionを変更しない
  - Historyのproject stateとfilter stateの更新は共通queueで直列化し、source / tagなど変更対象以外のfieldはqueue内の最新確定stateから合成する。association再読込と実際の関連付け追加 / 解除 / 種類変更後もselectionとscopeの整合性を再検証し、変更時はV2とscopeを同じtransactionで保存する。拡張自身の関連付け操作では変更前scopeが`currentGroup`なら現在workspace groupを再選択してscopeを維持し、外部変更を取り込む通常refreshで不一致ならselectionを維持してscopeだけ`all`へする。V2修復を保存できなければ関連付けを操作前snapshotへ戻し、復元にも失敗した場合はReloadを案内する。保存成功後の派生view / Search更新だけが失敗した場合は確定stateを維持し、再試行導線を出す
  - History / Searchの説明では`現在のプロジェクトグループ`と、その裏付けの単一group selectionを重複表示しない。Pinnedは従来どおり独立したproject filter / scopeモデルを維持する
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
  - `chat.openPosition = latest` は保存位置を使わず、Webview 側で最新の描画済み visual target へ移動する。折りたたみ中の turn は勝手に展開しない
  - session path 移動時は `relocateSessionPath()` で保存位置を新 path へ移す
  - path 移動時に移行先 entry が既にある場合は移行先を優先し、source 側で上書きしない

### 4.9.1 Handoff

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

### 4.9.2 Codex アーカイブ / 復元

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
  - セッション Webview 由来の restore は direct 引数の `revealMessageIndex` を検証し、復元先 active path の `ChatOpenPositionStore` に保存する
  - restore が例外を投げた場合は `app.restoreArchivedFailed` を表示し、履歴と view を更新して部分移動済み状態にも追従する
  - filesystem restore の場合だけ Undo を出し、公式 provider restore では本家状態との整合を優先して Undo を出さない
  - `codexHistoryViewer.archiveSession` は Codex source と archived sessions が有効な active Codex session だけを対象にする
  - `archiveLocationFilter` は History / Search の Codex 用 preference として `workspaceState` に保存し、VS Code context `codexHistoryViewer.archiveLocationFilter` に反映する。Claude のみでは provider / filter state の実効値を `all` にするが、preference へ書き戻さない
  - `pinnedArchiveLocationFilter` は Pinned 用として `workspaceState` に保存し、VS Code context `codexHistoryViewer.pinnedArchiveLocationFilter` に反映する

### 4.10 表示

- セッションタイムライン表示: `src/chat/*`
  - `ChatPanelManager` は対象ファイルの存在を確認してから開く / reload する
  - refresh や削除で元ファイルが消えたパネルは閉じる
  - archived Codex session では `Resume in Codex` の代わりに `Move to Codex History` を表示する
  - `restoreArchivedSession` message を受け取り、復元成功後は同じ Webview panel を通常 session で開き直す
  - archived Codex セッションビューからの restore message は `lastMessage` 時に現在見えている `revealMessageIndex` を渡し、復元後 panel で明示 reveal する
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
  - `ChatPanelManager` は Codex turn の永続状態を変更せず、`chatTurnTimelineMode=live` の場合だけ active Codex root、archive 状態、mtime、auto-refresh 観測状態を使って live 表示の `running` を `displayStatus` として付与する
  - `chatModelBuilder.ts` は Codex の `turn_context.payload.model` / `effort` を assistant メッセージと usage 行へ付与する
  - `chatModelBuilder.ts` は Codex の `event_msg.payload.type = token_count` から `last_token_usage` / `total_token_usage` / `model_context_window` / `rate_limits` を usage 行に変換する
  - `chatModelBuilder.ts` は Codex の `task_started` を turn 開始の主シグナルとし、`turn_context.payload.turn_id` は active turn と一致する場合だけ補助観測として扱う
  - `chatModelBuilder.ts` は Codex timeline item に `turnId` を付与し、`ChatTurnSummary` で `sequenceNumber`、`incomplete` / `completed` / `interrupted` / `rolledBack` / `unknown` の永続状態、item / tool / patch / usage / token 合計を構築する
  - `chatModelBuilder.ts` は `sequenceNumber` を turn 観測順から決め、item を持たない turn を表示から除外しても後続 turn を再採番しない。表示番号の安定を優先し、歯抜けは許容する
  - `chatModelBuilder.ts` は raw `<turn_aborted>` を active turn にフォールバックして紐づけ、structured `turn_aborted` / `thread_rolled_back` と同じ turn summary に反映する
  - `chatModelBuilder.ts` は `token_count` usage の turn を active turn、明示 `turn_id`、explicit unknown terminal 由来の scoped block、直近 completed turn の順で解決し、`task_complete` 後に末尾 usage が来る場合も直近 turn に含める。turn token 合計には `last_token_usage` 相当の usage item を使い、累計値になり得る `total_token_usage` は直接合算しない
  - `chatModelBuilder.ts` は turn_id なしの重複 `task_complete` と explicit unknown `task_complete` を区別する。turn_id なしでは直近 completed turn の latest fallback を維持し、explicit unknown では古い completed turn への trailing usage 誤帰属を止める
  - `chatModelBuilder.ts` は turn_id なしの `task_started` で古い active turn への帰属を解除し、非 active の environment-only turn は空の turn marker として表示しない。一方、live 観測中の active turn は environment だけを持つ段階でも running 表示用に保持する
  - `chatModelBuilder.ts` は Claude の `message.model` / `message.usage` から usage 行を生成し、連続する同一 usage の重複表示を抑制する
  - `chatModelBuilder.ts` は `session_meta` などから CWD / Git ブランチ / Git コミット / dirty 状態を environment 行に変換し、同一 snapshot の重複表示を抑制する
  - `chatModelBuilder.ts` は Codex の `custom_tool_call` / `custom_tool_call_output` も tool カードとして扱う
  - `chatModelBuilder.ts` は Codex の `exec_command_end`、tool output の JSON / plain text、Claude の tool result から tool 実行メタ情報を抽出する
  - `chatModelBuilder.ts` は `extractCodexMessageContent()` / `extractClaudeMessageContent()` の結果から clean text と `attachments` を message item へ設定する
  - `chatTypes.ts` は `ChatImageAttachment` / `ChatDocumentAttachment` / `ChatFileReferenceAttachment` / `ChatSelectionReferenceAttachment` を `ChatAttachment` として定義する
  - `chatAttachments.ts` は画像、Claude document、Claude IDE tag、Codex `Files mentioned by the user` block を統合して抽出する
  - `chatAttachments.ts` は Claude の materialized message 判定を `detectClaudeMaterializedMessageRole()` に集約し、`queue-operation` と `attachment.type = "queued_command"` を chat / search / transcript / resume / handoff の本文化対象から除外する
  - `chatAttachments.ts` は Claude task notification / invoke を共通の bounded block scanner と Markdown safe-context map で抽出する。fenced code、inline code、blockquote 内の引用例は抽出せず、外側閉じタグや parameter / result 境界が曖昧な block は raw text として残す
  - bounded block scanner は open / close 候補を candidate 配列として先に列挙し、各 open は次の同種 open までの window だけを見る。close 欠落や malformed open が大量にある場合でも close 探索を EOF まで反復せず、検索インデックス構築や transcript / resume / handoff 生成を二乗時間にしない
  - `chatAttachments.ts` は task notification の `summary` / `result` / `usage` を top-level parser で読み、`<result>` 内の `<status>` / `<usage>` 風 text を top-level field として誤抽出しない。`usage` の数値は 10 進整数だけを受理する
  - `chatAttachments.ts` は `sanitizeAttachmentForChannel()` で Webview / Markdown / Search / Resume / Handoff 用 attachment projection を一元化し、task notification の `taskId` / `toolUseId` / `outputFile` / `systemPreamble` / `note` / `rawStatus` や invoke の `harnessPreamble` を通常 channel に載せない
  - `chatAttachments.ts` は content item を出現順に走査し、image / document attachment の順序を保つ。IDE tag 由来の file / selection reference は clean text 抽出後の attachment として扱う
  - `chatAttachments.ts` は `localimage` / `imageassetpointer` などの image-like type を patch detail 側の attachment-like 判定にも含め、messageIndex のドリフトを防ぐ
  - Codex `Files mentioned by the user` block は message 先頭または IDE context 後ろの本文途中から file reference に変換し、raw block は本文に残さない
  - Claude `<ide_opened_file>` / `<ide_selection>` は file reference / selection reference に変換し、raw tag は本文に残さない
  - Claude text document は表示用抜粋と検索用テキストをそれぞれの上限内で保持し、Save As 用 payload は panel 側 store へ置く
  - PDF / generic base64 document は初期 Webview model へ payload を渡さず、metadata と `dataOmitted` だけを渡す
  - `ChatPanelManager` は Webview model 生成時に `sanitizeAttachmentForChannel(..., "webview")` を通し、画面に描画していない内部メタデータも Webview payload へ載せない
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
  - セッションビューのヘッダーにある自動更新ボタンは `btnPageSearch` と `btnReload` の間に配置する
  - Webview 側は `requestReload` / `reload` message で自動更新時のスクロール・UI 状態保持を行う
  - Webview 側は `Show details` 切り替え時にカード anchor を保持し、再描画後に同じカードまたは次の表示カードへ復元する
  - Webview 側は performance mode に応じて heavy diff body の遅延描画、タブ復帰時の hibernation、restore cover 後の復元を行う
  - Webview 側は `lastMessage` の保存 / 復元を本文 `msg-*` アンカー単位で行い、対象が表示されていない場合は直前の描画済み本文メッセージ、なければ先頭へフォールバックする
  - Webview 側は `latest` のとき、保存位置を参照せず、ヘッダーの末尾ボタンと同じ最新の描画済み visual target へスクロールする。折りたたみ中の completed turn は勝手に展開せず、collapsed summary marker が末尾ならそこへ移動する
  - Webview 側は usage 行を折りたたみ可能カードとして描画し、展開状態を同一セッション reload 中は保持する
  - Webview 側は Codex turn ごとに start marker、end marker、turn rail を描画し、`live` mode では running anchored chip / running fallback chip を追加する。start marker は開始位置、end marker は最終 item 直後、running chip は `live` mode 専用として扱う
  - Webview 側の turn 表示は `ターン N` を主表示に使い、short `turn_id` は出さない。full `turn_id` は tooltip / aria-label にだけ出す
  - Webview 側の end marker は item / tool / patch / input token / output token / total token を表示し、token 合計がない場合だけ usage 記録件数を表示する
  - Webview 側は completed turn の start marker にだけ collapse toggle を置き、折りたたみ中は start marker を collapsed summary marker に切り替える。本文 row と通常 end marker は隠し、summary に `開始` / `終了`、開始時刻、終了時刻、所要時間、item / tool / patch / token summary を集約する
  - Webview 側の collapsed summary marker は狭い viewport でも `ターン N`、toggle、`開始` / `終了` badge を 1 行で維持し、時刻、所要時間、件数、token summary などの末尾補助情報を ellipsis または非表示にして横スクロールや隣接 marker との重なりを起こさないようにする
  - Webview 側の turn collapse 状態は `collapsedTurnIds` で同一セッション reload 中だけ保持し、session 切り替えでは破棄する。reveal / bookmark / patch navigation / page search など中身を見る操作は対象 turn を展開してから scroll / focus する。`follow`、`chat.openPosition=latest`、ヘッダー末尾ボタンは reveal 操作ではないため、手動で折りたたまれた turn を勝手に展開しない
  - Webview 側の scroll anchor は `.row[data-item-index]` だけでなく、現在描画されている visual target を対象にし、turn marker、collapsed summary marker、running anchored row を捕捉できるようにする。marker anchor の復元は reveal 操作ではないため、折りたたみ turn を展開せず、同じ marker 付近へ戻す
  - Webview 内検索で query により turn / patch group を一時展開する場合、検索結果への明示 reveal がない再計算では render 前の visual target anchor を保持し、render 後に同じ見かけ位置へ復元する。検索結果クリック、前へ / 次へなど hit へ移動する操作では、位置維持ではなく hit への scroll / focus を優先する
  - Webview 側は page search の pending refresh intent に query、大文字小文字条件、role filter、描画内容 revision を持たせ、session reload / detail toggle / path mode toggle などで結果集合が変わった intent を stale として扱う
  - Webview 側は attachment card 内の `<details>` 開閉を page search content mutation として扱い、render を伴わない開閉でも検索件数、highlight、active result を即時更新する
  - Webview 側は attachment details の page search 一時展開 key を、実際の描画と同じ `getMessageAttachments()` 後の filtered attachment index で作り、malformed attachment が混在しても render 側 key と collect 側 key がずれないようにする
  - Webview 側は render 中に必要になった追加 render / scroll restore を `requestAnimationFrame` の one-shot に逃がし、sessionData reload、session scoped reset、page search reset の境界では pending frame と callback を破棄して古い DOM anchor を新しい model に適用しないようにする
  - Webview 側は turn marker の collapse toggle を本文側の固定幅 slot ではなく、turn rail 上または rail-control lane に絶対配置し、`ターン N` の開始位置を余分に右へ押し出さないようにする。start marker には activity / status dot を出さない
  - Webview 側は同じ `turnId` が非連続に描画される場合、連続表示区間ごとに run key を付け、turn body の DOM id と `aria-controls` が衝突しないようにする
  - Webview 側の `live` mode running anchored chip は同じ turn 内の最後の意味ある表示カードの直後に、turnBlock 直下の独立 anchored row として描画する。user card 後も右寄せにせず、patch group / ファイル変更 card / sticky header の内部には入れない
  - Webview 側は anchored chip が viewport 外に流れた場合だけ左下 fixed の fallback sticky を表示し、fallback sticky から running turn へ移動できるようにする。fallback sticky の中身は Webview 内 running marker と同じ表示部品と同一 font size を使い、外側に user sticky と同系統の座布団 surface / border / shadow を敷く。座布団は outer surface 側の min-height と上下 padding で内側 marker より縦に大きく見せ、button baseline や theme 差で枠が潰れないようにする。本文カードより前面に出し、内容が dot だけに潰れないよう nowrap / width / z-index を明示する
  - Webview 側は running chip を user bubble 内や sticky user header 内へ入れず、sticky user header の切り替えとは独立させる
  - Webview 側は running chip の `実行中` を `開始` / `完了` と同系統の pill として表示し、`経過 N` と `最終活動 ...` は muted meta text として表示する。anchored row と左下 fallback sticky の中身は同じ marker 表示部品、同じ font size、同じ teal-green 系 running 色を使い、省略時は ellipsis と tooltip / title で全文を確認できる。fallback sticky は button の font shorthand で body size に戻さず、Webview 内 marker と同じ密度を維持する。経過時間 timer は1時間以上でも秒を表示し、現在描画中の running chip の elapsed text だけを更新してtimeline 全体は再描画しない
  - Webview 側は running chip の elapsed target 探索を現在の timeline / 表示中 fallback chip に限定し、表示 text / hidden state が変わった場合だけ tooltip / aria-label を更新する
  - Webview 側は狭幅で turn marker counts を視覚的に省略する場合も、件数 / token 補足を marker 本体の tooltip / aria-label に統合して参照可能にする
  - Webview 側は running chip に CSS の pulse dot を表示する。dot は start marker には出さず、anchored row では turn rail 側の左端、左下 fallback sticky では marker 先頭に同じ見た目で出す。`turnId` / `updatedAtIso` / `lastItemIndex` / `itemCount` から作る activity signature が変わった場合だけ `runningTurnChip-flash` を付ける
  - Webview 側は `runningTurnChip-flash::after` で短い border glint を出し、同じ activity signature 変化で update flash と一緒に 1 回だけ発火させる
  - Webview 側の pulse / flash / border glint / running marker dot pulse は layout shift を起こさない opacity / box-shadow / background / border overlay の変化に限定し、`prefers-reduced-motion: reduce` では無効化する
  - Webview 側は patch group の collapsed 表示を compact file summary にし、先頭 3 file rows、show more、`全差分を開く` / `全差分を閉じる` 操作を提供する
  - `全差分を開く` / `全差分を閉じる` は `review` という語を使わず、l10n key も `chat.patch.openAllDiffs` / `chat.patch.closeAllDiffs` 系の all-diff 用語に寄せる。tooltip / aria-label では「カードを全幅にして全ファイルの差分を開く」「全ファイルの差分を閉じて概要に戻す」まで説明する
  - all-diff mode の状態は patch group の stable `cardKey` 単位で Webview 内 UI state として持ち、JSONL、globalState、検索 index には保存しない。同一セッションの model reload では既存の UI state preserve 規則に従い、別セッションへ切り替わる場合は reset する
  - all-diff mode に入るときは、現在の `wideTimelineCardKeys` に対象 `cardKey` があるかを記録してから対象 card を全幅表示にする。all-diff mode 中は通常の card width toggle と競合しないよう、幅操作は all-diff toggle 側に集約し、閉じると記録した幅状態へ戻す
  - all-diff mode は全 entry を可視対象にし、各 entry を expanded として描画する。ただし `expandedPatchEntries` に全 entry id を恒久追加せず、mode 解除時は対象 group の個別 expanded state も閉じて compact summary に戻す
  - page search による一時的な patch group 展開は all-diff mode と別状態として扱う。検索の一時展開が発生しても `全差分を開く` の pressed state は変えず、all-diff mode 中に検索しても mode を解除しない
  - all-diff mode の diff body は既存の `renderPatchEntry` / deferred patch detail rendering を再利用し、loading / retry / detailsLoadFailed の表示も file 単位で維持する。オーバーレイ用に同じ diff DOM を二重生成しない
  - Webview 側は environment 行を軽量メタカードとして描画し、CWD など長い値は表示崩れしないよう省略 / 折り返しする
  - Webview 側は tool 実行メタ情報を tool カードの meta tag として表示し、status はローカライズ済みラベルへ正規化する
  - Webview 側は日付ガイド用 item に `attachmentKind` と attachment summary を渡し、添付あり message をガイド上で識別できるようにする
  - Webview 側の日付ガイド attachment summary では、最大 3 種類の要約、hidden unique kind 数の `+N`、必要時の総添付数 suffix を分けて扱う
  - Webview 側は IntersectionObserver で表示範囲付近の画像だけ data URI を要求し、セッション切替時は画像データキャッシュを破棄する
  - Webview 側の `saveImage` / `saveAttachment` message は現在の session `fsPath` を添えて送信し、host 側は stale / missing session request を保存処理から除外する
  - `follow` モードは、`liveRunningTurnId` / `latestTurnId` がある場合はその turn 内の live running marker、completed end marker、最後の意味ある `.row` の順に優先し、末尾が `patchGroup` の場合は直前の非 `patchGroup` 行を優先する。該当 turn の描画行がない場合は描画済み marker / visual target へフォールバックする
  - セッションタイムライン末尾ボタンは、`#timeline` に描画済みの最後の visual target へスクロールする。末尾が diff / patch group card、running marker、completed end marker、collapsed summary marker のいずれでも、現在の表示状態を尊重してそこへ移動する
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

### 4.11 ツール意味付けレイヤー

- `src/tools/toolSemantics.ts`
  - ツール名からカード表示用のメタ情報（アイコン・アクセント・ラベル）を解決する
  - `detailsOnly` / `compactCards` の表示モードを制御するビルダーを提供する
- `src/tools/toolTypes.ts`
  - ツール関連の共通型定義

### 4.12 ローカルファイルリンク

- `src/utils/localFileLinks.ts`
  - Webview / transcript 内のローカルパス文字列を VS Code URI に変換する
  - ワークスペース相対パス・行番号指定（`#L39`・`#L39-L45`・`#L39C2`）に対応する
- `src/transcript/transcriptDocumentLinkProvider.ts`
  - Markdown transcript ドキュメント上のリンクを `DocumentLinkProvider` として解決する

### 4.13 設定

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

### 4.14 ローカライズ

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

### 4.15 診断ログ

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

### 4.16 しおり / 日付ガイド実装

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
  - セッションタイムラインの日付ガイド item では `attachmentKind` を受け取り、添付あり / 画像のみ / mixed の dot ring を描画する
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

### 5.2.1 検証

```powershell
# TypeScript の型を検証します
npm run typecheck

# ローカライズと Webview JavaScript の構文を検証します
npm run lint

# 差分に不要な空白エラーがないことを確認します
git diff --check
```

### 5.3 VSIX 作成

```powershell
# VSIX を作成します
npm run package
```

- `scripts.package` は `vsce package --allow-missing-repository` を実行する
- 公開配布を前提にする場合は `repository` を正しく設定することを推奨する
- README用の `media/screenshot*.png` は配布VSIXへ含めない。README内の画像はpackage時にremote URLへ変換されるため、`.vscodeignore`で除外する
- ローカル最終確認用の `.root-review-*` は `.gitignore` と `.vscodeignore` の双方で除外する。リリース前は完成したVSIXを展開し、private docs、test、source map、別VSIX、レビュー用一時ファイルが混入していないことを確認する

### 5.4 v2.8.0 リリースメモ（2026-07-21）

**追加された機能**

- History ビューの現在条件を固定 snapshot として集計する History Insights を追加した。推論トークン / 変更イベント数を含む概要、推論トークンを選択できる活動ヒートマップ、ソース / モデル / プロジェクト / ツール内訳、指標別のアクティブセッション、変更頻度が高いファイル、入力キャッシュと推論 / メッセージ構成 / ターン状態 / 変更ファイル種別の利用詳細、データ品質を editor Webview で確認できる
- History Insights から、両端包含の日付範囲、複数の関連プロジェクト、ソース、Codex の保存場所、タグをまとめて適用できるようにした。既定では History 条件を変更せず、明示的に `履歴にも適用` を選択した場合だけ同じ条件を History へ反映する
- History Insights と Claude Branch Navigation が共用する Session Analysis Index を追加した。更新されたセッションだけを lazy 解析し、通常の履歴キャッシュ / 検索インデックスとは独立して管理する
- Codexアプリの`ローカルにフォークする`またはCodex拡張機能の`新しいタスクで続ける`で作成されたdirect / nested Forkを検出し、Codexセッションビュー内の前後操作と経路ツリーoverlayから切り替えられるCodex Branch Navigationを実験的機能として追加した。`新しい Worktree にフォークする`は2.8.0では非対応とした
- Claude セッションビュー内で分岐先を切り替え、履歴の開始、分岐点、各履歴の開始 / 末尾を経路ツリー overlay で確認できる Claude Branch Navigation を実験的機能として追加した
- Codex の親セッションとサブエージェント実行を専用アイコンと右側の関係ツリーで確認し、各 node から対応するセッションを開ける Agent Runs を実験的機能として追加した
- 管理の `Rebuild Cache` で履歴キャッシュ、検索インデックス、Session Analysis Index をまとめて再作成できるようにした

**変更された機能**

- History の条件モデルへ任意の日付範囲と複数プロジェクト選択を追加し、History Insights の drill-down と History への一括適用で同じ検証・永続化規則を使うようにした
- History Insights の source / model / project 内訳は、選択した共通指標と単位で比較できるようにし、Codex のモデル行では取得できた範囲の推論レベル別 token 内訳を展開できるようにした
- History Insights の tool 内訳は呼び出し回数 / 利用セッション数、アクティブセッションはユーザー依頼数 / ツール呼び出し数 / 推論トークン数 / 合計トークン数 / 変更行数で切り替えられ、アクティブセッション行から対象セッションを直接開けるようにした
- History Insights に利用詳細を追加し、入力キャッシュと推論、メッセージ構成、ターン状態、変更ファイル種別ごとのファイル数 / 変更イベント数を確認できるようにした
- セッションビューと History Insights のファイル種別判定と表示 CSS を共有し、同じ path が画面ごとに異なる種別へ分類されないようにした
- Session Analysis の message / turn / tool / patch / usage は既存 Chat model の抽出規則を再利用し、Search、bookmark、File AI Change History と共通の message index を維持するようにした
- `Empty Trash` の旧世代 cache 整理対象へ Session Analysis Index を追加し、現行 `session-analysis-index.v1.json` は削除しないようにした

**修正された機能**

- History の source を Claude のみに切り替えたとき、適用不能な archive 条件を実効値 `すべて` にしつつ、直前の Codex 用 archive 条件は失わず、Codex / All へ戻したときと再起動後に復元するようにした
- History Insights panel を閉じて開き直した場合、旧 panel の非同期解析結果や進捗が新しい panel へ混入しないようにした
- History Insights の再open、現在条件の適用、フィルター適用が重なった場合も、snapshot、History条件、panel表示を開始順に確定し、旧loadの後着保存や後発操作の消失を防ぐようにした
- History Insights の外部再解析を既存modelを保持するtoast表示へ統一し、stale / error状態で言語を変更しても旧modelが復帰しないようにした
- History Insights の2秒を超える解析へキャンセル可能なVS Code進捗通知を追加し、短時間処理では表示せず、panel遷移・破棄後に旧通知を残さないようにした。過去のキャンセルは後から明示したopen／条件適用へ引き継がず、遷移待機中はcancel／retryの最後の利用者意図だけを新stateへ反映する
- History Insights のsession横断token・変更行数・内訳合計をsafe integerへ飽和させ、overflowを下限値として表示するようにした。欠損session混在時のproject drill-downも解決可能なreferenceへfallbackする
- History Insights をアクティブにしたまま `Developer: Reload Window` を実行すると、serializer 復元直後の初期空 index を対象セッションの消失と誤判定し、snapshot が空で保存されて `対象セッションがありません` となり、`再集計`でも回復できない問題を修正した。復元時は初回 full History refresh 後の authoritative inventory を待ち、refresh 失敗や待機中の cancel では保存 snapshot を維持するようにした
- 検索中の History filter / scope、project association、関連設定、Auto Refresh、手動 refresh、cache maintenance が実行中検索を暗黙に終了させる問題を修正した。検索開始時の設定、条件、readonly inventory、Search Index read snapshot で一度完走し、filter由来の自動再検索は公開後に最新条件で1回だけ実行するようにした。実行中検索の通常の中断条件は明示キャンセルと新しい検索開始だけに戻した
- `Rebuild Cache` と `Rebuild Search Index` は、開始時の設定とreadonly inventoryを固定して、途中のAuto Refresh、filter / scope、関連設定、index generation変更では中止しないようにした。明示maintenance同士を共通queueで直列化し、全キャッシュ再作成では同じinventoryをHistory、Search、Analysisへ渡すようにした
- Branch Navigationのpending通知ではセッションタイムラインを再描画せず、最終的なinline timelineに実差分がある場合だけ再描画するようにした。再描画時はWebview内検索をsemantic anchorから復元し、hitが消失した場合は近傍へfallbackしつつ、閲覧中anchorを可能な範囲で維持する
- 破損したHistory V2 filter stateをfail-closedで復旧するとき、独立したCodex archive preferenceを`通常のみ`で上書きしないようにした
- Session Analysis の同時利用者を共有解析jobへ統合し、一方のキャンセルで他方の解析を中断したり同じsessionを重複解析したりしないようにした。全利用者がtemp保存中にキャンセルした場合はcommit前に破棄し、commit境界後は成功結果とdisk / memory公開を分離しない。model usageは2,000件で決定的に制限し、raw tokenの負数・少数・非数値・unsafe値とtoken加算overflowは0へ変換せず部分解析として隔離する
- JSON の best-effort atomic write は、rename 失敗後の直接書き込み直前にも commit guard を再確認し、処理が失効していれば stale な結果を公開しないようにした。直接書き込みが失敗した場合も一時ファイルを best-effort で回収する
- Claude Branch Navigation は、同文の親を持つ別rootの子を誤って同一分岐へ統合しないようcanonical parent identityをrootから確定するようにした。未解決・衝突parentは切替候補から除外し、cycle検出とdepth付与を非再帰O(N)へ変更した
- Agent Runs / Codex・Claude分岐のoverlayは、画像preview、候補一覧、分岐preview、overlay本体の順にEscape 1回で1層だけ閉じ、暗い背景へfocusが移っても操作できるようにした
- Codexセッション開始時の推奨plugin、AGENTS指示、権限・実行mode、environmentなどの注入contextがraw user messageとして見える問題を修正し、内容変更に耐える構造判定と折りたたみカードへ置き換えた。検索・title・分析・Fork evidence用cacheはalgorithm / parser version更新で再生成する
- セッションビューのsticky user headerは、元cardの下端と次user cardの上端を基準に切り替え、全文summaryをtooltip、操作説明をaria-labelへ分離した
- turnの所要時間とrunning chipの経過時間は、1時間以上でも秒を省略せず、`1時間03分5秒` / `1h 03m 5s`形式で表示するようにした
- Branch Navigation / Agent Runsの専用表示commandとセッション右クリック項目を削除し、現在のセッションビューのヘッダー／タイムライン操作からだけ開くようにした。Agent Runsの`親セッションを開く`は維持した
- Codex使用量の`used_percent`は2.7.0互換で有限な非負小数を保持し、usage percentageとSession Analysisのrate limit snapshotから小数値が消えないようにした
- Session Analysis の上限、壊れた JSONL、取得不能な指標を部分値 / 不明として扱い、確定した 0 と混同しないようにした
- 配布するMarkdown rendererを`markdown-it@14.3.0` / `linkify-it@5.0.2`へ更新し、fuzzy emailと`mailto:`自動検出を無効にするfail-closed対策もdefense-in-depthとして維持した
- `package.json` / `package-lock.json` のバージョンを `2.8.0` に更新した

### 5.5 v2.7.0 リリースメモ（2026-07-02）

**追加された機能**

- Codex JSONL の `task_started` / `task_complete` / `turn_aborted` / `thread_rolled_back` / `patch_apply_end` / `token_count` を使い、セッションタイムラインに Codex turn の start marker、end marker、turn rail を表示するようにした
- turn は `ターン N` として表示し、full `turn_id` は tooltip / aria-label で確認できるようにした
- turn end marker に item 数、tool 数、変更数、入力 / 出力 / 合計 token を表示するようにした。token 合計がない場合は usage 記録件数へフォールバックする
- turn end marker に完了までの所要時間を表示し、`live` mode の running chip には開始からの経過時間と最終活動時刻を表示するようにした
- completed turn を手動で折りたたみ / 展開できるようにした。折りたたみ中は `開始` / `終了`、開始時刻、終了時刻、所要時間、counts / token summary を collapsed summary marker に集約する
- `live` mode の実行中 turn は、最後の意味あるカード直後の turn rail 基準 anchored row と、anchored row が viewport 外へ流れたときだけ出る左下 fallback sticky で表示するようにした
- `live` mode の running chip に控えめな activity cue を追加し、実行中は小さな dot が pulse し、進捗更新時だけ短く flash するようにした。start marker 側の dot は廃止し、anchored row と左下 fallback sticky で同じ running dot を使うようにした
- running chip の進捗更新時に、枠へ薄い border glint が 1 回だけ流れるようにした
- patch group card の collapsed 表示を compact file summary にし、先頭 3 file rows と `あと N 個のファイルを表示` / `表示を減らす` を表示するようにした。全ファイルの差分をまとめて開く追加操作は、`レビューする` ではなく `全差分を開く` / `全差分を閉じる` として card 内 in-place all-diff mode で扱うようにした
- 自動更新 `follow` は、`liveRunningTurnId` / `latestTurnId` がある場合、その turn 内の live running marker、completed end marker、最後の意味あるカードの順に追従するようにした。手動で折りたたまれた completed turn は勝手に展開せず、collapsed summary marker へ fallback する
- Claude Code の `<task-notification>` を task notification card として表示し、`summary`、`result`、`usage` を raw tag なしで読めるようにした
- Claude Code の assistant message に raw text として残る `<invoke>` を tool invocation card として表示し、tool 名、description、parameter を展開して確認できるようにした

**変更された機能**

- parser は JSONL だけで決まる永続状態を構築し、live 表示の `running` は `chatTurnTimelineMode=live` の場合だけ `ChatPanelManager` が active Codex root、archive 状態、mtime、auto-refresh 観測状態から付与するようにした
- Codex turn は `task_started` を主シグナルとして開始し、`turn_context` は model / effort と active turn の補助観測に限定するようにした
- `token_count` usage は active turn、明示 `turn_id`、explicit unknown terminal 由来の scoped block、直近 completed turn の順で turn を解決し、`task_complete` 後に末尾 usage が来る場合も直近 turn に含めるようにした
- turn token 合計は `last_token_usage` 相当の usage item を合算し、累計値になり得る `total_token_usage` を直接合算しないようにした
- item を持たない turn を表示から除外しても `sequenceNumber` を再採番せず、同じ `turnId` の `ターン N` が reload / filter 状態で変わらないようにした
- turn_id なしの重複 `task_complete` では直近 completed turn の latest fallback を維持し、explicit unknown `task_complete` では古い completed turn への trailing usage 誤帰属を止めるようにした
- terminal 済み turn は、後続 `task_started` の timestamp が既存 terminal timestamp より明確に新しい場合だけ `incomplete` へ戻すようにした。terminal timestamp 欠落時や同一 timestamp では、重複 event として扱い status を戻さない
- turn_id なしの `task_started` で古い active turn への帰属を解除し、非 active の environment-only turn が空 marker として表示されないようにした。live 観測中の active turn は environment だけを持つ段階でも running 表示用に保持する
- sticky user header は、次の user card の上端が sticky 表示領域に到達した時点で次の user に切り替えるようにした
- running chip の `実行中` は `開始` / `完了` と同系統の pill として表示し、`経過 N` は `最終活動 ...` と同じ muted meta text として表示するようにした
- running chip の経過時間 timer は、現在描画中の chip の elapsed text だけを更新し、timeline 全体を 1 秒ごとに再描画しないようにした
- running chip の `startedAtIso` が未来時刻になる clock skew 状態では `経過` を一時的に省略し、timer は live running turn の存在を基準に継続して、時計が追いついた後に reload なしで `経過` が復帰するようにした
- `task_complete` / `turn_aborted` / `thread_rolled_back` が未知 turn に対して来た場合、item を持たない幽霊 turn や stale `latestTurnId` を作らず、実在する item-backed turn だけを latest / follow / trailing usage の対象にするようにした
- Webview 内検索の検索シード、role filter 変更、一時展開後の再検索で、意図した hit または viewport 近傍を維持し、常に先頭 hit へ戻らないようにした
- Webview 内検索の pending refresh intent に描画内容 revision を含め、session reload / detail toggle / path mode toggle 後の古い intent を stale として扱うようにした
- Webview 内検索の一時展開 state を turn / patch group / attachment details で一元的に reset し、turn timeline off や検索解除後に attachment details だけ stale force-open されないようにした
- Webview 内検索中の turn collapse、message 展開、patch group file list、patch entry details、usage card、attachment details の開閉を content mutation helper 経由に寄せ、active result anchor を保ったまま再検索するようにした
- attachment details の開閉 state key は、描画で使う filtered attachment list の ordinal を使い、同一 message 内の同一内容 notification / invoke でも別 details として扱うようにした
- sessionData reload や reset 境界では、render 中に予約された deferred render / scroll restore を破棄し、古い DOM anchor 由来の scroll restore が reload 後に走らないようにした
- running chip は user bubble 内や sticky user header 内ではなく、turn rail 基準の anchored row または左下 fallback sticky として表示し、どちらも中身は同じ marker 表示部品、同じ font size、同じ teal-green 系 running 色に揃えるようにした。fallback sticky は外側に user sticky と同系統の座布団 surface を敷き、min-height と上下 padding で細い枠に見えない余白を確保し、本文カードより前面に出して内容が潰れないようにした
- turn marker の collapse toggle を turn rail 上または rail-control lane に寄せ、start marker には activity / status dot を出さず、`ターン N` の開始位置に余分なインデントが出ないようにした
- 同じ `turnId` が非連続に描画される場合も、連続表示区間ごとの run key で DOM id / `aria-controls` が衝突しないようにした
- 狭幅で turn marker counts を非表示にする場合も、件数 / token 補足を marker 本体の tooltip / aria-label で確認できるようにした
- running chip の elapsed target 探索を現在の timeline / 表示中 fallback chip に限定し、表示 text / hidden state が変わった場合だけ tooltip / aria-label を更新するようにした
- running chip の update flash は activity signature が変わった場合だけ出し、初回描画、scroll、resize、anchored / fallback の表示切り替えだけでは出さないようにした
- running chip の border glint は update flash と同じ発火条件に揃え、枠全体が常時回転する表現にはしないようにした
- ファイル履歴 Webview の検索結果 badge は、所属 card の mixed timeline 番号 `#N` を常時表示し、diff 本文 hit では `変更前 L...` / `変更後 L...` の行番号 badge も表示するようにした
- ファイル履歴 Webview の検索結果 badge は、検索パネル幅が不足する場合に diff 行番号 badge の visible text を `L...` へ圧縮し、tooltip / aria-label では変更前 / 変更後を保持するようにした
- ファイル履歴 Webview の mixed timeline 番号は `model` message 受信時に `card.id` Map として作成し、render / date guide / 検索結果 / source toggle 復元で同じ番号を参照するようにした
- ファイル履歴 Webview の compact badge 切り替えは CSS container query に寄せ、render 後の overflow 測定による強制 reflow を避けるようにした
- ファイル履歴 Webview の mixed timeline lookup は `card.id -> index` / `card.id -> card` を共有し、`resetUi` 後の一時 render でも `#N` が visible index へ戻らないようにした
- ファイル履歴 Webview の検索結果 occurrence は `cardId -> count` Map で生成し、大量 hit 時に既存 results 全体を繰り返し走査しないようにした
- ファイル履歴 Webview の load more で hidden source の card だけが追加された場合、非表示中 source 用の toast を表示し、全候補解析完了時に無反応に見えないようにした
- Claude structured attachment 抽出は、task notification / invoke で共通の bounded block scanner と Markdown safe-context map を使うようにした。引用された tag は本文として残し、境界が曖昧な block は raw text として残す
- Claude structured attachment 抽出の close 解決を open / close candidate 配列ベースにし、close が欠落した `<invoke` / `<task-notification>` が大量にある履歴でも二乗時間に伸びないようにした
- Markdown transcript / Search / Resume / Handoff / Webview の attachment field 選択を用途別 policy に寄せ、raw/debug 用の内部 field を通常経路へ流さないようにした
- task notification の `duration_ms` 表示を Webview と Markdown transcript / summary で同じ compact duration 表記に揃え、`1500 ms` と `1.5s` のような経路差が出ないようにした

**修正された機能**

- `task_complete` がない古い session や異常終了 session を、履歴ビューで永続的に `running` と誤表示しないようにした
- raw `<turn_aborted>` を active turn にフォールバックして紐づけ、structured event と同じ turn summary に反映するようにした
- 遅延 flush される patch group の turn 集計を、item index の連続範囲ではなく `turnId` 帰属で計算するようにした
- `turn_context` の `turn_id` を未使用状態として保持せず、active turn の補助観測として実処理へ接続した
- running anchored row が patch group / ファイル変更 card や sticky header の内部に入り込まず、turn rail 基準の独立行として表示されるようにした
- collapsed summary marker は狭い viewport でも `ターン N`、toggle、`開始` / `終了` badge を 1 行で維持し、token summary などの末尾情報を先に ellipsis または非表示にして、横スクロールや隣接 marker との重なりを起こさないようにした
- `Show details` ON/OFF や Webview 内検索 close で、collapsed summary marker などの marker を見ているときも隣接する本文 row へ飛ばず、同じ marker 付近へ戻るようにした
- Webview 内検索で query による turn / patch group の一時展開が発生しても、検索結果への明示移動がない場合は現在見ている card / marker の位置を維持するようにした
- timeline 末尾の card / marker が Webview 下端に貼り付かないよう、通常時も小さな下部余白を確保し、末尾スクロール / `follow` の着地点にも card / marker 種別に応じた下端余白を残すようにした
- ファイル履歴 Webview の表示順をセッション開始時刻ではなく diff card の変更時刻で全体 sort し、長時間 Claude session の新しい変更が古い位置へ混入しないようにした
- ファイル履歴 Webview の `続きを読み込む` と source toggle で、変更時刻 sort 後も閲覧中 card 付近へ scroll を復元するようにした
- ファイル履歴 date guide の major tick に mixed timeline 番号の `#N` / `#N-#M` を表示し、minor tick は dot のみ表示しつつ tooltip / aria-label に card 番号を保持するようにした
- `prefers-reduced-motion: reduce` では running chip の pulse / flash / border glint と running marker dot pulse を止め、静的な running 表示だけにするようにした
- Claude Code の `queue-operation` / `queued_command` に含まれる task notification が、materialized user message と二重にカード化されないようにした
- task notification / invoke の内部 field、ローカル `outputFile`、system / harness preamble、task id、tool-use id、定型 note が Webview model に流れないようにした
- `<result>` 内の `<status>` / `<usage>` 風 text や fenced / quoted の `<task-notification>` / `<invoke>` が、top-level field や card として誤抽出されないようにした
- close が欠落した `<invoke` / `<task-notification>` が大量に含まれる病的な Claude message で、セッションタイムライン表示、検索インデックス、Markdown transcript、Resume / Handoff 生成が数秒単位で固まる可能性を抑えた
- attachment details の開閉直後に、Webview 内検索の件数、highlight、active result が古い DOM のまま残らないようにした
- malformed attachment が notification / invoke の前に混在しても、Webview 内検索の一時展開 key と描画側 details key が同じ ordinal を使い、検索で該当 attachment details を展開できるようにした
- session reload 直前に render 中 deferred render が予約されていても、reload 後に冗長 render や古い scroll restore callback が走らないようにした
- basic mode の末尾 incomplete turn では terminal end marker を出さず、`End / 未完了` のような誤解を招く終了表示にならないようにした
- reduced-motion でも elapsed text は表示単位に合わせて更新し、pulse / flash / transition だけを抑制するようにした
- turn token summary では `Input + Output` から導ける冗長な `Total` を compact marker から省略し、total が追加情報を持つ場合だけ表示するようにした
- patch details の lazy-load 成功 / 失敗と deferred patch render を page-search content mutation helper 経由に寄せ、検索中の active result anchor を保ったまま再検索できるようにした
- page-search temporary expansion の clear、query 取得、render 後 restore dispatch の小さな重複を整理し、状態変化がない場合の余分な render を減らした
- `package.json` / `package-lock.json` のバージョンを `2.7.0` に更新した

### 5.6 v2.6.1 リリースメモ（2026-06-22）

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

### 5.7 v2.6.0 リリースメモ（2026-06-12）

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

### 5.8 v2.5.1 リリースメモ（2026-06-10）

**修正された機能**

- `Empty Trash` が現行の `cache.v9.json` を旧世代キャッシュとして削除し得る問題を修正した
- 履歴キャッシュ / 検索インデックスの現行ファイル名を `src/storage/cacheFiles.ts` に一元化し、書き込み先と保守処理の drift を防ぐようにした
- 履歴キャッシュ / 検索インデックスの JSON parse error を missing / read error と切り分け、破損時は退避せず削除して再生成できるようにした
- JSON 書き込みを一時ファイル経由の best-effort atomic write に変更し、rename に失敗する provider では直接書き込みへフォールバックするようにした。古い孤立一時ファイルは `Empty Trash` で内部的に回収できるようにした
- `package.json` / `package-lock.json` のバージョンを `2.5.1` に更新した

### 5.9 v2.5.0 リリースメモ（2026-06-07）

**追加された機能**

- **プロジェクト関連付け**を追加した。別プロジェクトの履歴を現在のプロジェクトに紐づけて表示したり、関連プロジェクトとしてまとめて扱える
- 履歴ビュー / ピン留めビューに、**一覧表示 / プロジェクト別表示** と、**すべて / 現在のプロジェクトグループ** の切り替えを追加した
- 検索履歴を追加した。全体検索、履歴ビュー内検索、ファイル変更履歴の検索で、検索語の履歴を共有できる
- 検索結果を開いたとき、同じ検索語を履歴ビュー内検索に引き継げるようにした
- 履歴ビュー内検索とファイル変更履歴の検索で、正規表現や完全一致など、より柔軟な検索表現に対応した
- 履歴ビュー内検索とファイル変更履歴の検索に、検索履歴候補の表示・選択・削除を追加した
- Codex のメモリー引用情報を、履歴ビュー内で折りたたみ表示できるようにした
- セッションタイムラインで、現在のユーザープロンプトを上部に追従表示できるようにした
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

### 5.10 v2.4.1 リリースメモ（2026-05-26）

- プロジェクト (`cwd`) に、この拡張機能内だけの別名を設定 / 消去できるようにした
- プロジェクト別名は History / Pinned のプロジェクト見出し、セッション行、tooltip、絞り込み表示、Status、Search の scope / セッション表示に反映する
- プロジェクト別名は検索 hit 対象には含めず、検索結果 root の scope label は次回検索または `Rerun Search` 時に更新する
- Project node の contextValue を CWD 有無で分け、CWD なしプロジェクトには別名メニューを出さないようにした
- 実験的な opt-in 設定 `webview.restoreAfterReload = true` で、通常履歴 Webview とファイル履歴 Webview を Reload Window / VS Code 再起動後に復元できるようにした
- Webview 内検索の入力を debounce し、通常履歴 Webview / ファイル履歴 Webview の検索中の入力負荷を抑えた
- 通常履歴 Webview / ファイル履歴 Webview の検索パネルがウィンドウ幅 860px 以下で強制的に画面全幅になり、リサイズハンドルが消える挙動を修正した
- Webview 復元時に、通常履歴 Webview は最後に見ていた message 付近、ファイル履歴 Webview は最後に見ていた card 付近へ戻るようにした
- セッション Webview で `::code-comment{...}` directive をレビューコメントカードとして表示し、comma 区切りや複数行、未知 segment を含む出力も既知キーから復元できるようにした
- `package.json` のバージョンを `2.4.1` に更新した

### 5.11 v2.4.0 リリースメモ（2026-05-23）

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

### 5.12 v2.3.0 リリースメモ（2026-05-22）

- セッションメッセージの添付モデルを `attachments` に統合し、画像も `type: "image"` の attachment として扱うようにした
- Claude Code の `type: "document"` を document card として表示できるようにした
- Claude Code の PDF document は PDF card、text document は text card、unknown document は generic document card として表示するようにした
- Claude text document の preview / search / Save As に上限を設け、巨大 text / binary payload を初期 Webview model へ渡さないようにした
- Claude Code の `<ide_opened_file>` / `<ide_selection>` を本文から除去し、file reference / selection reference card として表示するようにした
- Claude Code 公式の `<ide_opened_file>The user opened the file ... in the IDE...</ide_opened_file>` 形式に対応し、拡張子なしの well-known text file を text kind として扱うようにした
- Codex の `# Files mentioned by the user:` block を解析し、file reference card に変換するようにした
- Codex の `## My request for Codex:` 以降だけを本文として残し、区切りがない variant は安全に判定できる場合だけ file block と本文を分離するようにした
- Codex file reference は参照先ファイルを自動で読まず、履歴に保存された label / path / line 情報だけを使うようにした
- Word / Excel / PowerPoint / PDF / zip / 任意拡張子を file reference として扱えるようにした
- セッションタイムラインの attachment card は file kind badge、ファイル名、action icon 中心の compact 表示にし、path / MIME type / byte size は tooltip へ寄せた
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

### 5.13 v2.2.0 リリースメモ（2026-05-21）

- Codex の通常 `sessions` に加えて、任意で `archived_sessions` を読み込めるようにした
- `codexHistoryViewer.codex.archivedSessions.enabled` と `codexHistoryViewer.codex.archivedSessionsRoot` を追加した
- `sources.enabled` は `codex` / `claude` の最上位ソース設定のままとし、`codex` が含まれる場合だけ archived sessions 設定を適用するようにした
- 設定 UI では `Sources: Enabled` を先頭に置き、Codex archived sessions 設定がその子設定だと分かるようにした
- archived sessions root の既定値を、Codex `sessionsRoot` と同階層の `archived_sessions` にした
- History / Pinned / Search に `通常のみ` / `すべて` / `アーカイブのみ` のアーカイブ表示切り替え view title action を追加した
- `通常のみ` のときは、History / Pinned / Search から archived Codex session を即時に除外するようにした
- Search はアーカイブ非表示時に archived hit を候補から除外し、表示される hit 数が `search.maxResults` に達するようにした
- Codex archived session を History / Pinned / Search / Markdown / セッションビューで通常 session と区別できるようにした
- Markdown transcript に `Location: Active` / `Location: Archived` を表示し、セッションビューでは archived Codex session を `Archived` 表示で識別できるようにした
- archived Codex session のセッションビューでは、`Resume in Codex` の代わりに `Move to Codex History` を表示するようにした
- active Codex session の右クリックメニューに `Move to Archive` を追加した
- archived Codex session の右クリックメニューに `Move to Codex History` を追加した
- 移動系 action は active / archived で相互排他にし、カスタムタイトル系 action の下、Delete より上に区切って配置した
- archived Codex session では `Resume in Codex` と `Promote to Today (Copy)` を表示しないようにした
- `Move to Archive` は公式 Codex provider の `thread/archive` を使うようにした
- `Move to Codex History` は公式 Codex provider の `thread/unarchive` を優先し、使えない場合は filesystem provider の Move に fallback するようにした
- filesystem restore では作成日の `<YYYY>/<MM>/<DD>` へ戻し、同名衝突時は suffix を付けるようにした
- filesystem restore の Move には Undo を提供し、公式 provider restore では本家状態との整合を優先して Undo を出さないようにした
- restore / archive / pin reconcile 時に、annotation / bookmark / chat open position を移動先 path へ寄せるようにした
- archive / unarchive 時の bookmark key 移行で target hash を維持し、Webview で同じしおりとして認識できるようにした
- archived セッションビューの `Move to Codex History` は `chat.openPosition = lastMessage` のとき操作直前の表示位置へ復元後に移動するようにした
- Export した Markdown transcript にも `Location: Active` / `Location: Archived` を出すようにした
- metadata relocation の衝突時は、annotation note と chat open position で移行先を優先するようにした
- pin に `identityKey` / `archiveState` / `rootKind` を追加し、公式側でアーカイブされた Codex session の path 変更へ追従できるようにした
- archived sessions が無効または非表示のとき、archived 由来 pin を Pinned の missing として表示せず、Status の missing pin count にも含めないようにした
- Status に、Codex source と archived sessions がどちらも有効な場合だけ Codex archived session count と Codex archived sessions root を表示するようにした
- Auto Refresh で archived root の `rollout-*.jsonl` も監視できるようにした
- 履歴キャッシュを `cache.v9.json` に更新し、archived root / archived 有効状態 / identity dedupe を含めるようにした
- 検索インデックスの context に archived root / archived 有効状態を含めるようにした
- `package.json` のバージョンを `2.2.0` に更新した

### 5.14 v2.1.0 リリースメモ（2026-05-19）

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
- セッションビュー内の軽量コピー機能は `Copy Quick Prompt` / `簡易プロンプトをコピー` とし、完全な Handoff と役割を分離した
- `package.json` / `package-lock.json` のバージョンを `2.1.0` に更新した

### 5.15 v2.0.1 リリースメモ（2026-05-15）

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

### 5.16 v2.0.0 リリースメモ（2026-05-14）

- ワークスペース内のファイルを起点に、Codex / Claude の diff 履歴を時系列で確認できる File AI Change History を追加した
- カスタムタイトル操作を QuickPick 入口へ統一し、セッションビューのヘッダーからも設定 / 消去できるようにした
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

### 5.17 v1.5.1 リリースメモ（2026-05-08）

- 自動更新 `follow` で、末尾が grouped diff カードの場合に本文追従が diff に奪われないよう、直前の非 diff カードを追従対象にするようにした
- 自動更新 `follow` では pending のカードアンカー復元より追従を優先し、レイアウト更新後に追従位置がずれにくいよう再スクロールするようにした
- `chat.openPosition = lastMessage` で、画面内に本文メッセージがない位置の保存や、復元対象メッセージが描画されない場合に、直前の描画済み本文メッセージまたは先頭へフォールバックするようにした
- `chat.openPosition = latest` で、移動先指定のないセッションタイムライン表示を最新の描画済み visual target から開けるようにした
- セッションタイムライン末尾ボタンは最後に描画された visual target へ移動するため、末尾の diff / patch group card、running marker、completed end marker、collapsed summary marker そのものを確認できる
- Codex の `custom_tool_call` を、`toolCalls` / `toolCallsAndOutputs` の検索インデックスに軽量メタとして含めるようにした
- `custom_tool_call` の patch / diff 本文は検索インデックスに入れず、対象ファイルや command など検索の入口になる情報だけを入れるようにした
- 検索インデックスの cache version を更新し、既存 cache は次回検索時に自動再構築されるようにした

### 5.18 v1.5.0 リリースメモ（2026-05-07）

- Codex / Claude セッションに対して、この拡張機能内だけのカスタムタイトルを設定 / 消去できるようにした
- カスタムタイトルは History / Pinned / セッション Webview のタイトルへ反映し、詳細ツールチップではオリジナルタイトルも確認できるようにした
- ツリー項目ツールチップの表示量を `full` / `compact` / `titleOnly` から選べるようにした
- 検索インデックスに保存するツール情報の範囲を `conversationOnly` / `toolCalls` / `toolCallsAndOutputs` から選べるようにした
- `Rebuild Search Index` コマンドを追加し、検索インデックス設定変更時に再作成へ誘導するようにした
- Status に拡張機能バージョンを表示するようにした

### 5.19 v1.4.3 リリースメモ（2026-04-30）

- `SECURITY.md` を追加し、`markdown-it` の GHSA-38c4-r59v-3vqw / CVE-2026-2327 について、v1.2.2 以降は `markdown-it@14.1.1` を同梱していることを明記した
- v1.2.1 以前の古い VSIX をインストールまたは再配布しないよう、セキュリティポリシーに明記した
- History の初回ロード中に、履歴 0 件の案内が先に表示されないよう、読み込み中ノードを表示するようにした
- Pinned の初回ロード中に、欠損ピンが先に表示されないよう、読み込み中ノードを表示するようにした
- 起動時の履歴キャッシュ / 検索インデックス処理前に、拡張機能の global storage ディレクトリを作成するようにした

## 6. 手動テスト観点

- History ビューのタイトルメニュー / Command Palette から History Insights を開くと、起動時の History 条件に一致するセッションだけが集計される
- History Insights を開いた後に History 条件や履歴ファイルが変わっても対象集合は自動で増減せず、`再集計` は同じ snapshot、`履歴の条件を適用` は現在の History 条件から作り直した snapshot を使う
- History Insights のフィルターで From / To の片側開放・両端指定、複数プロジェクト、ソース、Codex の保存場所、タグを組み合わせて適用でき、不正日付、From > To、未選択 source は状態を変えずエラーになる
- History Insights のフィルターを `適用` せず閉じた場合は draft だけが破棄される。`履歴にも適用` が非選択なら History / Search 条件は変わらず、選択中に `適用` した場合だけ全条件が History へ反映される
- History Insights のフィルター適用後に Reload Window を実行しても、適用済み snapshot と、`履歴にも適用` を選択した場合の History 条件が一致して復元される
- 保存 snapshot を持つ History Insights をアクティブにしたまま `Developer: Reload Window` を実行しても、非アクティブのまま Reload 後に選択した場合と同じ対象集合が初回 full History refresh 後に復元され、`対象セッションがありません`へ誤遷移せず、`再集計`が同じ対象集合で動作する
- fresh History cache の採用直後または HistoryService の初期空 index では保存 snapshot を空で上書きしない。初回 full refresh の失敗、待機中の cancel / panel close / state 置換でも保存 snapshot を維持し、authoritative な full scan が正当に 0 件を返した場合だけ対象 0 件へ確定する。serializer 復元以外の通常 open / 条件適用は current index から従来どおり開始する
- History Insights のフィルター適用中に History ビューのタイトルメニューまたは Command Palette から再度開いても、適用途中の snapshot が割り込まず、完了後の History 条件と保存・表示される snapshot が一致する。`履歴にも適用` が非選択または適用失敗の場合は変更前の History 条件から開く
- Historyの`絞り込み解除`では日付、source、tag、archive locationが1回の適用で既定値へ戻り、scopeが`all`なら`ProjectSelection.all`へ戻る。scopeが`currentGroup`ならscopeと現在group selectionを維持し、途中条件や一部だけの旧値を表示しない
- Historyの対象範囲を`現在のプロジェクトグループ`にしてReload Windowを実行すると、家アイコン、More Actionsの現在表示、対象セッション、History / Searchの説明が同じcurrent-group状態で復元される。家アイコンを1回押すと地球アイコンと全件へ、もう1回押すと家アイコンと現在groupへ切り替わる
- `currentGroup`中に日付、source、tag、archive location、表示形式、表示モード、sortを変更してもscopeと家アイコンを維持する。詳細project picker、History Insightsの`履歴にも適用`、日付 / project drill-downでproject selectionを明示適用した場合は地球アイコンへ切り替わり、Reload後もV2 selectionとscope表示が一致する
- source切替とtag変更などを保存待ち中に連続操作しても、後の操作が先に確定した別fieldを旧値へ戻さない。同じsource toggleを連打した場合も、各操作をqueue内の確定stateから順に計算する
- More Actionsから`すべて` / `現在のプロジェクトグループ`を直接指定した場合も1回で対象とアイコンが一致し、現在値の再指定はno-opになる。workspaceが無い状態、association再読込、保存失敗時にもV2、scope、providerの一部だけが切り替わらない
- `currentGroup`中に現在workspaceとは別groupの明示selectionが残る不整合を作った場合、非project条件変更または再読込でselectionを別groupへ置き換えず、scopeだけ`all`へ正規化する。関連付け追加 / 解除 / 種類変更の直後にもcurrent-group selectionを再解決し、保存失敗時は関連付けとV2 / scopeの両方が操作前へ戻る
- History の source を Codex / All から Claude のみへ切り替えると実効 archive 条件が `すべて` になり、Codex / All へ戻すと直前の Codex 用 archive 条件が復元される。Claude のまま再起動してから Codex / All へ戻した場合も同じ条件が復元される
- History Insights の概要、ヒートマップ、ソース / モデル / プロジェクト / ツール内訳、アクティブセッション、ファイル一覧、利用詳細で、確定値、取得できた下限、取得不能が区別され、確定 0 と partial 0 / 不明を混同しない
- History Insights のツール内訳を呼び出し回数 / 利用セッション数で切り替えると順位、合計、省略件数が対応する指標へ切り替わり、長いツール名や2,000種類を超えるセッションはboundedな `partial` として扱われる
- History Insights のアクティブセッションをユーザー依頼数 / ツール呼び出し数 / 推論トークン数 / 合計トークン数 / 変更行数で切り替えると、同じsnapshot内の上位候補が決定的な順序で表示される。行から開けるのはhost側が現在model用に保持するopaque IDと一致するセッションだけで、未知IDや古いmodelから任意パスを開けない
- History Insights の概要に推論トークン / 変更イベント数が表示され、活動ヒートマップを推論トークンへ切り替えると日別の値とcoverageが更新される。利用詳細ではキャッシュ済み / キャッシュ読み取り / キャッシュ作成の入力トークンと推論トークン、ユーザー依頼 / アシスタント応答 / developer メッセージ / ツール呼び出し / ツール出力、全 / 完了 / 中断 / ロールバックのターン数が対応する取得可否で表示され、変更ファイル種別は解析できた範囲の重複除外後のファイル数 / 変更イベント数を表示する
- History Insights の日付から History、プロジェクトから History / Search へ drill-down した場合は対象外の source、プロジェクト集合、タグ、保存場所、日付範囲を維持し、ファイル操作は選択した opaque ID に対応する File AI Change History / ローカルファイルだけを開く
- History Insights の解析をキャンセルしても既存表示を stale として安全に保持し、panel を閉じて開き直した場合に旧 panel の進捗、エラー、model、VS Code通知が新しい panel へ混入しない。2秒未満のloadでは通知が出ず、2秒を超える初回load／model保持refreshでは通知からキャンセルできる。完了済みcancel後の新しいopen／条件適用はloadを開始し、snapshot保存中の最後の意図がcancelなら自動loadを抑止、cancel後にretryした場合は再開する
- 新規 storage では `session-analysis-index.v1.json` は History Insights / Claude Branch Navigation / `Rebuild Cache` の初回解析要求まで作成されず、通常の History / Search / Pinned / セッションタイムライン表示を待たせない
- Session Analysis Index は cache context が一致する限り未変更セッションを再利用し、mtime / size または parser version が変わった entry だけを再解析する。root / source context が変わった場合は新しい context で対象 entry を構築する
- Session Analysis のsource parser versionはCodex / Claudeともに`8`で、ツール名別利用回数を持たないversion 7 entryは再解析される
- 破損した `session-analysis-index.v1.json` は次の解析要求で安全に再生成され、read error では既存ファイルを削除しない
- `Rebuild Cache` は確認後に履歴キャッシュ、検索インデックス、Session Analysis Index を同じ履歴集合から順番に再作成し、進捗とキャンセルが機能する。独立した Session Analysis 再構築コマンドは公開しない
- `Rebuild Cache` をSession Analysis Index削除前にキャンセルした場合は既存indexが残り、削除後のキャンセルでは不完全なindexが保存されない。削除 / 保存失敗時は成功通知が出ない
- `Rebuild Cache` の実行中に Auto Refresh、History filter / scope、project association、関連設定を変更しても「中止」とならず、開始時の設定と1つのreadonly inventoryでHistory、Search、Analysisを最後まで処理する。開始設定が完了時にcurrentではない場合は新設定のlive History表示を上書きしない
- `Rebuild Search Index` は開始時に互換snapshotがなければ捕捉済みrefresh queueを一度だけ待ち、取得できなければ`historyUnavailable`で終了する。snapshot取得後はAuto Refresh、History filter / scope、関連設定が変わっても固定snapshotで完走する。進捗通知から明示キャンセルした場合は中止し、対象sessionが0件の場合は空indexを保存する
- 通常検索中に History のdate / project / source / tag / archive条件またはproject associationを変更しても、開始時条件の結果が一度公開され、その後に最新条件の自動再検索が1回だけ行われる。Auto Refresh、手動History refresh、関連設定、cache maintenanceが重なった場合も開始時snapshotの検索を暗黙に中止しない
- 通常検索を明示キャンセルした場合は保留中の自動再検索を行わず、新しい検索を開始した場合は旧検索結果を公開しない。検索開始時に互換History Indexがなく、捕捉済みrefreshを待っても開始設定のIndexを取得できなかった場合は、別設定のIndexを誤用せず`historyUnavailable`で終了する
- `codexHistoryViewer.branchNavigation.enabled = false` のとき Codex / Claude の branch control、overlay、relation / evidence build が動作せず、`true` へ変更すると再起動なしに開いている両sourceのセッションビューへ反映される
- Claude の同一物理 project folder に top-level primary session が 2 件未満の場合は追加 branch 解析を開始せず、分岐 0 件が確定したセッションビューでは理由を toast で確認できる
- Claude Branch Navigation の card 操作 / overlay から分岐先を選ぶと、同じセッション Webview で対象セッションの正しい 1-based message anchor へ移動し、通常の Search / bookmark / File History の移動位置がずれない
- ready 前の既存セッションパネルを分岐先として選んだ場合も、初回 bootstrap 後に対象 session、message anchor、overlay 表示が適用される
- Claude Branch Navigation の overlay は現在の lineage component の landmark だけを表示し、別 project folder、sidechain、無関係な root component、通常のセッションタイムラインの全メッセージを混在させない
- Claude Branch Navigation の候補 payload に21件以上の choice または occurrence があっても、Webview は各階層を20件までに制限し、現在候補と総件数、省略案内を維持する
- branch relation が部分的な場合は確認できた分岐だけを表示して warning を出し、機能を無効化してもセッションビュー、Session Analysis Index、bookmark、annotation、Claude JSONL を変更しない
- 旧`codexHistoryViewer.claudeBranches.enabled`と開発途中の`codexHistoryViewer.codexForks.enabled`はmanifest、実装、文書に残らず、共通`branchNavigation.enabled`だけを正本とする
- Codexの先頭`session_meta.payload.forked_from_id`だけからdirect / sibling / nested Forkを構築し、同じabsolute `cwd`を持つparent / childだけをlocal Forkとして表示する。異なる・relative・欠落した`cwd`、重複parent ID、cycle、self referenceを別sessionへ推測で接続しない
- `source.subagent.thread_spawn` と `forked_from_id` の両方を持つdirect / nested subagentはCodex Branch Navigationへ混入せず、Agent Runsだけから到達できる。Agent Runsを無効にしてBranch Navigationだけを有効にした場合も同じ分類になる
- agent metadataの補完が一部失敗した場合は、未確認sessionをForkと推測せず、確認済みrelationだけをpartialとして表示する
- Codexが共有履歴のtimestampを再付与していても、role、本文・attachment fingerprint、利用可能なsource item ID / turn IDから正しい共通prefixと1-based message anchorを求める。共通prefixを証明できないedgeでは誤った位置への移動を出さない
- 親セッションとmaterializeされた各Codex Forkに同じsession-start protocol bundleがあっても、それを共通履歴の通常user evidenceやFork anchorに含めない。カード化後もraw message indexは消費し、最初の実user message以降の1-based indexを変えない
- Codex Branch Navigation のinline操作 / overlayからtargetを選ぶと、同じセッションWebviewで対象session / messageへ移動する。History generation、file inventory、snapshot、request IDがstaleな場合や、target model構築中にcomponent fileが変化した場合は、commit直前の再検証で現在session、panel registry、表示modelを変更しない
- Codex Forkのheader buttonは上2点から下1点へ合流する公式Codexと同じ向き、関係ありの場合は件数badge付きで表示する。toolbar右側は`自動更新 -> Agent Runs -> Branch Navigation -> Reload`の順とし、branch buttonをReloadの直前へ固定する。Agent Runs buttonと同時に存在しても、片方のoverlayを開くと他方を安全に閉じる
- Codex Fork overlayはdirect / nested componentのlandmarkだけをbounded表示し、`新しい Worktree にフォークする`、別`cwd`、無関係なCodex session、通常タイムラインの全messageを混在させない
- bookmark / tag / note変更後はevidenceを再parseせずFork presentationだけを更新し、同一sessionの手動reloadと自動更新`preserve` / `follow`ではoverlay open、tree scroll、stable focusを可能な範囲で維持する
- Branch Navigationの再確認がpendingになっただけではセッションタイムライン、Webview内検索、スクロール位置を再描画しない。最終通知のinline分岐表示が同一ならセッションタイムラインは再描画せず、toolbar / controlと、開いているoverlayだけを更新する。実差分がある場合はactive検索結果をsemantic anchorで復元し、消失時は近傍へfallbackしつつ閲覧中anchorを可能な範囲で維持する
- `codexHistoryViewer.agentRuns.enabled = false` のときは History / Pinned / Search の通常 Codex アイコンとセッションタイムライン表示が従来どおり動く。`true` へ変更すると再起動なしで metadata を準備し、利用可能な親を持つサブエージェントだけを History から抑制する一方、Pinned / Search では全サブエージェントの専用表示を維持し、セッションビューのヘッダー操作へ反映する。2.8.0 では Codex セッションだけを対象とし、Claude の表示と履歴には影響しない
- Search 結果を開いたまま Agent Runs を有効化または metadata 更新しても、保持中の古い summary ではなく最新 relation presentation に従って session row の subagent アイコンが更新される
- 設定有効時は通常の Codex セッションビューで Agent Runs アイコンが常に表示され、関係がない session では押下時に toast が出る。親、子、孫、sibling がある session では右側ペインへ同じ component だけが表示される
- Agent Runs の主見出しは利用可能な root session title、副見出しは機能名と件数になり、task、設定済みの agent role、session title、開始日時、最終アクティビティ、bookmark / tag / note、直接の子件数が欠落せず表示される
- root から current までの connector / card accent は青、他経路はオレンジになり、通常 depth の parent 出口は共有幹線へ真下に接続する。sibling と孫が混在しても幹線が card 内部や別 card の裏へ入り込まず、深い階層でだけ card 回避の短い折れが出る
- available card の hover / focus-within で枠、背景、影と移動 icon が強調され、icon の pointer active 中は押下状態が分かる。card 本体の click では移動せず、current、missing parent、省略 node は移動可能に見えない
- 別 node の header 右端にある移動 icon から親、sibling、子、孫のセッションを開くと、既存 panel は reveal、未 open session は固定セッションタブとして開き、元 panel の scroll、検索、details state は変わらない。削除済み target、古い generation、未知 target は元 panel を閉じず、ローカライズしたエラーを表示する
- Agent Runs ペインの幅変更は閉じて開き直しても維持され、Reload Window 後はペイン自体を自動で開かない。同一セッションの手動 reload と自動更新 `preserve` / `follow` では開いたペイン、tree scroll、focus nodeを可能な範囲で維持し、セッション切り替えや非 ready 状態では閉じる。Branch Navigation overlay、page search、session 再描画との切り替えで古い DOM、focus、resize stateが残らない
- Codex / Claude の Branch Navigation overlay は同一セッションの手動 reload と自動更新 `preserve` / `follow` では開いた状態を維持し、最新 generation を current node 基準で再描画する。overlay 内の別セッションへの切り替え成功後は閉じ、後続navigationで勝手に再表示しない
- History / Pinned / Searchのセッション右クリックとCommand Paletteに`Branch Navigationを表示`／`Agent Runsを表示`が出ず、現在のセッションビューのヘッダー／タイムライン操作は従来どおり利用できる。Codexサブエージェントの`親セッションを開く`は利用可能な場合だけ表示される
- Claude user recordが短い単独`<local-command-stdout>`の場合は既定で閉じた出力カードになり、先頭以外に現れても通常user message番号、検索結果、preview、Resume、Handoff、Session Analysisのhuman messageへ混入しない。属性付き、複数block、通常文との混在、4,096文字超は通常textとして残る
- Codex rate limitの`used_percent`が`12.5`のような有限な非負小数でもusage cardとSession Analysisへ保持され、負数、非有限値、unsafeな大きさは従来どおり不正値になる
- Codex / Claude の Branch Navigation経路ツリーはrole、#番号、秒までのtimestampを省略せず表示し、anchorと分岐前補助行のtooltipでも同じ完全値を確認できる
- Agent Runs を有効化した既存 cache では未確認 Codex entry だけを bounded scanし、完了後の通常起動では再走査しない。部分失敗後は未確認 entry だけを再試行し、History / Search / Session Analysis Index の既存結果を作り直さない
- History Date Basis / History Title SourceなどのHistory関連設定変更とAgent Runs有効化を同時に適用しても、旧Indexの完了markerではreadyにせず、新設定のrefresh成功までloadingかつdisabledを維持する
- Agent Runs ON中にsessions root / sourceなどのHistory関連設定を変更してreplacement refreshを失敗させても、旧badge、overlay、opaque targetが残らず、設定変更のない通常refreshでは開いたoverlayを維持する
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
- archived Codex session の Markdown に `Location: Archived` が表示され、セッションビューでは `Archived` 表示で通常履歴と区別できる
- active Codex session の Markdown に `Location: Active` が表示される
- archived Codex session のセッションビューでは `Resume in Codex` の位置に `Move to Codex History` が表示される
- active Codex session のセッションビュー / 履歴 Webview には `Move to Archive` ボタンが表示されない
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
- `chat.openPosition = lastMessage` の archived セッションビューで `Move to Codex History` を実行した場合、復元後のセッションビューは操作直前に見ていた本文メッセージ付近へ移動する
- Export した active / archived Codex Markdown transcript に `Location: Active` / `Location: Archived` が表示される
- Codex source と archived sessions が有効な場合、Auto Refresh 有効時に archived root の `rollout-*.jsonl` 変更で履歴が更新される
- `fileChangeHistory.explorerContextMenu.enabled = false` のとき、Explorer のファイル右クリックに `Show File AI Change History` が表示されない
- History / Pinned のセッション右クリックで `Custom Title...` が表示され、QuickPick から設定 / 消去を選べる
- カスタムタイトル未設定のセッションでは QuickPick に消去アクションが出ない
- セッションビューのピン留めボタン右にある pencil アイコンから、同じ QuickPick でカスタムタイトルを設定 / 消去できる
- セッションビューからカスタムタイトルを設定 / 消去した後、タブタイトルと History / Pinned / Search の表示が更新される
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
- `続きを読み込む` で追加された card が既存表示の途中に入る場合でも、表示順は変更時刻昇順のままで、閲覧中 card 付近へ scroll が復元される
- 全候補解析後は `続きを読み込む` が消え、`これ以上の履歴はありません` が表示される。この表示は Webview 内検索の対象に含めない
- `履歴で開く` を押すと、通常履歴 Webview が現在のエディタグループに別タブとして開き、該当 diff card へスクロールする
- ファイル履歴で Codex / Claude source toggle を切り替えた状態でも、前 / 次 card ナビゲーションが表示中 card だけを対象にする
- ファイル履歴で Codex / Claude source toggle を切り替えても、表示中 card の変更時刻順が崩れず、可能な限り閲覧中 card 付近へ scroll が復元される
- `履歴で開く` で通常履歴 Webview を開いても full detail mode が強制されず、対象 diff entry の詳細だけが必要時に読み込まれる
- ファイル履歴 Webview を見ながら通常履歴 Webview を別タブで確認でき、既存のファイル履歴 Webview が置き換わらない
- `対象ファイルを開く` で VS Code の通常エディタに対象ファイルが開く
- source icon は Light / Dark / High Contrast で視認できる
- `ui.timeGuide.enabled = false` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示されない
- `ui.timeGuide.enabled = true` のとき、通常履歴 Webview / ファイル履歴 Webview の date guide が表示される
- date guide は表示範囲に応じて、通常履歴では時刻 / 日付+時刻 / 日 / 月、ファイル履歴では day / month / year に自動スケールする
- ファイル履歴の date guide は、major tick の visible label に mixed timeline の card 番号 `#N` または `#N-#M` を表示し、card header の番号と一致する
- ファイル履歴の date guide は、minor tick の visible label を空にし、tooltip / aria-label に card 番号を含める
- ファイル履歴の date guide ordinal summary は label 生成に必要な値だけを持ち、未使用の start / end 情報を共有 date guide API に残さない
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
- セッションビューのヘッダーにあるパフォーマンスモードボタンで、この画面だけ `auto` / `normal` / `simplified` を切り替えられる
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
- `History`のプロジェクト表示を`一覧表示` / `プロジェクト別表示`で切り替えられ、対象範囲を`すべて` / `現在のプロジェクトグループ`で切り替えられる。Reload後も対象範囲のアイコン、More Actionsの現在値、実際の`ProjectSelection`が一致する
- `History` の `プロジェクト別表示` で、`セッション一覧` と `日付別` の階層がそれぞれ期待どおりになる
- `History`の絞り込み解除は、対象範囲以外が非絞り込みならdisabled表示になり、日付 / 明示project selection / ソース / アーカイブ表示 / タグを解除して、プロジェクト表示と対象範囲は解除しない。対象範囲がcurrent groupなら裏付けselectionも維持する
- `Pinned` のプロジェクト表示を `一覧表示` / `プロジェクト別表示` で切り替えられ、対象範囲を `すべて` / `現在のプロジェクトグループ` で切り替えられる。History のプロジェクト表示には影響しない
- `Pinned` の日付 / プロジェクト / ソース / アーカイブ表示 / タグ絞り込みが期待どおり動き、History / Search 側の絞り込みに影響しない
- `Pinned` のソース切替を `all` / `codex` / `claude` で切り替えられ、History 側のソース切替に影響しない
- `Pinned` のソースが `claude` のとき、Pinned のアーカイブ表示切替が disabled になり、Command Palette から実行しても状態が変わらない
- `Pinned` の More Actions から、ピン留め順 / 開始日時 / 最終メッセージ日時 / 名前の昇順 / 降順を切り替えられ、現在値には `（現在）` が表示される
- `Pinned` の toolbar には表示順切替 icon が表示されず、表示順の変更は More Actions に集約される
- `Pinned` のプロジェクト tooltip は、表示順に応じた代表日時を `ピン留め日時` / `セッション日時` として表示する
- `Pinned` の絞り込み解除は日付 / プロジェクト / ソース / アーカイブ表示 / タグを解除し、プロジェクト表示、対象範囲、表示順は維持する
- `History` の再読み込み、`Pinned` の再読み込み、`Search` の `Rerun Search` が、それぞれセッションのエクスポートのすぐ左に表示される
- History / Pinned の右クリックから QuickPick 経由でカスタムタイトルを設定 / 消去でき、History / Pinned / セッション Webview タイトルへ反映される
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
- 履歴の自動更新設定が有効なとき、セッションビューのヘッダーに自動更新ボタンが表示される
- 新規セッションタブ、または再利用タブで別セッションへ切り替えたタブは、自動更新が `off` で始まる
- 同じセッションの既存タブを再表示した場合、自動更新モードが維持される
- セッションタブの自動更新ボタンで `off` / `preserve` / `follow` が循環し、ボタン色と tooltip が切り替わる
- 自動更新オンのセッションタブが開いているとき、History view が非表示でも対象タブが自動更新される
- 自動更新オンのセッションタブが裏タブでも、VS Code ウィンドウがフォーカス中なら更新される
- History view が非表示かつ自動更新オンのセッションタブが開いていないとき、自動更新は保留される
- VS Code ウィンドウが非フォーカスのとき、自動更新は保留され、フォーカス復帰時に 1 回だけ反映される
- 起動直後の初回履歴ロード中、History に読み込み中ノードが表示され、ロード完了後に実データまたは空状態案内へ切り替わる
- 起動直後の初回履歴ロード中、Pinned に読み込み中ノードが表示され、ロード完了後に実データ、欠損ピン、またはドロップ案内へ切り替わる
- 履歴が 0 件の場合、History に履歴保存先確認・再読み込み・Claude 有効化に関する案内ノードが表示される
- 履歴絞り込みで一致件数が 0 件になった場合、History に絞り込み変更 / 解除を促す案内ノードが表示される
- `preserve` ではスクロール位置、選択メッセージ、詳細表示、開いているカード、開いている diff、検索サイドバー状態が維持される
- `follow` では UI 状態を維持しつつ、`liveRunningTurnId` / `latestTurnId` がある場合はその turn 内の live running marker、completed end marker、最後の意味ある表示カードの順に移動する。末尾が patch group の場合は同じ turn 内の直前の非 patch group カードへ移動する。手動で折りたたまれた completed turn は勝手に展開せず、collapsed summary marker へ fallback する
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
- `Rebuild Cache` 実行前に確認が出て、履歴キャッシュ、検索インデックス、Session Analysis Index が同じ履歴集合から順番に再作成される。開始時snapshotが完了時にもcurrentであり、再作成全体が成功した場合だけ、開いている History Insights と Branch Navigation へ再作成結果が反映される
- 破損した `cache.v9.json` がある状態で起動 / refresh すると、parse error として削除され、履歴キャッシュが再生成される
- 破損した `search-index.v2.json` がある状態で検索すると、parse error として削除され、検索インデックスが再構築される
- `Delete` 実行後に `undo-delete` / `deleted` の扱いと `Undo Last Action` が整合する
- `Delete` 後に該当セッションパネルが閉じ、存在しないセッションを開こうとしてもゴーストパネルが残らない
- Undo 付き通知のボタンと Undo 完了メッセージが `ui.language` に応じて表示される
- `Empty Trash` 実行後に Status のゴミ箱件数が 0 になり、旧世代キャッシュも削除される
- `Empty Trash` 実行後も現行の `cache.v9.json` / `search-index.v2.json` / `session-analysis-index.v1.json` は削除されず、旧世代の `cache.v*.json` / `search-index.v*.json` / `session-analysis-index.v*.json` と 1 時間以上古い `*.tmp-*.json` だけが削除される
- Control ビューと Command Palette に `Debug Info (Copy)` が出ない
- `debug.logging.enabled` を `true` にすると OutputChannel に履歴 refresh / 検索インデックスの診断ログが出る
- 診断ログにセッションパス、セッションID、メッセージ本文が含まれない
- Status の容量表示と件数表示が更新される
- Status の最下部に拡張機能バージョンが表示される
- Import / Export が両ソースで正しく動く
- Markdown transcript にローカルパスが含まれるため、共有前確認が必要なことを案内できている
- `history.dateBasis` を `started` / `lastActivity` で切り替えると履歴ツリーの日付グループが正しく変わる
- `chat.openPosition = top` のとき、移動先指定のないセッションタイムライン表示が先頭から開く
- `chat.openPosition = lastMessage` のとき、同じセッションを開き直すと最後に見ていたメッセージ付近へ戻る
- `chat.openPosition = latest` のとき、移動先指定のないセッションタイムライン表示が最新の描画済み visual target から開く。折りたたみ中の turn は勝手に展開されない
- 保存位置がない場合、または保存位置が現在の詳細表示設定で表示される先頭メッセージの場合は、タグ / メモカードが見えるスクロール最上部から開く
- `chat.openPosition = lastMessage` で tool / usage / diff など本文メッセージが画面内にない位置を最後に見ていた位置として保存した場合、開き直し時は直前の描画済み本文メッセージ付近、直前がなければ先頭へ戻る
- `chat.openPosition = lastMessage` で保存済みの本文メッセージが現在の表示条件で描画されない場合、直前の描画済み本文メッセージへ戻り、直前がなければ先頭から開く
- ツリー選択で同じセッションの `session` タブが開いている場合、そのタブがアクティブになり、`reusable` タブは差し替わらない
- ツリー選択で同じセッションの `reusable` タブだけが開いている場合、そのタブがアクティブになる
- 別タブ表示中に、既に選択されている履歴行を再クリックしても、同じセッションの既存タブがアクティブになる
- メニューからセッションを開くと、未オープンのセッションは `session` タブとして開く
- メニューからセッションを開くと、同じセッションの `session` / `reusable` タブが既にあれば既存タブがアクティブになる
- `reusable` タブに表示中のセッションをメニューから開いた後、別履歴をツリー選択すると新しい `reusable` タブが使われ、昇格済みタブは差し替わらない
- `session` タブとして開いたセッションをツリー選択しても、`reusable` タブへ降格しない
- セッションタイムライン表示で `toolDisplayMode` を `detailsOnly` / `compactCards` で切り替えるとツール行の表示が変わる
- `userLongMessageFolding` / `assistantLongMessageFolding` が `off` / `auto` / `always` で期待どおり折りたたみ動作する
- `Show details` ON 時は長文メッセージが常に全文表示になる
- `Show details` OFF 時は usage 行が表示されない
- `Show details` ON 時は Codex / Claude の assistant 応答後に usage 行が表示され、クリックで詳細が展開 / 折りたたみされる
- Codex の usage 行には取得できる場合、model / effort / in-out token / cached input / reasoning / cumulative / context window / rate limit が表示される
- Claude の usage 行には取得できる場合、model / in-out token / cache read-write / service tier / speed が表示される
- `Show details` ON 時は、取得できる場合に environment 行として CWD / Git branch / Git commit / dirty 状態が表示される
- `Show details` ON 時は、tool カードに取得できる場合の status / exit code / duration / interruption / error が表示される
- Codex turn があるセッションで、start marker が turn 開始位置、end marker が turn 最終 item の直後に表示される
- turn 表示は `ターン N` を使い、message / card index の `#N` と混同しない。狭い viewport でも `ターン N` が 2 行に割れない
- turn marker / `live` mode の running chip の tooltip / aria-label で full `turn_id` を確認できる
- turn end marker に item 数、tool 数、変更数、入力 / 出力 / 合計 token が表示される
- completed turn の end marker に所要時間が表示され、`startedAtIso` / `completedAtIso` が欠ける場合や負の差分になる場合は省略される
- start marker には activity / status dot が出ず、静的な開始境界として読める
- completed turn の toggle で本文 row と通常 end marker が折りたたまれ、collapsed summary marker に `開始` / `終了`、開始時刻、終了時刻、所要時間、counts / token summary が残る
- collapsed summary marker は狭い viewport でも `ターン N`、toggle、`開始` / `終了` badge を 1 行で維持し、件数や token summary などの補助情報を先に ellipsis または非表示にする。横スクロール、本文への重なり、隣接 marker との衝突が起きない
- bookmark / restore / patch navigation / page search など中身を見る jump では、折りたたみ中の対象 turn が展開されてから scroll / focus される。`follow`、`chat.openPosition=latest`、ヘッダー末尾ボタンは手動で折りたたまれた turn を勝手に展開しない
- collapsed summary marker を viewport 上端付近で見ている状態で `Show details` ON/OFF や Webview 内検索 close を行っても、隣接する本文 row や遠い visible row へジャンプせず、同じ marker 付近へ戻る
- Webview 内検索で query が残っている状態、入力 debounce、role filter 変更、deferred patch refresh などにより turn / patch group の一時展開が発生しても、検索結果への明示移動がない場合は現在見ている card / marker の位置が維持される
- Webview 内検索の検索結果クリック、前へ / 次へで一時展開が必要な場合は、位置維持ではなく展開後に再計算した hit への scroll / focus が優先される
- 検索結果ツリーなどから `preferredMessageIndex` 付きで Webview 内検索を開き、一時展開が必要になった場合でも、展開後の再検索で目的の検索結果が active になり、先頭 hit へ戻らない
- Webview 内検索の role filter や大文字小文字条件を切り替えた後、検索結果が残る場合は現在 active result または viewport 近傍に留まり、常に 0 番へ戻らない
- session reload / detail toggle / path mode toggle / message folding / patch detail lazy-load などで描画内容が変わった後、Webview 内検索の古い pending intent が新しい結果集合へ誤適用されない
- `task_started` なしの `task_complete` / `turn_aborted` / `thread_rolled_back` が来ても、item を持たない幽霊 turn marker が表示されず、`latestTurnId` が実在しない turn に奪われない
- itemless turn が前に存在しても、後続 item-backed turn の `sequenceNumber` が再採番されず、同じ `turnId` が同じ `ターン N` のまま維持される
- turn_id なしの重複 `task_complete` 後の trailing `token_count` は直前 completed turn に帰属し、explicit unknown `task_complete` 後の trailing `token_count` は古い completed turn に誤帰属しない
- terminal 済み turn に古い timestamp、同一 timestamp、または timestamp 欠落の `task_started` が後続しても、completed / interrupted / rolledBack が `incomplete` へ巻き戻らない
- turn_id なしの `task_started` 後、次の turn_id なし item が前 turn に混ざらず、非 active の environment-only turn が start / end marker だけの空 turn として表示されない。live 観測中の active turn は environment だけを持つ段階でも running 表示から落ちない
- `A, B, A` のように同じ `turnId` が非連続に描画されても安定した run key により DOM id / `aria-controls` が衝突せず、collapse / expand が例外なく動く
- live running 中だけ running anchored chip が表示され、完了 / 中断 / rollback / stale 化後には消える
- running chip の `実行中` は `開始` / `完了` と同系統の pill として表示され、`経過 N` は `最終活動 ...` と同じ muted meta text 系の見た目になる
- running chip の経過時間は `startedAtIso` からの差分として 1 秒程度で更新され、1時間以上でも秒まで表示される。最終活動時刻は `updatedAtIso` が変わらない限り進まない
- running chip の `startedAtIso` が未来時刻で一時的に `経過` を表示できない場合でも、timer が停止せず、時計が追いついた後に reload なしで `経過` が表示される
- running chip の経過時間更新で timeline 全体の再描画、scroll 位置の変化、anchored / fallback 判定のちらつきが起きない
- `live` mode の running anchored chip は最後の意味ある表示カードの直後に、turn rail 基準の独立 anchored row として左寄せ表示され、card 内部や sticky user header 内に入らない
- running turn の最後の表示カードが user card / 通常 card / patch group のいずれでも、running chip はそのカード内部ではなく turnBlock 直下の anchored row に表示される
- anchored chip が viewport 外に流れた場合だけ左下 fallback sticky が表示され、クリック / Enter / Space で running turn へ移動できる
- fallback sticky 表示中も timeline 末尾の card / end marker、page search、toast、sticky user header の操作を阻害しない
- fallback sticky が本文カードの下に潜らず、dot だけの表示にならず、`ターン N` / `実行中` / `経過` / `最終活動` の主要情報が確認できる。中身の font size / pill / meta text は Webview 内 marker と同一で、外側の座布団 surface だけが本文上での読みやすさを補っている。座布団は内側 marker より縦方向に余裕があり、border が `ターン N` / `実行中` pill / meta text に密着して細い枠に見えない
- turn marker の collapse toggle は turn rail 上または rail-control lane に表示され、`ターン N` の開始位置に不要なインデントを作らず、クリック / focus ring も崩れない。running dot は start marker ではなく running anchored / fallback marker 側に表示される
- running chip の文字が省略される場合は ellipsis が出て、tooltip / title で full `turn_id`、経過時間、最終活動時刻を含む全文を確認できる
- 狭幅で turn marker counts が視覚的に非表示になっても、marker の tooltip / aria-label で件数と token 補足を確認できる
- running chip の elapsed 表示値が変わらない tick では、tooltip / aria-label が毎秒更新されない
- running marker の activity cue dot は live running 中だけ表示され、開始 / 完了 / 中断 / rollback / stale 化後には消える
- running marker dot の pulse は marker サイズや周辺 layout を変えない
- anchored row では turn rail 側の左端、左下 fallback sticky では marker 先頭に running marker dot が同じ見た目で表示され、marker 行の高さや `ターン N` の開始位置を変えない
- `updatedAtIso` / `lastItemIndex` / `itemCount` 変化時だけ update flash が 1 回出て、初回描画、scroll、resize、anchored / fallback の表示切り替えだけでは出ない
- `updatedAtIso` / `lastItemIndex` / `itemCount` 変化時だけ border glint が 1 回出て、枠全体が常時回転して見えない
- `prefers-reduced-motion: reduce` では running chip の pulse / flash / border glint と running marker dot pulse が止まり、静的な running 表示として読める
- 次の user card の上端が sticky 表示領域に到達した時点で、sticky user header が次の user に切り替わる
- セッションビューのスクロールバーが固定ヘッダーの横ではなく、ヘッダー下のスクロール領域から始まる
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
- Claude の task notification / invoke / IDE reference が同一 text item に混在する場合、抽出結果と Webview 表示が元テキストの出現順を保つ
- Claude の `<task-notification>` が task notification card になり、`summary`、`result`、`usage` が表示され、raw tag が本文に残らない
- Claude の assistant `<invoke>` が tool invocation card になり、tool 名、description、parameter を確認できる
- fenced code、inline code、blockquote 内に引用された `<task-notification>` / `<invoke>` はカード化されず、本文として残る
- `queue-operation` と `attachment.type = "queued_command"` に含まれる task notification は、chat / search / Markdown / Resume / Handoff でカード化されない
- task notification の `taskId` / `toolUseId` / `outputFile` / `systemPreamble` / `note` / `rawStatus`、invoke の `harnessPreamble` が Webview model に含まれない
- `<result>` 内の `<status>` / `<usage>` 風 text や `</task-notification>` literal で、壊れた task notification card や本文欠落が起きない
- close 欠落 / sparse close の `<invoke` / `<task-notification>` が大量にある synthetic message でも、structured attachment 抽出時間が二乗に伸びない
- malformed attachment が notification / invoke の前に混在する synthetic message でも、page search の一時展開で該当 attachment details が開く
- sessionData reload、session scoped reset、page search reset の直前に deferred render が予約されていても、reload 後に古い scroll restore が適用されない
- `usage.subagent_tokens` は task notification card の meta 表示だけに使われ、turn / session token aggregation には混入しない
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
- patch group collapsed 表示では先頭 3 file rows と `あと N 個のファイルを表示` が表示され、show more 後も件数と file row が正しい
- patch group に `レビューする` 文言が表示されず、まとめて開く操作は `全差分を開く` として表示される
- `全差分を開く` を押すと、対象 patch group card だけが全幅になり、全 file row と全 patch detail が同じ card 内で開く。オーバーレイ、別タブ、別パネルは開かない
- all-diff mode 中の表示は `全差分を閉じる` に切り替わり、もう一度押すと全 patch detail が閉じ、compact summary と all-diff mode 開始前の card 幅状態に戻る
- all-diff mode 解除後も、file row のクリックで対象 file の patch detail だけを展開し、focus / scroll できる
- 差分カードの折りたたみ展開、hunk ごとの折り返し切り替え、行ジャンプが動く
- diff カードの上下ナビゲーションで前後の diff へ移動できる
- 各カードの最大幅展開ボタンで対象カードだけが広がり、再クリックで通常幅に戻る
- 差分ハイライトが VS Code テーマに追従する
- 検索サイドバーがツールバー右端ボタンおよび `Ctrl+F` / `Cmd+F` で開閉する
- 検索サイドバーの幅をドラッグで変更でき、再表示後も保持される
- Webview 内検索の文字入力では連続入力中に検索が連発せず、短い待ち時間の後に最新 query で検索される
- Webview 内検索で query を空にすると、待ち時間なしで highlight と検索結果 status が消える
- Webview 内検索で Enter / 前へ / 次へを押すと、待ち時間なしで現在 query の結果へ移動できる
- attachment card の Result / Parameter details を開閉した直後、Webview 内検索の件数、highlight、active result が古い DOM のまま残らない
- ファイル履歴 Webview の Webview 内検索で debounce pending 中に Enter / 前へ / 次へを押しても、検索 refresh が二重実行されない
- ファイル履歴 Webview の検索結果には常に所属 card の mixed timeline 番号 `#N` が表示され、View 内の `#N` と一致する
- ファイル履歴 Webview の diff 本文 hit では `#N` に加えて `変更前 L...` / `変更後 L...` 相当の行番号 badge が表示され、hit した左右の diff block に応じて変更前 / 変更後を示す
- ファイル履歴 Webview の検索パネルが狭い場合、diff 行番号 badge は `L...` の compact 表示へ切り替わり、badge の余白が潰れず、tooltip / aria-label では変更前 / 変更後を確認できる
- ファイル履歴 Webview の検索パネルが 341px 以上でも full label では窮屈な幅の場合、flex wrap 後の overflow 検出に依存せず CSS container query で compact 表示へ切り替わる
- ファイル履歴 Webview の title / source / file path hit では `#N` だけが表示され、diff 行番号 badge は表示されない
- ファイル履歴 Webview の source toggle 後も検索結果 badge の `#N` は維持され、検索中の `続きを読み込む` 後は検索結果 badge と件数が同じ mixed timeline 基準で再計算される
- ファイル履歴 Webview の mixed timeline 番号参照は `model` message 受信時に作る `card.id` Map を使い、render / date guide / source toggle 復元で可視 card ごとの線形探索を繰り返さない
- ファイル履歴 Webview の `resetUi` 後から次の `model` message までに i18n などの render が挟まっても、既存 `model` の `#N` は mixed timeline Map の番号を維持する
- ファイル履歴 Webview の検索結果 occurrence は `cardId -> count` Map で生成され、大量 hit でも hit ごとに全 results を走査しない
- ファイル履歴 Webview の load more で hidden source の card だけが追加された場合、visible card が増えたように誤解させる toast を出さず、非表示中 source 用 toast または続き案内付きの非表示中 source 用 toast を出す
- Webview 内検索の幅をドラッグで狭めた状態でウィンドウ幅を 860px 以下に縮めても、検索パネルが現在幅より広がらず、リサイズハンドルで幅を変更できる
- 極端に狭い viewport でも検索パネルが画面外にはみ出さず、検索 input / close button を操作できる
- 未入力・一致なし時ともにカウントが `0/0` と表示される
- セッションビューのヘッダーにある先頭・末尾ボタンで、実際に表示されている最初 / 最後の visual target へスクロールできる。先頭ボタンは上端余白を残して先頭 user card の sticky user header が不要に表示されない。末尾ボタンは折りたたみ中の turn を勝手に展開しない
- 自動更新 `follow` で最新 turn の最後が patch group のとき、同じ turn 内の直前の非 patch group カードへ追従し、セッションタイムライン末尾ボタンでは最後の描画済み diff / patch group card へ移動できる。live running marker / completed end marker が表示されている場合は、`follow` もそれらを優先できる
- 末尾スクロール / `follow` 後も最後の card / marker が Webview 下端に貼り付かず、通常 card / diff card と running / completed / collapsed marker のそれぞれで小さな下端余白が残る
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
