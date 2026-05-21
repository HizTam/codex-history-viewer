# Codex History Viewer

Browse, search, organize, and resume past Codex CLI / Claude Code sessions through the official VS Code extensions.

Latest release: **2.2.0** (2026-05-21).

![Codex History Viewer screenshot](media/screenshot.png)

## Why Use This Extension?

Codex and Claude Code sessions can become hard to revisit once they are no longer active in the editor. Codex History Viewer keeps those local session files useful by turning them into a searchable, chat-like history browser inside VS Code.

Use it to find past prompts, reuse useful answers, inspect file changes, organize sessions with tags and notes, resume same-source sessions, and hand off work between Codex and Claude Code.

## Highlights

- Revisit past Codex CLI and Claude Code sessions that are no longer easy to access from the active editor flow
- Browse sessions in a year / month / day tree or a latest-first list
- Optionally include Codex `archived_sessions` when the Codex source is enabled, and switch archive visibility instantly
- Show valid cached History and Pinned data immediately at startup while local session files refresh in the background
- Search across prompts, responses, tool output, tags, and notes
- View sessions in a chat-like UI with Markdown, code highlighting, math rendering, and file-change diffs
- Open **AI Change History** for a workspace file to review Codex / Claude diffs that touched that file
- Bookmark important history cards and use date-guide markers to revisit them quickly
- Keep open chat tabs up to date with header-controlled auto-refresh modes
- Show supported image attachments from Codex / Claude sessions, with on-demand loading, preview, and save controls
- Organize sessions with pins, tags, notes, custom titles, saved searches, and filters
- Resume past sessions through the official Codex and Claude Code VS Code extensions
- Create handoff files and prompts when moving work between Codex and Claude Code

## Detailed Features

