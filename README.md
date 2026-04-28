# Codex History Viewer

Browse, search, organize, and resume past Codex CLI / Claude Code sessions through the official VS Code extensions.

Latest release: **1.4.2** (2026-04-28).

![Codex History Viewer screenshot](media/screenshot.png)

## Why Use This Extension?

Codex and Claude Code sessions can become hard to revisit once they are no longer active in the editor. Codex History Viewer keeps those local session files useful by turning them into a searchable, chat-like history browser inside VS Code.

Use it to find past prompts, reuse useful answers, inspect file changes, organize sessions with tags and notes, and hand off past sessions to the official Codex and Claude Code VS Code extensions for resume.

## Highlights

- Revisit past Codex CLI and Claude Code sessions that are no longer easy to access from the active editor flow
- Browse sessions in a year / month / day tree or a latest-first list
- Search across prompts, responses, tool output, tags, and notes
- View sessions in a chat-like UI with Markdown, code highlighting, math rendering, and file-change diffs
- Keep open chat tabs up to date with header-controlled auto-refresh modes
- Show supported image attachments from Codex / Claude sessions, with on-demand loading, preview, and save controls
- Organize sessions with pins, tags, notes, saved searches, and filters
- Resume past sessions through the official Codex and Claude Code VS Code extensions

## Detailed Features

