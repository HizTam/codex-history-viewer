# Codex History Viewer

A VS Code extension to browse, search, pin, promote (copy to today), and delete local Codex CLI session history stored under `~/.codex/sessions` (or a custom root).
Latest release: **0.1.2** (2026-02-06).

## Features

- Three views: **Pinned**, **History**, and **Search**
- History tree view (year/month/day) with optional filters (date scope and project/CWD)
- Chat-like viewer (Webview) with Markdown rendering, copy actions, and "Open as Markdown"
- Time zone-aware timestamps (chat view and transcripts)
- Language-aware command labels (Japanese/English) based on `codexHistoryViewer.ui.language`
- Open any session as a Markdown transcript (easy to search, share, and export)
- Copy Prompt Excerpt: copy a compact excerpt to the clipboard for handoff to OpenAI Codex
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Search scope follows the active History filters (date scope and project/CWD)
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open/pin/promote/delete
- Drag & drop pinning: drag sessions into **Pinned** to pin

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Browse sessions under **History** (optionally use **Filter History...**).
3. Select a session to open a preview, or run **Open Session (Chat)** to open it normally.
4. Use the view toolbar or context menu to pin/unpin, promote, delete, open as Markdown, or copy a prompt excerpt.
5. Run **Search...** to search across sessions; results appear under **Search**.

## Commands

- `Codex History Viewer: Refresh`
- `Codex History Viewer: Search...`
- `Codex History Viewer: Filter History...`
- `Codex History Viewer: Clear History Filters`
- `Codex History Viewer: Open Session (Chat)`
- `Codex History Viewer: Open Session (Markdown)`
- `Codex History Viewer: Copy Prompt Excerpt`
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
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`). This setting also affects timestamps: `ja` uses `Asia/Tokyo` (JST), while `auto`/`en` use your system time zone (falls back to `UTC` if unavailable).
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)

## What's New in 0.1.2

- Added language-specific (JA/EN) session management command labels in menus.
- Improved time zone handling for chat titles, session summaries, and transcript timestamps.
- Added in-chat message navigation buttons to jump to previous/next user prompts and assistant responses.
- Added **Copy Prompt Excerpt** for continuing work in OpenAI Codex by pasting a compact session excerpt.
- Updated SVG icons.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Prompt Excerpt**, this extension copies a compact session excerpt to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.