- Five views: **Control**, **Pinned**, **History**, **Search**, and **Status**
- Load **Codex** and **Claude Code** sources, with Codex `archived_sessions` available as an optional Codex archive location
- Read Codex `archived_sessions` from a configurable archive root when **Sources: Enabled** includes Codex
- Switch archived Codex visibility immediately from **History**, **Pinned**, and **Search** view title actions
- History view can switch between a year/month/day tree and a latest-first flat session list
- History filters for date scope, project/CWD, source, archive location, and tags
- Configurable history date basis (`started` / `lastActivity`) for the History tree and date-based search filtering
- Optional automatic refresh for local session file changes, with debounce and automatic refresh interval controls
- One-click "Filter by Current Project" action in the History view header (toggle on/off)
- Tag filters in **Pinned** and **Search** views (separate from History filters)
- Archived Codex sessions are visually marked in trees, tooltips, Markdown transcripts, and chat views
- Session tooltips can show both **Started** and **Last activity** timestamps when they differ
- Session tooltips can be shown as full details, compact metadata, or the title-only tree row
- Session titles can be renamed inside this extension from tree menus or the chat viewer header, with original titles available in detailed tooltips
- Open any session in a chat-like viewer (Webview) with Markdown rendering, syntax-highlighted fenced code blocks (powered by Shiki), and toolbar quick actions for pin/unpin, Markdown transcript, quick prompt copy, and source-aware resume (**OpenAI Codex** for Codex sessions, **Claude Code** for Claude sessions)
- Archived Codex chat views replace **Resume in Codex** with **Move to Codex History**
- Chat viewer renders inline and block equations with KaTeX-compatible math support
- Chat viewer renders supported image attachments from data/local image references, loads image data on demand, and shows a clear unavailable state for unsupported, missing, remote-only, disabled, or oversized images
- Image attachments open in an in-view preview modal with a thumbnail strip, previous/next navigation, left/right keyboard navigation, fit/original-size toggle, and save action
- Chat viewer supports tool-specific cards with a configurable display mode (`detailsOnly` / `compactCards`)
- Chat viewer defers heavy tool details and patch diff rows until **Show details** is enabled or a diff entry is expanded
- Chat viewer includes a performance mode (`auto` / `normal` / `simplified`) so large histories can defer heavy diff/detail rendering while still allowing individual entries to be opened on demand
- Chat viewer shows assistant model, token usage, and related runtime metadata for Codex / Claude sessions only when **Show details** is enabled
- Chat viewer can show environment snapshots and tool execution metadata when the session file contains CWD, Git, status, exit code, or duration details
- Chat viewer can softly fold long `user` and `assistant` messages independently, while **Show details** always expands them fully
- Chat viewer restores to the currently viewed card when **Show details** is toggled, falling back to the next visible card when needed
- Chat viewer cards can be expanded individually to full width when a message, tool result, or diff needs more horizontal space
- Chat viewer shows grouped file-change cards from patch activity, with collapsible side-by-side diffs, per-hunk wrap toggles, syntax highlighting, previous/next diff navigation, and jump-to-line actions
- File-level **AI Change History** opens from an opt-in Explorer file context menu and shows only the loaded Codex / Claude diffs for the selected file inside the current workspace
- AI Change History includes source toggles, in-view search, top/bottom navigation, previous/next card navigation, "Open in History" links back to the matching diff card in the original session, and incremental **Load more** paging
- History cards can be bookmarked when date guides are enabled
- Date guides can show bookmark and user markers, with a density-aware lens that expands crowded timeline regions
- Chat viewer includes a right-side in-page search sidebar with match counts, result snippets, line hints for diffs, direct result navigation, and resizable overlay behavior
- Chat viewer toolbar includes quick scroll actions (first / latest rendered card) and automatically switches label buttons to icon-only mode when the header gets narrow
- Chat viewer toolbar can show an auto-refresh button per chat tab when the History auto-refresh setting is enabled. Modes are `off`, `on with current view preserved`, and `follow latest`.
- Chat tab auto-refresh keeps open chat tabs up to date while VS Code is focused, including tabs that are open in the background.
- Chat tab reload and auto-refresh preserve the current view state, including scroll position, selected message, expanded cards/diffs, details visibility, diff wrap state, and in-page search state.
- Reusable chat tabs reset session-scoped Webview state when switching to a different session, avoiding stale search, preview, or image-cache state.
- Selecting a session uses a reusable chat tab, while **Open in New Tab (Chat)** keeps the session in its own tab
- If the same session is already open, selecting or opening it activates the existing chat tab instead of creating a duplicate
- Chat sessions can open at the top, near the last viewed message, or at the latest rendered card, based on the setting
- Last-viewed-message restoration uses the previous rendered message or the top when no message bubble is visible
- Chat viewer scrolling starts below the fixed toolbar
- Reload in the chat viewer preserves scroll/selection and refreshes the tab title using the active history date basis
- Follow latest auto-refresh targets the latest non-diff content card when trailing grouped diff cards are present, while the bottom scroll action targets the latest rendered card
- Workspace-relative Markdown file links open inside VS Code from both chat sessions and Markdown transcripts
- Chat tab icon switches by source (`Codex` / `Claude`)
- Chat header annotation block (tags + note), including quick actions (filter/remove/edit)
- Time zone-aware timestamps based on the VS Code extension host environment (falls back to `UTC` if unavailable)
- Language-aware command labels (Japanese/English) based on `codexHistoryViewer.ui.language`
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity)
- Incremental local search index for faster repeated searches (tracks file updates/deletions and prunes stale entries)
- Search scope follows the active History filters (date scope, project/CWD, source, and archive visibility)
- Search roles filter (default: `user`/`assistant`, optional `developer`/`tool`) with configurable defaults from the Search header or Control view
- Search index tool-content scope can be reduced from the compatibility default (`toolCallsAndOutputs`) to `toolCalls` or `conversationOnly` to shrink the local search index; Codex `custom_tool_call` records are indexed as lightweight tool metadata when tool calls are enabled
- AI Change History can use search-index file-change hints to prioritize related sessions when those hints are available
- Search rerun (current conditions), search pane reset, and saved search presets (run/save/delete)
- Search hits include session annotations (`tag` / `note`) in addition to message/tool text
- Advanced query syntax: `/regex/`, `re:...`, `exact:...`, and `AND` / `OR` / `NOT`
- Session titles can optionally prefer native titles from Codex / Claude metadata while preserving the generated-title default
- Session tags/notes annotations (editable from tree context menus and chat view)
- Cross-agent handoff creates per-session `handoff.md` files in VS Code global storage, with tail-prioritized transcript excerpts, the latest user request, source session path, and recoverable file changes
- The **Handoff to Other AI** context submenu can create a handoff file, copy a handoff prompt, open or create a session handoff file, or hand off a Codex session to Claude Code when the Claude Code extension is available
- Active Codex sessions can be moved to archive, and archived Codex sessions can be moved back to normal Codex history
- Pinned Codex sessions can follow official archive/unarchive path changes by session identity
- Archive/unarchive path changes relocate related annotations, bookmarks, and saved chat open positions when possible
- Global tag operations: bulk rename tag and bulk delete tags
- Cleanup Missing Pins action for stale pinned entries
- Promote: copy a past session into "today" without modifying the original file
- Safe deletion: moves files to the OS trash/recycle bin by default (falls back to an internal quarantine folder if trash fails)
- Multi-select support for open, pin, promote, delete, move to archive, and move to Codex history
- Drag & drop pinning: drag sessions from **History** or **Search** into **Pinned**
- Import/Export sessions: export raw JSONL or sanitized Markdown transcripts, and import with duplicate session ID handling (skip or overwrite)
- Control view for settings, import, rebuild cache, empty trash, bulk tag maintenance, handoff cleanup, and undo
- Dedicated refresh actions for **Pinned**, **History**, and **Status**, plus global refresh from the Control view
- History view shows a localized loading row when a valid startup cache is unavailable, plus helpful empty-state guidance when no sessions are found or active filters match nothing
- Manual trash cleanup: **Empty Trash** clears internal trash/quarantine files and legacy cache/index generations on demand
- Undo last action (pin/unpin/promote/delete/annotation/tag operations)
- Status view metrics, including current filters/roles/tags, total tag count, cache folder size, Codex archived session count when enabled, handoff count/storage size, trash file count, and copyable paths for the current project and active session roots