- Five views: **Control**, **Pinned**, **History**, **Search**, and **Status**
- Optional multi-source history support (**Codex** / **Claude**) with source-aware filtering
- History view can switch between a year/month/day tree and a latest-first flat session list
- History filters for date scope, project/CWD, source, and tags
- Configurable history date basis (`started` / `lastActivity`) for the History tree and date-based search filtering
- Optional automatic refresh for local session file changes, with debounce and automatic refresh interval controls
- One-click "Filter by Current Project" action in the History view header (toggle on/off)
- Tag filters in **Pinned** and **Search** views (separate from History filters)
- Session tooltips can show both **Started** and **Last activity** timestamps when they differ
- Open any session in a chat-like viewer (Webview) with Markdown rendering, syntax-highlighted fenced code blocks (powered by Shiki), and toolbar quick actions for pin/unpin, Markdown transcript, prompt excerpt copy, and source-aware resume (**OpenAI Codex** for Codex sessions, **Claude Code** for Claude sessions)
- Chat viewer renders inline and block equations with KaTeX-compatible math support
- Chat viewer renders supported image attachments from data/local image references, loads image data on demand, and shows a clear unavailable state for unsupported, missing, remote-only, disabled, or oversized images
- Image attachments open in an in-view preview modal with a thumbnail strip, previous/next navigation, left/right keyboard navigation, fit/original-size toggle, and save action
- Chat viewer supports tool-specific cards with a configurable display mode (`detailsOnly` / `compactCards`)
- Chat viewer defers heavy tool details and patch diff rows until **Show details** is enabled or a diff entry is expanded
- Chat viewer shows assistant model, token usage, and related runtime metadata for Codex / Claude sessions only when **Show details** is enabled
- Chat viewer can show environment snapshots and tool execution metadata when the session file contains CWD, Git, status, exit code, or duration details
- Chat viewer can softly fold long `user` and `assistant` messages independently, while **Show details** always expands them fully
- Chat viewer restores to the currently viewed card when **Show details** is toggled, falling back to the next visible card when needed
- Chat viewer cards can be expanded individually to full width when a message, tool result, or diff needs more horizontal space
- Chat viewer shows grouped file-change cards from patch activity, with collapsible side-by-side diffs, per-hunk wrap toggles, syntax highlighting, previous/next diff navigation, and jump-to-line actions
- Chat viewer includes a right-side in-page search sidebar with match counts, result snippets, line hints for diffs, direct result navigation, and resizable overlay behavior
- Chat viewer toolbar includes quick scroll actions (first / latest rendered card) and automatically switches label buttons to icon-only mode when the header gets narrow
- Chat viewer toolbar can show an auto-refresh button per chat tab when the History auto-refresh setting is enabled. Modes are `off`, `on with current view preserved`, and `follow latest`.
- Chat tab auto-refresh keeps open chat tabs up to date while VS Code is focused, including tabs that are open in the background.
- Chat tab reload and auto-refresh preserve the current view state, including scroll position, selected message, expanded cards/diffs, details visibility, diff wrap state, and in-page search state.
- Reusable chat tabs reset session-scoped Webview state when switching to a different session, avoiding stale search, preview, or image-cache state.
- Selecting a session uses a reusable chat tab, while **Open in New Tab (Chat)** keeps the session in its own tab
- If the same session is already open, selecting or opening it activates the existing chat tab instead of creating a duplicate
- Chat sessions can reopen at the top or near the last viewed message, based on the setting
- Chat viewer scrolling starts below the fixed toolbar so the scrollbar belongs to the scrollable content area
- Reload in the chat viewer preserves scroll/selection and refreshes the tab title using the active history date basis
- The chat tab "follow latest" mode and the bottom scroll action target the latest rendered card instead of the absolute bottom of the scroll container
- Workspace-relative Markdown file links open inside VS Code from both chat sessions and Markdown transcripts
- Chat tab icon switches by source (`Codex` / `Claude`)
- Chat header annotation block (tags + note), including quick actions (filter/remove/edit)
- Time zone-aware timestamps based on the VS Code extension host environment (falls back to `UTC` if unavailable)
- Language-aware command labels (Japanese/English) based on `codexHistoryViewer.ui.language`
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Incremental local search index for faster repeated searches (tracks file updates/deletions and prunes stale entries)
- Search scope follows the active History filters (date scope, project/CWD, and source)
- Search roles filter (default: `user`/`assistant`, optional `developer`/`tool`) with configurable defaults from the Search header or Control view
- Search rerun (current conditions), search pane reset, and saved search presets (run/save/delete)
- Search hits include session annotations (`tag` / `note`) in addition to message/tool text
- Advanced query syntax: `/regex/`, `re:...`, `exact:...`, and `AND` / `OR` / `NOT`
- Session titles can optionally prefer native titles from Codex / Claude metadata while preserving the generated-title default
- Session tags/notes annotations (editable from tree context menus and chat view)
- Global tag operations: bulk rename tag and bulk delete tags
- Cleanup Missing Pins action for stale pinned entries
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open/pin/promote/delete
- Drag & drop pinning: drag sessions from **History** or **Search** into **Pinned**
- Import/Export sessions: export raw JSONL or sanitized Markdown transcripts, and import with duplicate session ID handling (skip or overwrite)
- Control view for settings, import, rebuild cache, empty trash, bulk tag maintenance, and undo
- Dedicated refresh actions for **Pinned**, **History**, and **Status**, plus global refresh from the Control view
- History view shows helpful empty-state guidance when no sessions are found or active filters match nothing
- Manual trash cleanup: **Empty Trash** clears internal trash/quarantine files and legacy cache/index generations on demand
- Undo last action (pin/unpin/promote/delete/annotation/tag operations)
- Status view metrics, including current filters/roles/tags, total tag count, cache folder size, trash file count, and copyable paths for the current project and session roots

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions (settings/import/rebuild cache/empty trash/search defaults).
3. Browse sessions under **History** and apply filters (date/project/source/tag) as needed.
4. Select a session to open the reusable chat tab, or run **Open in New Tab (Chat)** to keep it in its own tab.
5. Run **Search...** and refine with roles, query syntax, presets, and search tag filters.
6. Use context menus or chat header actions to edit tags/notes and run bulk tag operations when needed.
7. Resume a session through the official Codex or Claude Code extension when you want to continue the work.

## History View Header Actions

The History view header uses compact icon actions:

