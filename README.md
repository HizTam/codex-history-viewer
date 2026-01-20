# Codex History Viewer

A VS Code extension to browse, search, pin, promote (copy to today), and delete local Codex CLI session history stored under `~/.codex/sessions` (or a custom root).

## Features

- Three views: **Pinned**, **History**, and **Search**
- History tree view (year/month/day) with optional filters (date scope and project/CWD)
- Chat-like viewer (Webview) with Markdown rendering, copy actions, and "Open as Markdown"
- Open any session as a Markdown transcript (easy to search, share, and export)
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Search scope follows the active History filters (date scope and project/CWD)
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open/pin/promote/delete
- Drag & drop pinning: drag sessions into **Pinned** to pin

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Browse sessions under **History** (optionally use **Filter History…**).
3. Select a session to open a preview, or run **Open Session (Chat)** to open it normally.
4. Use the view toolbar or context menu to pin/unpin, promote, delete, or open as Markdown.
5. Run **Search…** to search across sessions; results appear under **Search**.

## Commands

- `Codex History Viewer: Refresh`
- `Codex History Viewer: Search…`
- `Codex History Viewer: Filter History…`
- `Codex History Viewer: Clear History Filters`
- `Codex History Viewer: Open Session (Chat)`
- `Codex History Viewer: Open Session (Markdown)`
- `Codex History Viewer: Open Settings`
- `Codex History Viewer: Promote to Today (Copy)`
- `Codex History Viewer: Pin` / `Unpin`
- `Codex History Viewer: Delete`
- `Codex History Viewer: Rebuild Cache`
- `Codex History Viewer: Debug Info (Copy)`

## Configuration

- `codexHistoryViewer.sessionsRoot`: Root folder of Codex sessions. Leave empty to use the default (`~/.codex/sessions`).
- `codexHistoryViewer.preview.openOnSelection`: Open a preview when selecting an item
- `codexHistoryViewer.preview.maxMessages`: Max number of user/assistant messages to include in tooltips and quick previews
- `codexHistoryViewer.search.maxResults`: Max number of search hits to collect
- `codexHistoryViewer.search.caseSensitive`: Whether search is case-sensitive
- `codexHistoryViewer.delete.useTrash`: When deleting, move files to the OS trash/recycle bin (recommended)
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`)
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.