## Quick start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions (settings/import/rebuild cache/empty trash/search defaults).
3. Browse sessions under **History** and apply filters (date/project/source/tag) as needed.
4. Select a session to open the reusable chat tab, or run **Open in New Tab (Chat)** to keep it in its own tab.
5. Run **Search...** and refine with roles, query syntax, presets, and search tag filters.
6. Use context menus or chat header actions to edit tags/notes and run bulk tag operations when needed.
7. Enable **File Change History > Explorer Context Menu: Enabled** when you want file-level diff history from file right-click menus.
8. Keep Codex enabled in **Sources: Enabled**, turn on Codex archived sessions when you want archived Codex history included, then use the archive visibility button to choose active only, all, or archived only.
9. Resume a same-source session through the official Codex or Claude Code extension, or use **Handoff to Other AI** when moving work between agents.

## AI Change History

AI Change History lets you start from a workspace file and inspect the Codex / Claude changes that touched that file over time.

![AI Change History screenshot](media/screenshot_2.png)

Use it when you want to answer questions such as:

- Which AI session changed this file?
- How did this file evolve across Codex and Claude sessions?
- What was the surrounding session context for a specific diff?

The Explorer file context menu entry is opt-in. Enable **File Change History > Explorer Context Menu: Enabled**, then right-click a file in VS Code Explorer and run **Show File AI Change History**.

The view is scoped to the current workspace and selected file. It shows only renderable AI diffs, supports Codex / Claude source toggles, searches the loaded diff cards, preserves scroll position when loading more, and opens the matching diff card in the original session view via **Open in History** without replacing the file history tab.

## Codex Archived Sessions

Codex History Viewer can optionally read Codex `archived_sessions` in addition to the normal Codex `sessions` folder.

Codex archived sessions are a child option of the Codex source. **Codex History Viewer > Sources: Enabled** must include Codex; if Codex is disabled there, archived sessions are ignored even when **Archived Sessions: Enabled** is on.

Enable **Codex History Viewer > Codex > Archived Sessions: Enabled** to load archived Codex sessions. If **Archived Sessions Root** is empty, the extension uses an `archived_sessions` folder next to the configured Codex sessions root, for example `~/.codex/archived_sessions` next to `~/.codex/sessions`.

Archived Codex sessions can be switched instantly from the **History**, **Pinned**, and **Search** view title actions: **Active Only**, **All**, or **Archived Only**. This changes visible lists without changing the archived-session setting.

