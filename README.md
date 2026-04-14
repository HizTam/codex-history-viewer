# Codex History Viewer

A VS Code extension to browse, search, tag, import/export, and manage local Codex CLI / Claude Code session history, then resume selected sessions directly in the related VS Code extension.
Latest release: **1.1.5** (2026-04-14).

## Features

- Five views: **Control**, **Pinned**, **History**, **Search**, and **Status**
- Optional multi-source history support (**Codex** / **Claude**) with source-aware filtering
- History tree view (year/month/day) with filters for date scope, project/CWD, source, and tags
- Configurable history date basis (`started` / `lastActivity`) for the History tree and date-based search filtering
- One-click "Filter by Current Project" action in the History view header (toggle on/off)
- Tag filters in **Pinned** and **Search** views (separate from History filters)
- Session tooltips can show both **Started** and **Last activity** timestamps when they differ
- Open any session in a chat-like viewer (Webview) with Markdown rendering, syntax-highlighted fenced code blocks (powered by Shiki), and toolbar quick actions for pin/unpin, Markdown transcript, prompt excerpt copy, and source-aware resume (**OpenAI Codex** for Codex sessions, **Claude Code** for Claude sessions)
- Chat tab icon switches by source (`Codex` / `Claude`)
- Chat header annotation block (tags + note), including quick actions (filter/remove/edit)
- Time zone-aware timestamps (chat view and transcripts)
- Language-aware command labels (Japanese/English) based on `codexHistoryViewer.ui.language`
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Incremental local search index for faster repeated searches (tracks file updates/deletions)
- Search scope follows the active History filters (date scope, project/CWD, and source)
- Search roles filter (default: `user`/`assistant`, optional `developer`/`tool`) with configurable defaults from the Search header or Control view
- Search rerun (current conditions), search pane reset, and saved search presets (run/save/delete)
- Search hits include session annotations (`tag` / `note`) in addition to message/tool text
- Advanced query syntax: `/regex/`, `re:...`, `exact:...`, and `AND` / `OR` / `NOT`
- Session tags/notes annotations (editable from tree context menus and chat view)
- Global tag operations: bulk rename tag and bulk delete tags
- Cleanup Missing Pins action for stale pinned entries
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open/pin/promote/delete
- Drag & drop pinning: drag sessions from **History** or **Search** into **Pinned**
- Import/Export sessions: export raw JSONL or sanitized Markdown transcripts, and import with duplicate session ID handling (skip or overwrite)
- Control view for settings, import, rebuild cache, empty trash, bulk tag maintenance, undo, and debug info
- Dedicated refresh actions for **Pinned**, **History**, and **Status**, plus global refresh from the Control view
- Manual trash cleanup: **Empty Trash** clears internal trash/quarantine files and legacy cache/index generations on demand
- Undo last action (pin/unpin/promote/delete/annotation/tag operations)
- Status view metrics, including current filters/roles/tags, total tag count, cache folder size, trash file count, and copyable paths for the current project and session roots

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions (settings/import/rebuild cache/empty trash/search defaults).
3. Browse sessions under **History** and apply filters (date/project/source/tag) as needed.
4. Select a session to open a preview, or run **Open Session (Chat)** to open it normally.
5. Run **Search...** and refine with roles, query syntax, presets, and search tag filters.
6. Use context menus or chat header actions to edit tags/notes and run bulk tag operations when needed.

## Commands

Most actions are available from view title buttons and tree context menus.

For the full command list with per-command descriptions, see:

- [Command Reference](docs/commands.md)

## Configuration

- `codexHistoryViewer.sessionsRoot`: Root folder of Codex sessions. Leave empty to use the default (`~/.codex/sessions`).
- `codexHistoryViewer.claude.sessionsRoot`: Root folder of Claude Code sessions. Leave empty to use the default (`~/.claude/projects`).
- `codexHistoryViewer.sources.enabled`: Enabled history sources. Default is `["codex"]`. Add `claude` to load Claude history too.
- `codexHistoryViewer.preview.openOnSelection`: Open a preview when selecting an item
- `codexHistoryViewer.preview.maxMessages`: Max number of user/assistant messages to include in tooltips and quick previews
- `codexHistoryViewer.search.maxResults`: Max number of search hits to collect
- `codexHistoryViewer.search.caseSensitive`: Whether search is case-sensitive
- `codexHistoryViewer.search.defaultRoles`: Default roles used when running Search
- `codexHistoryViewer.history.dateBasis`: Which session date the History tree and date-based search filters use (`started` or `lastActivity`)
- `codexHistoryViewer.delete.useTrash`: When deleting, move files to the OS trash/recycle bin (recommended)
- `codexHistoryViewer.resume.openTarget`: Where `Resume in OpenAI Codex` opens the conversation (`sidebar` by default, or `panel`)
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`). This setting also affects timestamps: `ja` uses `Asia/Tokyo` (JST), while `auto`/`en` use your system time zone (falls back to `UTC` if unavailable).
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)

### Enable Claude Source (Optional)

- Open Settings and add `claude` to **Codex History Viewer > Sources: Enabled**.
- If needed, set **Codex History Viewer > Claude: Sessions Root**.

### Maintenance Tip (All Sources)

- If history or search results look incorrect or stale, run **Control > Rebuild Cache**. It recreates both the history cache and the search index after confirmation.
- To prevent the cache folder from growing over time, regularly run **Control > Empty Trash**. Trash files are not deleted automatically, and this also removes legacy cache/index generations.

## OpenAI Codex Integration Notes

- When you run `Resume in OpenAI Codex` for the first time, VS Code may show a security prompt asking whether the target extension can open the URI.
- This is expected VS Code behavior for extension URI handlers (`vscode://...`).
- If you click **Cancel**, resume will not proceed. Click **Open** to allow the handoff.
- If you check "Do not ask me again for this extension", future resumes will not show the same prompt.
- You can manage previously authorized extension URIs from Command Palette: `Extensions: Manage Authorized Extension URIs...`

## Import/Export behavior

- Export supports session/day/month/year selections and uses one timestamped output root per operation.
- Selecting a folder-level node exports all sessions under that node.
- Multi-select export preserves `YYYY/MM/DD` hierarchy for each source session.
- Import recursively scans the selected source folder for `.jsonl` files.
- Import duplicate session IDs can be handled as `skip` or `overwrite` at runtime.
- After successful import or promote (copy-to-today), a hint is shown to reload Codex CLI history if Codex is running.

## What's New in 1.1.5

- Added `codexHistoryViewer.history.dateBasis` to switch the History tree and date-based search filters between session start date and last message date.
- Session tooltips now show `Started` and `Last activity` when the two timestamps differ.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Prompt Excerpt**, this extension copies a compact session excerpt to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support%20this%20project-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/hiztam)
