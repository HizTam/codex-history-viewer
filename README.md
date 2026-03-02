# Codex History Viewer

A VS Code extension to browse, search, pin, promote (copy to today), and delete local Codex CLI session history stored under `~/.codex/sessions` (or a custom root).
Latest release: **0.1.4** (2026-03-02).

## Features

- Five views: **Control**, **Pinned**, **History**, **Search**, and **Status**
- Per-pane refresh actions plus global refresh from the Control view
- History tree view (year/month/day) with filters for date scope, project/CWD, and tags
- One-click "Filter by Current Project" action in the History view header (toggle on/off)
- Tag filters in **Pinned** and **Search** views (separate from History filters)
- Chat-like viewer (Webview) with Markdown rendering, copy actions, and "Open as Markdown"
- Chat header annotation block (tags + note), including quick actions (filter/remove/edit)
- Time zone-aware timestamps (chat view and transcripts)
- Language-aware command labels (Japanese/English) based on `codexHistoryViewer.ui.language`
- Open any session as a Markdown transcript (easy to search, share, and export)
- Copy Prompt Excerpt: copy a compact excerpt to the clipboard for handoff to OpenAI Codex
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Incremental local search index for faster repeated searches (tracks file updates/deletions)
- Search roles filter (default: `user`/`assistant`, optional `developer`/`tool`) with configurable defaults
- Search rerun (current conditions), search pane reset, and saved search presets (run/save/delete)
- Search hits include session annotations (`tag` / `note`) in addition to message/tool text
- Advanced query syntax: `/regex/`, `re:...`, `exact:...`, and `AND` / `OR` / `NOT`
- Session tags/notes annotations (editable from tree context menus and chat view)
- Global tag operations: bulk rename tag and bulk delete tags
- Undo last action (pin/unpin/promote/delete/annotation/tag operations)
- Cleanup Missing Pins action for stale pinned entries
- Search scope follows the active History filters (date scope and project/CWD)
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open/pin/promote/delete
- Drag & drop pinning: drag sessions from **History** or **Search** into **Pinned**
- Import/Export sessions: export raw JSONL or sanitized Markdown transcripts, and import with duplicate session ID handling (skip or overwrite)
- Status view metrics, including current filters/roles/tags and total tag count

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions (refresh/import/settings/search defaults).
3. Browse sessions under **History** and apply filters (date/project/tag) as needed.
4. Select a session to open a preview, or run **Open Session (Chat)** to open it normally.
5. Run **Search...** and refine with roles, query syntax, presets, and search tag filters.
6. Use context menus or chat header actions to edit tags/notes and run bulk tag operations when needed.

## Commands

- `Codex History Viewer: Refresh`
- `Codex History Viewer: Refresh Pinned`
- `Codex History Viewer: Refresh History`
- `Codex History Viewer: Refresh Status`
- `Codex History Viewer: Search...`
- `Codex History Viewer: Configure Default Search Roles...`
- `Codex History Viewer: Rerun Search`
- `Codex History Viewer: Filter Search by Tags...`
- `Codex History Viewer: Clear Search Tag Filter`
- `Codex History Viewer: Filter History...`
- `Codex History Viewer: Filter History by Tags...`
- `Codex History Viewer: Filter by Current Project`
- `Codex History Viewer: Clear History Filters`
- `Codex History Viewer: Clear History Tag Filter`
- `Codex History Viewer: Filter Pinned by Tags...`
- `Codex History Viewer: Clear Pinned Tag Filter`
- `Codex History Viewer: Open Session (Chat)`
- `Codex History Viewer: Open Session (Markdown)`
- `Codex History Viewer: Copy Prompt Excerpt`
- `Codex History Viewer: Open Settings`
- `Codex History Viewer: Promote to Today (Copy)`
- `Codex History Viewer: Pin` / `Unpin`
- `Codex History Viewer: Delete`
- `Codex History Viewer: Rebuild Cache`
- `Codex History Viewer: Cleanup Missing Pins`
- `Codex History Viewer: Debug Info (Copy)`
- `Codex History Viewer: Export Sessions...`
- `Codex History Viewer: Import Sessions...`
- `Codex History Viewer: Run Saved Search...`
- `Codex History Viewer: Initialize Search Pane`
- `Codex History Viewer: Save Current Search Preset...`
- `Codex History Viewer: Delete Saved Search...`
- `Codex History Viewer: Edit Session Tags/Note...`
- `Codex History Viewer: Bulk Rename Tag...`
- `Codex History Viewer: Bulk Delete Tags...`
- `Codex History Viewer: Undo Last Action`

## Configuration

- `codexHistoryViewer.sessionsRoot`: Root folder of Codex sessions. Leave empty to use the default (`~/.codex/sessions`).
- `codexHistoryViewer.preview.openOnSelection`: Open a preview when selecting an item
- `codexHistoryViewer.preview.maxMessages`: Max number of user/assistant messages to include in tooltips and quick previews
- `codexHistoryViewer.search.maxResults`: Max number of search hits to collect
- `codexHistoryViewer.search.caseSensitive`: Whether search is case-sensitive
- `codexHistoryViewer.search.defaultRoles`: Default roles used when running Search
- `codexHistoryViewer.delete.useTrash`: When deleting, move files to the OS trash/recycle bin (recommended)
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`). This setting also affects timestamps: `ja` uses `Asia/Tokyo` (JST), while `auto`/`en` use your system time zone (falls back to `UTC` if unavailable).
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)

## Import/Export behavior

- Export supports session/day/month/year selections and uses one timestamped output root per operation.
- Selecting a folder-level node exports all sessions under that node.
- Multi-select export preserves `YYYY/MM/DD` hierarchy for each source session.
- Import recursively scans the selected source folder for `.jsonl` files.
- Import duplicate session IDs can be handled as `skip` or `overwrite` at runtime.
- After successful import or promote (copy-to-today), a hint is shown to reload Codex CLI history if Codex is running.

## What's New in 0.1.4

- Added **Control** and **Status** views for day-to-day operations and runtime visibility.
- Added tag-centric workflows: filters in History/Pinned/Search, annotation hits in search results, and bulk tag operations.
- Added import/export workflow improvements (duplicate ID handling and sanitized transcript export).
- Expanded Undo coverage and command localization consistency.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Prompt Excerpt**, this extension copies a compact session excerpt to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.