Active Codex sessions expose **Move to Archive** from the context menu. Archived Codex sessions expose **Move to Codex History** instead, and do not show **Resume in Codex** or **Promote to Today (Copy)**. In the chat viewer, archived Codex sessions show **Move to Codex History** where **Resume in Codex** would normally appear.

Archive and restore operations prefer the official Codex provider. Moving archived sessions back to normal Codex history can fall back to a filesystem move when the official provider is unavailable; that fallback preserves the original session date folder when possible and offers Undo. Pins, annotations, bookmarks, and saved chat positions are relocated when the session path changes.

## Handoff to Other AI

Use handoff when you want another agent to continue work after reading the prior context, instead of only reopening the original session.

Handoff actions appear in the **History**, **Pinned**, and **Search** session context menus under **Handoff to Other AI** for visible Codex / Claude sessions when `codexHistoryViewer.handoff.enabled` is enabled.

Available actions:

- **Handoff to Claude Code**: available for Codex sessions when both Codex and Claude sources are enabled. Creates or reuses a `handoff.md` file, then opens Claude Code with a prompt that points to that file.
- **Create Handoff File**: creates the session's `handoff.md` without opening another agent.
- **Copy Handoff Prompt to Clipboard**: copies a prompt that tells the target agent to read the `handoff.md` file. If the file does not exist yet, it is created first and the notification says so.
- **Open Handoff File**: opens the handoff file for the selected session. If none exists, a notification asks whether to create one and opens it after creation.

Claude-to-Codex handoff uses the clipboard path. Codex currently does not provide a reliable command for automatically attaching or pre-filling this prompt, so paste the copied prompt into Codex manually.

The generated handoff file is stored under this extension's VS Code global storage, not inside your workspace. It includes a tail-prioritized transcript excerpt, the latest user request, the source session file path, and recoverable file changes. Tool calls and tool outputs are intentionally omitted.

Generated handoff files may be automatically cleaned up when they are older than 30 days or when more than 100 handoff entries exist. Automatic cleanup runs when creating a handoff, and manually edited handoff files are not protected from this cleanup.

If a handoff file already exists, **Handoff to Claude Code** and **Create Handoff File** ask whether to use the existing file or recreate it. **Copy Handoff Prompt to Clipboard** reuses an existing file without asking.

Set `codexHistoryViewer.handoff.enabled` to `false` if you do not want handoff actions in session context menus. Handoff cleanup and Status metrics remain available so existing generated files can still be tracked and removed.

## History View Header Actions

The History view header uses compact icon actions:

| Action | What it does |
| --- | --- |
| Refresh | Reloads the History view |
| Show Latest First / Show by Date | Switches between the latest-first list and date-grouped tree |
| Filter History | Filters by date, project, source, location, or tags |
| Filter by Current Project | Narrows history to the active workspace |
| Source | Cycles Codex / Claude Code / all enabled sources |
| Archive Visibility | Switches archived Codex visibility between active only, all, and archived only |
| Clear Filters | Removes active History filters |

## Commands

Most actions are available from view title buttons and tree context menus.

For the full command list with per-command descriptions, see:

- [Command Reference](docs/commands.md)

## Configuration