| Action | What it does |
| --- | --- |
| Refresh | Reloads the History view |
| Show Latest First / Show by Date | Switches between the latest-first list and date-grouped tree |
| Filter History | Filters by date, project, source, or tags |
| Filter by Current Project | Narrows history to the active workspace |
| Source | Cycles Codex / Claude / all enabled sources |
| Clear Filters | Removes active History filters |

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
- `codexHistoryViewer.search.defaultRoles`: Default roles used when running Search
- `codexHistoryViewer.search.caseSensitive`: Whether search is case-sensitive
- `codexHistoryViewer.search.maxResults`: Max number of search hits to collect
- `codexHistoryViewer.history.dateBasis`: Which session date the History tree and date-based search filters use (`started` or `lastActivity`)
- `codexHistoryViewer.history.titleSource`: How session titles are resolved (`generated` or `nativeWhenAvailable`)
- `codexHistoryViewer.autoRefresh.enabled`: Automatically refresh History and opt-in chat tabs when local session files change. Disabled by default.
- `codexHistoryViewer.autoRefresh.debounceMs`: Delay before automatic refresh after a local session file change. Multiple nearby events are merged.
- `codexHistoryViewer.autoRefresh.minIntervalMs`: Minimum automatic refresh interval. Higher values reduce refresh frequency during active writes.
- `codexHistoryViewer.chat.openPosition`: Where a chat session opens when returning to a previously viewed session (`top` or `lastMessage`)
- `codexHistoryViewer.chat.toolDisplayMode`: How tool activity appears in the chat viewer (`detailsOnly` or `compactCards`)
- `codexHistoryViewer.chat.userLongMessageFolding`: How long `user` messages are folded in the chat viewer (`off`, `auto`, or `always`)
- `codexHistoryViewer.chat.assistantLongMessageFolding`: How long `assistant` messages are folded in the chat viewer (`off`, `auto`, or `always`)
- `codexHistoryViewer.images.enabled`: Show supported image attachments in the chat viewer
- `codexHistoryViewer.images.maxSizeMB`: Maximum image size to load for preview and saving
- `codexHistoryViewer.images.thumbnailSize`: Thumbnail size for image attachments (`small`, `medium`, or `large`)
- `codexHistoryViewer.resume.openTarget`: Where `Resume in OpenAI Codex` opens the conversation (`sidebar` by default, or `panel`)
- `codexHistoryViewer.delete.useTrash`: When deleting, move files to the OS trash/recycle bin (recommended)
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`)
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)
- `codexHistoryViewer.debug.logging.enabled`: Write diagnostic timing logs to the **Codex History Viewer** output channel. Disabled by default and intended for troubleshooting.

### Enable Claude Source (Optional)

- Open Settings and add `claude` to **Codex History Viewer > Sources: Enabled**.
- If needed, set **Codex History Viewer > Claude: Sessions Root**.

### Maintenance Tip (All Sources)

- If history or search results look incorrect or stale, run **Control > Rebuild Cache**. It recreates both the history cache and the search index after confirmation.
- If you want new or updated local sessions to appear without manual refresh, enable the History auto-refresh setting. Automatic refresh runs while the History view is visible or an auto-refresh-enabled chat tab is open, and only while the VS Code window is focused.
- Auto-refresh reacts to local session file changes. For Codex sessions, assistant output may be written to `rollout-*.jsonl` only after a response or turn is complete, so chat tabs may not update token-by-token while the answer is still streaming.
- If chat tab auto-refresh still feels delayed after the session file changes, try lowering `codexHistoryViewer.autoRefresh.debounceMs` and/or `codexHistoryViewer.autoRefresh.minIntervalMs`. Lower values feel more live but can increase CPU and disk activity.
- To prevent the cache folder from growing over time, regularly run **Control > Empty Trash**. Trash files are not deleted automatically, and this also removes legacy cache/index generations.
- For performance troubleshooting, enable `codexHistoryViewer.debug.logging.enabled` in `settings.json`, then inspect **Output > Codex History Viewer**. Logs include counts and timings, not session paths or message content.

## OpenAI Codex Integration Notes

- When you run `Resume in OpenAI Codex` for the first time, VS Code may show a security prompt asking whether the target extension can open the URI.
- This is expected VS Code behavior for extension URI handlers (`vscode://...`).
- If you click **Cancel**, resume will not proceed. Click **Open** to allow the handoff.
- If you check "Do not ask me again for this extension", future resumes will not show the same prompt.
- You can manage previously authorized extension URIs from Command Palette: `Extensions: Manage Authorized Extension URIs...`
- If the official Codex extension stops reopening a conversation, try these VS Code commands before reloading the whole window: `Developer: Reload Webviews`, then `Developer: Restart Extension Host`, then `Developer: Reload Window`.

## Import/Export behavior

- Export supports session/day/month/year selections and uses one timestamped output root per operation.
- Selecting a folder-level node exports all sessions under that node.
- Multi-select export preserves `YYYY/MM/DD` hierarchy for each source session.
- Import recursively scans the selected source folder for `.jsonl` files.
- Import duplicate session IDs can be handled as `skip` or `overwrite` at runtime.

## What's New in 1.4.2

- Added collapsible assistant usage rows in the chat viewer when **Show details** is enabled.
- Improved History empty-state guidance when no sessions are found or filters match nothing.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Prompt Excerpt**, this extension copies a compact session excerpt to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support%20this%20project-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/hiztam)