- `codexHistoryViewer.sources.enabled`: Top-level history sources. Default is `["codex"]`. Use `codex` for Codex history and `claude` for Claude Code history; Codex archived-session settings only apply when `codex` is enabled here.
- `codexHistoryViewer.sessionsRoot`: Root folder of Codex sessions. Leave empty to use the default (`~/.codex/sessions`).
- `codexHistoryViewer.codex.archivedSessions.enabled`: Load Codex `archived_sessions` in addition to normal Codex sessions when `codexHistoryViewer.sources.enabled` includes `codex`.
- `codexHistoryViewer.codex.archivedSessionsRoot`: Root folder of Codex archived sessions. Leave empty to use a sibling `archived_sessions` folder next to the Codex sessions root.
- `codexHistoryViewer.claude.sessionsRoot`: Root folder of Claude Code sessions. Leave empty to use the default (`~/.claude/projects`).
- `codexHistoryViewer.handoff.enabled`: Show cross-agent handoff actions in session context menus. Cleanup and Status metrics remain available when disabled.
- `codexHistoryViewer.preview.openOnSelection`: Open a preview when selecting an item
- `codexHistoryViewer.preview.maxMessages`: Max number of user/assistant messages to include in tooltips and quick previews
- `codexHistoryViewer.preview.tooltipMode`: How much information session tree tooltips show (`full`, `compact`, or `titleOnly`)
- `codexHistoryViewer.search.defaultRoles`: Default roles used when running Search
- `codexHistoryViewer.search.indexToolContent`: How much tool content the search index stores (`conversationOnly`, `toolCalls`, or `toolCallsAndOutputs`)
- `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled`: Show **File AI Change History** in the Explorer file context menu
- `codexHistoryViewer.search.caseSensitive`: Whether search is case-sensitive
- `codexHistoryViewer.search.maxResults`: Max number of search hits to collect
- `codexHistoryViewer.history.dateBasis`: Which session date the History tree and date-based search filters use (`started` or `lastActivity`)
- `codexHistoryViewer.history.titleSource`: How session titles are resolved (`generated` or `nativeWhenAvailable`)
- `codexHistoryViewer.autoRefresh.enabled`: Automatically refresh History and opt-in chat tabs when local session files change. Disabled by default.
- `codexHistoryViewer.autoRefresh.debounceMs`: Delay before automatic refresh after a local session file change. Multiple nearby events are merged.
- `codexHistoryViewer.autoRefresh.minIntervalMs`: Minimum automatic refresh interval. Higher values reduce refresh frequency during active writes.
- `codexHistoryViewer.chat.openPosition`: Where a chat session opens when returning to a previously viewed session (`top`, `lastMessage`, or `latest`)
- `codexHistoryViewer.chat.performanceMode`: Default history-view performance mode (`auto`, `normal`, or `simplified`)
- `codexHistoryViewer.chat.toolDisplayMode`: How tool activity appears in the chat viewer (`detailsOnly` or `compactCards`)
- `codexHistoryViewer.chat.userLongMessageFolding`: How long `user` messages are folded in the chat viewer (`off`, `auto`, or `always`)
- `codexHistoryViewer.chat.assistantLongMessageFolding`: How long `assistant` messages are folded in the chat viewer (`off`, `auto`, or `always`)
- `codexHistoryViewer.images.enabled`: Show supported image attachments in the chat viewer
- `codexHistoryViewer.images.maxSizeMB`: Maximum image size to load for preview and saving
- `codexHistoryViewer.images.thumbnailSize`: Thumbnail size for image attachments (`small`, `medium`, or `large`)
- `codexHistoryViewer.resume.openTarget`: Where `Resume in OpenAI Codex` opens the conversation (`sidebar` by default, or `panel`)
- `codexHistoryViewer.delete.useTrash`: When deleting, move files to the OS trash/recycle bin (recommended)
- `codexHistoryViewer.ui.language`: UI language for this extension (`auto` / `en` / `ja`)
- `codexHistoryViewer.ui.timeGuide.enabled`: Enable compact date guides and bookmark controls in history views
- `codexHistoryViewer.ui.alwaysShowHeaderActions`: Always show view header action icons (enables VS Code setting `workbench.view.alwaysShowHeaderActions`)
- `codexHistoryViewer.debug.logging.enabled`: Write diagnostic timing logs to the **Codex History Viewer** output channel. Disabled by default and intended for troubleshooting.

### Enable Claude Source (Optional)

- Open Settings and add `claude` to **Codex History Viewer > Sources: Enabled**.
- If needed, set **Codex History Viewer > Claude: Sessions Root**.

### Enable Codex Archived Sessions (Optional)

- Make sure **Codex History Viewer > Sources: Enabled** includes `codex`.
- Turn on **Codex History Viewer > Codex > Archived Sessions: Enabled**.
- Optionally set **Codex History Viewer > Codex > Archived Sessions Root**. Leave it empty to use a sibling `archived_sessions` folder next to the Codex sessions root.
- Use the archive visibility button in **History**, **Pinned**, or **Search** to switch between active only, all, and archived only without changing settings.

### Maintenance Tip (All Sources)

- If history or search results look incorrect or stale, run **Control > Rebuild Cache**. It recreates both the history cache and the search index after confirmation.
- If you want new or updated local sessions to appear without manual refresh, enable the History auto-refresh setting. Automatic refresh runs while the History view is visible or an auto-refresh-enabled chat tab is open, and only while the VS Code window is focused.
- Auto-refresh reacts to local session file changes. For Codex sessions, assistant output may be written to `rollout-*.jsonl` only after a response or turn is complete, so chat tabs may not update token-by-token while the answer is still streaming.
- When the Codex source and Codex archived sessions are both enabled, auto-refresh also watches the archived sessions root.
- If chat tab auto-refresh still feels delayed after the session file changes, try lowering `codexHistoryViewer.autoRefresh.debounceMs` and/or `codexHistoryViewer.autoRefresh.minIntervalMs`. Lower values feel more live but can increase CPU and disk activity.
- Very large session files or sessions with many diff entries can take longer to render in the chat viewer. If switching back to a tab feels slow, set `codexHistoryViewer.chat.performanceMode` to `auto` or `simplified`, or use the header performance button for that view.
- Handoff files are stored in VS Code global storage. Use **Control > Delete Handoff Files** when you want to remove generated handoff files.
- To prevent the cache folder from growing over time, regularly run **Control > Empty Trash**. Trash files are not deleted automatically, and this also removes legacy cache/index generations.
- For performance troubleshooting, enable `codexHistoryViewer.debug.logging.enabled` in `settings.json`, then inspect **Output > Codex History Viewer**. Logs include counts and timings, not session paths or message content.

## OpenAI Codex Integration Notes

- When you run `Resume in OpenAI Codex` for the first time, VS Code may show a security prompt asking whether the target extension can open the URI.
- This is expected VS Code behavior for extension URI handlers (`vscode://...`).
- If you click **Cancel**, resume will not proceed. Click **Open** to allow the resume URI.
- If you check "Do not ask me again for this extension", future resumes will not show the same prompt.
- You can manage previously authorized extension URIs from Command Palette: `Extensions: Manage Authorized Extension URIs...`
- If the official Codex extension stops reopening a conversation, try these VS Code commands before reloading the whole window: `Developer: Reload Webviews`, then `Developer: Restart Extension Host`, then `Developer: Reload Window`.
- **Move to Archive** and **Move to Codex History** use the official Codex provider when available. Moving archived sessions back to normal history can fall back to a filesystem move if the official provider is unavailable.

## Import/Export behavior

- Export supports session/day/month/year selections and uses one timestamped output root per operation.
- Selecting a folder-level node exports all sessions under that node.
- Multi-select export preserves `YYYY/MM/DD` hierarchy for each source session.
- Import recursively scans the selected source folder for `.jsonl` files.
- Import duplicate session IDs can be handled as `skip` or `overwrite` at runtime.

## What's New in 2.2.0

- Optional Codex `archived_sessions` support, including archived root configuration and instant active/all/archived-only controls for History, Pinned, and Search.
- **Sources: Enabled** remains the top-level source switch; Codex archived sessions are used only when Codex is enabled there.
- Faster startup when a valid history cache is available: History and Pinned views can appear before the background refresh finishes.
- **Move to Archive** for active Codex sessions and **Move to Codex History** for archived Codex sessions, preferring the official Codex provider.
- Archive-aware search, Status metrics, Chat/Markdown location labels, pin path tracking, and metadata relocation for moved sessions.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Security

See [SECURITY](SECURITY.md). Use the latest release whenever possible; do not install or redistribute v1.2.1 or earlier VSIX files.

## Disclaimer

Codex History Viewer is an independent project and is not affiliated with, endorsed by, or officially associated with OpenAI, Anthropic, Codex, or Claude.

This extension works with locally stored session and history files created by official tools and extensions. Their file formats and internal behaviors may change without notice, which may affect compatibility.

Archive, restore, delete, import, and other file operations are designed to be conservative, but they may move or modify local files and extension-managed metadata. The author and contributors cannot guarantee recovery of lost or corrupted data.

Please keep backups of important session data.

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Quick Prompt** or **Copy Handoff Prompt to Clipboard**, this extension copies session context to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths (e.g., the session file path and CWD). Review before sharing.

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support%20this%20project-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/hiztam)
