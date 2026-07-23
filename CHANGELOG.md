# Changelog

All notable changes to this project will be documented in this file.

## [2.8.1] - 2026-07-23

### Changed

- Renamed **Open Session in New Tab** to **Open Session in Dedicated Tab** to clarify that the session remains assigned to that tab. Dedicated tabs now use a filled source icon so they can be distinguished from the reusable session tab in both light and dark themes.

### Fixed

- Fixed an issue where selecting a session already open in a dedicated tab could also open it in the reusable tab, resulting in the same session appearing in two tabs.

## [2.8.0] - 2026-07-21

### Added

- Added History Insights for sessions matching the current History filters, with overview metrics, an activity heatmap, breakdowns by source, model, project, and tool, the most active sessions, frequently changed files, usage details covering input caching and reasoning, message composition, turn states, and changed file types, plus data quality information.
- Added Agent Runs, which currently supports Codex sessions only. It omits sub-agent sessions with an available parent from History while keeping them reachable through the parent session's Agent Runs panel, Search, and explicit Pinned entries, and shows parent, sibling, and descendant relationships in a right-side tree within the session view. Sub-agent sessions whose parent cannot be resolved safely remain visible in History. (Experimental; disabled by default.)
- Added Branch Navigation for switching between locally forked Codex session histories—including histories created with **Fork locally** or **Continue in new task**—and Claude Code histories created with **Fork conversation** within their respective session views. The route tree shows shared history, Fork points, and the start and end of each route. Codex Forks created in a new worktree are not supported. (Experimental; disabled by default.)

### Changed

- Updated the distributed Markdown renderer to `markdown-it@14.3.0` with `linkify-it@5.0.2`, while retaining defense-in-depth protections that disable fuzzy email and `mailto:` auto-detection.
- Standardized terminology across commands, settings, and documentation: the viewer is now called the Session Viewer, chronological content is called the session timeline, and individual entries are called messages.
- Session runtime context and local-command output are shown as collapsed cards instead of raw user messages.

### Fixed

- Kept seconds visible in completed and running turn durations after they exceed one hour.

## [2.7.0] - 2026-07-02

### Added

- Added an opt-in Codex session turn timeline, showing turn starts, turn ends, turn ranges, and running state in live mode.
- Added the `codexHistoryViewer.chat.turnTimeline.mode` setting to control the turn timeline. It defaults to `off`; `basic` shows turn boundaries, summaries, and manual folding for completed turns, while `live` also enables running-turn indicators, elapsed time, and update activity effects.
- Added manual collapse and expand support for completed turns.
- Added compact file summaries for patch group cards.
- Added an in-place **Open all diffs** / **Close all diffs** action for patch group cards.
- Added structured cards for Claude Code task notifications and raw `<invoke>` tool invocations while keeping internal IDs, local output paths, preambles, and raw notes out of normal views.

### Changed

- Improved auto-refresh `follow` mode and session timeline scrolling to the top, bottom, and latest positions.
- Improved File AI Change History in-page search result badges to show the matching card number and distinguish before/after diff lines.

### Fixed

- Hardened turn timeline edge cases for clock skew, compact duration formatting, narrow running-turn chips, and sticky user prompt switching.

## [2.6.1] - 2026-06-22

### Added

- Added dedicated request-interruption cards for Codex and Claude Code history.
- Added interruption details when available, including reason, duration, turn ID, rollback state, and rolled-back turn count.

## [2.6.0] - 2026-06-12

### Added

- Added sorting to the History view by started date, last activity date, and name in ascending or descending order.
- Added sorting to the Pinned view by pinned time, started date, last activity date, and name in ascending or descending order.
- Added workspace-scoped persistence for History and Pinned sort preferences.

### Changed

- Moved Pinned sorting into the More Actions menu and removed the pinned sort toggle from the view header.

### Fixed

- Improved History view selection tracking after changing the display mode or sort order.

## [2.5.1] - 2026-06-10

### Fixed

- Fixed cache cleanup so `Empty Trash` no longer treats the current history cache as a legacy file.
- Centralized current cache and search index file names to prevent drift between write paths and maintenance cleanup.
- Hardened history cache, search index, and JSON persistence handling so regeneratable corrupt files can be cleaned up safely.

## [2.5.0] - 2026-06-07

### Added

- Added **Project Association** so history from another project can be linked into the current project view or grouped together as related projects.
- Added **List / Project** display switching and **All / Current Project Group** scope switching to the History and Pinned views.
- Added shared search history for global search, in-history search, and file change history search.
- Added search handoff from Search results into in-history search using the same query.
- Added more flexible query expressions, including regular expressions and exact matching, to in-history search and file change history search.
- Added search history suggestions, selection, and deletion to in-history search and file change history search.
- Added collapsible display for Codex memory citation information in the history view.
- Added a sticky current user prompt display at the top of the session timeline.
- Added project-association awareness to handoff generation so handoff content follows the associated project display.

### Changed

- Reworked project display controls in the History and Pinned views so display mode and target scope can be switched independently.
- Changed global search to follow the current History view target, including project scope, tags, Codex/Claude source, archive visibility, and date filters.
- Improved the global search input so manual search, rerunning from search history, and per-item search history deletion are available from the same QuickPick.
- Changed saved searches to store, display, and reuse only the search query. Role filters and case sensitivity are taken from the current settings when the saved search is run. Saved searches remain shared globally instead of being separated by project, and can be removed individually from the run QuickPick with a trash button.
- Changed the Search view so filter controls live in the History view. Search uses the current History target as its scope, does not generate results from filters alone, and only re-evaluates existing results when the History scope changes.
- Changed file change history so it follows the project-associated display when resolving related history.

### Fixed

- Fixed file change history search so “No more history” is not matched by page search.
- Fixed Pinned project ordering when multiple projects are updated at the same time.

## [2.4.1] - 2026-05-26

### Added

- Added project aliases for project `cwd` values, stored in extension state without modifying Codex or Claude Code history files.
- Added project alias display across History and Pinned project headings, session descriptions, tooltips, filter summaries, Status, and Search scope/session display.
- Added Undo support for setting and clearing project aliases.
- Added an experimental opt-in **Restore Webview Tabs After Reload** setting to restore session and file change history Webview tabs after Reload Window or VS Code restart. It is disabled by default because VS Code can defer Webview restoration and may occasionally create duplicate tabs when the same history is opened again.
- Added rendering for Codex code review comments as readable cards in the session Webview.

### Changed

- Changed archive visibility summaries from `Location` to `Archive` to avoid confusing them with project paths.
- Improved in-Webview search responsiveness by debouncing search updates while typing.

### Fixed

- Preserved the in-Webview search panel width when the window is resized below 860px. The panel no longer forces full width or hides the resize handle in narrow viewports.

## [2.4.0] - 2026-05-23

### Added

- Added project display modes to the History view: No Project Filter, Current Project, and Group by Project.
- Added project-grouped History trees that preserve the existing latest-first and date-grouped layouts.
- Added independent Pinned project display modes, separate from the History project state.
- Added independent Pinned filtering for date scope, project, source, archive visibility, and tags.
- Added a Pinned source switch for All, Codex, and Claude Code.
- Added independent Pinned archive visibility controls for Active Only, All, and Archived Only.
- Added a Pinned sort mode switch between pinned date order and session date order.
- Added a Pinned clear-filters action.

### Changed

- Changed project matching to use case-insensitive normalized project keys across platforms.
- Changed History clear-filter toolbar behavior so the action remains visible and is disabled when no filters can be cleared.
- Changed project-mode toolbar icons to represent the current project display state.
- Changed Pinned archived-session visibility so it follows Pinned-specific source and archive filters instead of the History/Search archive state.
- Changed the Pinned archive visibility toggle to show as disabled when Pinned source is set to Claude Code only.
- Changed Pinned project tooltips to distinguish the latest pinned time from the latest session time depending on the active sort mode.
- Changed Search toolbar ordering so Clear Results appears before Rerun Search.

### Fixed

- Fixed Codex `# Files mentioned by the user:` blocks appearing after IDE context not being rendered as file-reference attachments.

## [2.3.0] - 2026-05-22

### Added

- Added a unified session attachment model so images, Claude documents, Claude IDE file and selection references, and Codex mentioned files are represented as `attachments`.
- Added Claude Code document cards for PDF, text, and generic documents, including on-demand preview and Save As support without sending embedded binary payloads to the initial Webview model.
- Added parsing for Claude Code `<ide_opened_file>` and `<ide_selection>` tags, rendering them as file reference and selection reference cards instead of raw inline tags.
- Added parsing for Codex `# Files mentioned by the user:` blocks, rendering mentioned Word, Excel, PowerPoint, PDF, archive, text, and other files as file reference cards while keeping only the request body as message text.
- Added compact attachment cards with file-kind badges, kind-specific icon accents, tooltip metadata for paths / MIME types / sizes, and action icons for preview, save, or open.
- Added attachment indicators and localized attachment summaries to the session date guide so messages with images, other attachments, or mixed attachment types are visible from the timeline tooltip.
- Added attachment metadata to the search index, including labels, paths, MIME types, file kinds, and bounded text from Claude text documents.

### Changed

- Changed session timeline rendering to preserve attachment order while grouping only consecutive images into existing image groups.
- Changed Markdown transcript, Resume, and Handoff generation to use clean text plus attachment summaries instead of repeating raw IDE tags or Codex mentioned-file blocks.
- Changed search indexing to exclude PDF / Office / binary / base64 document contents and to avoid reading Codex referenced files automatically.
- Bumped the search-index internal file version so existing indexes are rebuilt with attachment metadata.

## [2.2.0] - 2026-05-21

### Added

- Added optional Codex `archived_sessions` support alongside normal Codex `sessions`, with configurable archive enablement and archive root path under the Codex source.
- Added archived-session visibility controls for History, Pinned, and Search views with Active Only, All, and Archived Only modes.
- Added archive-aware History, Search, Markdown transcript, and session timeline rendering, including archived location labels and archived visual markers.
- Added **Move to Archive** for active Codex sessions and **Move to Codex History** for archived Codex sessions, using the official Codex provider when available.
- Added filesystem fallback for moving archived sessions back to normal Codex history, including conflict-safe destination handling and Undo support for fallback moves.
- Added multi-select support for moving Codex sessions to archive or back to Codex history, with sequential bulk execution and partial-result notifications.
- Added archive-aware pin tracking so pinned Codex sessions can follow official archive/unarchive path changes by session identity.
- Added metadata relocation for archive/unarchive and pin reconciliation, covering annotations, bookmarks, and saved session-view positions when paths move.
- Added Status rows for Codex archived session count and Codex archived sessions root when both the Codex source and archived sessions are enabled.

### Changed

- `Sources: Enabled` remains the top-level source switch for Codex and Claude Code; Codex archived sessions are disabled whenever the Codex source is disabled.
- Moved `Sources: Enabled` to the top of the extension settings so the archived-session settings read as Codex child options.
- Improved initial history startup by showing a valid cached history index immediately, then refreshing local session files in the background.
- Archived Codex sessions no longer expose Resume or Promote actions; their primary action is moving them back to Codex history.
- Active and archived Codex context menus now show only the relevant move action, separated from custom-title actions and delete actions.
- Session Webviews for archived Codex sessions replace **Resume in Codex** with **Move to Codex History**.

## [2.1.0] - 2026-05-19

### Added

- Added cross-agent handoff between Codex and Claude Code, generating per-session `handoff.md` files in extension global storage with transcript excerpts and recoverable file changes.
- Added the **Handoff to Other AI** context submenu with commands to hand off to Claude Code, create a handoff file, copy a handoff prompt to the clipboard, and open or create a session handoff file.
- Added clipboard-based Claude-to-Codex handoff prompts and Claude Code opening via `claude-vscode.editor.open`.
- Added handoff storage cleanup plus Status view metrics for handoff count and storage size.

### Changed

- Renamed the lightweight session resume copy action to **Copy Quick Prompt** and kept it separate from full handoff commands.

## [2.0.1] - 2026-05-15

### Added

- Added bookmark toggles to history cards.
- Added bookmark and user markers to the date guide.
- Added a density-aware date-guide lens that expands crowded timeline regions, follows the original guide hover position, and uses the active lens item as the click target.
- Added an icon to the file-change history **Open in History** button.

## [2.0.0] - 2026-05-14

### Added

- Added file-level **File AI Change History** for workspace files, available from the opt-in **File Change History > Explorer Context Menu: Enabled** setting, with source toggles, in-page search, paging, source-aware card navigation, and links back to the matching diff card in the original session view.
- Added history-view performance modes for large histories, including a simplified mode that loads heavy diff/detail sections on demand.
- Added the `latest` option to `codexHistoryViewer.chat.openPosition` so sessions can open at the latest rendered card.
- Added optional compact date guides for history and file-change views that can be enabled or disabled from settings.
- Added settings:
  - `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled`
  - `codexHistoryViewer.chat.performanceMode`
  - `codexHistoryViewer.ui.timeGuide.enabled`

### Changed

- Custom title actions now use a shared QuickPick flow from tree context menus and the session viewer header.
- Codex `apply_patch` activity is now shown as diff cards when possible, while duplicate cards are avoided when matching `patch_apply_end` events are also present.
- Codex diff cards now aggregate repeated updates to the same file within a single turn.

## [1.5.1] - 2026-05-08

### Changed

- Changed session auto-refresh `follow latest` scrolling to prefer the latest non-diff content card when trailing grouped diff cards are last. The bottom scroll action targets the latest rendered card.
- Changed search indexing for Codex `custom_tool_call` records so `toolCalls` and `toolCallsAndOutputs` include lightweight tool metadata such as actions, commands, files, and paths.

### Fixed

- Fixed session auto-refresh `follow latest` scrolling sometimes being overridden by pending card-anchor restoration or later layout updates.
- Fixed `lastMessage` session-view position saving and restoring when no message bubble is visible, falling back to the previous rendered message or the top.

## [1.5.0] - 2026-05-07

### Added

- Added extension-local custom titles for Codex and Claude sessions.
- Added session tree tooltip modes (`full`, `compact`, `titleOnly`) so users can choose between detailed metadata and a one-line title-only tooltip.
- Added `codexHistoryViewer.search.indexToolContent` to control whether the search index stores message text only, tool calls, or tool calls plus tool outputs.

## [1.4.3] - 2026-04-30

### Added

- Added `SECURITY.md` with the current security policy and guidance for the `markdown-it` GHSA-38c4-r59v-3vqw / CVE-2026-2327 advisory.
- Added localized initial-loading rows to the History and Pinned views while the first history refresh is still running.

## [1.4.2] - 2026-04-28

### Added

- Added collapsible assistant usage rows in the session viewer when **Show details** is enabled.
- Added helpful History empty-state rows for no-history and no-filter-match states.

## [1.4.1] - 2026-04-24

### Added

- Added a session-tab auto-refresh button in the session viewer header, shown when the History auto-refresh setting is enabled.
- Added per-tab auto-refresh modes: off, preserve current view, and follow latest.
- Added automatic refresh for open session tabs while VS Code is focused, including background editor tabs. Only affected tabs are refreshed, and new or different sessions start with auto-refresh off.
- Added on-demand loading for session image data so large image attachments no longer need to be sent to the Webview during the initial session render.
- Added card-based scroll restoration when toggling session details on or off, including fallback to the next visible card when the previous card is hidden in summary mode.

### Changed

- Deferred heavy tool arguments, tool output, and patch diff rows until details are shown or a diff entry is expanded.

### Fixed

- Preserved session-tab UI state across reload and auto-refresh, including expanded cards/diffs, details visibility, diff wrap state, selected message, in-page search state, and scroll behavior.
- Reset session-scoped Webview UI state when a reusable session tab switches to a different session, including in-page search state, image preview state, and image data cache.

## [1.4.0] - 2026-04-23

### Added

- Added a History view mode switch between date-grouped history and a latest-first flat session list.
- Added opt-in automatic history refresh for local session file changes, with debounce delay and refresh interval settings.
- Automatic refresh is deferred while the History view is hidden or the VS Code window is not focused.
- Added image attachment rendering in the session viewer for supported Codex / Claude image data and local image references.
- Added an option to open sessions from the top or restore near the last viewed message.

### Changed

- Changed session-tab handling so session selection uses a reusable tab, while **Open Session in New Tab** keeps sessions in dedicated tabs and reuses existing matching tabs.
- Changed the session viewer scroll area so the fixed toolbar stays outside the scrollable content.
- Changed the settings display order.

## [1.3.2] - 2026-04-22

### Added

- Added opt-in diagnostic timing logs for history refresh and search-index maintenance.

### Changed

- Capped the in-memory Undo stack at 20 recent actions to avoid unbounded memory growth.
- Changed history refresh to process session files with bounded parallelism for better first-load and cache-miss performance.
- Changed history lookup to use a `Map`-backed index instead of scanning all sessions.
- Changed timestamp handling to use the VS Code extension host time zone.

### Fixed

- Fixed stale session panels for deleted or missing session files by checking file existence before opening/reloading and closing missing panels on refresh/delete.
- Fixed delete Undo cleanup so temporary backup files are removed when Undo actions are discarded, cleared, or completed.
- Made search-index stale-entry cleanup explicit.
- Localized Undo notification labels and action names.

## [1.3.1] - 2026-04-20

### Added

- Added per-card full-width expansion controls in the session viewer for messages, tool cards, notes, and grouped diffs.
- Added previous/next navigation controls to grouped diff cards.

### Changed

- Clarified localization ownership by keeping VS Code manifest strings in `package.nls.*` and runtime/Webview strings in `l10n/bundle.l10n.*`.

### Fixed

- Fixed wording inconsistencies around pinned-session labels, Codex/Claude resume messages, card-width tooltips, and history reload messages.

## [1.3.0] - 2026-04-18

### Added

- Added KaTeX-based equation rendering in the session viewer for inline and block math expressions.
- Added `codexHistoryViewer.history.titleSource` to switch between generated titles and native titles when available.
- Added native title resolution for Codex sessions from `session_index.jsonl`, plus a lightweight cache to preserve known titles for older sessions.

### Changed

- Session list labels and session panel titles can now use native titles when `history.titleSource` is set to `nativeWhenAvailable`.

## [1.2.1] - 2026-04-17

### Added

- Added grouped patch-based change cards in the session viewer by parsing `patch_apply_end` events from session logs.
- Added collapsible side-by-side before/after diffs for patch entries, with per-hunk wrap toggles and jump-to-line actions.
- Added a right-side in-page search sidebar for the session viewer with keyboard shortcuts, match counts, result snippets, and direct result navigation.

### Changed

- Changed patch cards so they are shown even when **Show details** is off, while each file entry remains collapsed by default.

## [1.2.0] - 2026-04-16

### Added

- Added tool-specific cards in the session viewer, with a new `codexHistoryViewer.chat.toolDisplayMode` setting (`detailsOnly` / `compactCards`).
- Added independent long-message folding settings for session-viewer `user` and `assistant` messages:
  - `codexHistoryViewer.chat.userLongMessageFolding`
  - `codexHistoryViewer.chat.assistantLongMessageFolding`
- Added session viewer toolbar quick scroll buttons to jump to the top or bottom of the session timeline.

### Changed

- Session viewer tool rows are now left-aligned and use card-style presentation with icons, accents, and status emphasis.
- Session viewer reload now preserves scroll/selection and refreshes the tab title using the active history date basis.
- The session viewer toolbar now automatically switches label buttons to icon-only mode when the header width becomes narrow.
- Code block copy buttons in the session viewer now use icon-only actions instead of text labels.

### Fixed

- Added support for workspace-relative Markdown file links in both Claude and Codex session views.
- Added transcript-side local link resolution so relative Markdown file links open the source file inside VS Code.
- Fixed session-tab title refresh when `codexHistoryViewer.history.dateBasis` is set to `lastActivity`.

## [1.1.5] - 2026-04-14

### Added

- Added `codexHistoryViewer.history.dateBasis` to switch the History tree and date-based search filters between session start date and last message date.
- Added tooltip date details so sessions can show both `Started` and `Last activity` when they differ.

## [1.1.4] - 2026-04-12

### Added

- Added syntax-highlighted fenced code blocks in the session viewer (powered by Shiki).

## [1.1.3] - 2026-04-07

### Fixed

- Fixed session-viewer local file links so `scripts/deploy.sh#L39` style paths open the file instead of failing.
- Added support for GitHub-style file locations such as `#L39C2` and `#L39-L45` when opening local links from the session view.

## [1.1.2] - 2026-03-06

### Added

- Added a new `Empty Trash` action in the Control view to manually clear internal trash/quarantine files.
- Added Status view metrics for cache folder size.
- Added Status view metrics for trash file count.
- Added inline copy actions for Status view paths (`Current project` / `Sessions root`).

### Changed

- `Rebuild Cache` now asks for confirmation before running.
- `Rebuild Cache` now rebuilds both the history cache and the search index.
- Search index cache files are now written in compact JSON form to reduce storage size.
- Control view actions were reorganized to focus on maintenance/global tasks.
- `Configure Default Search Roles` now uses the same search icon style as the Search view header.

## [1.1.1] - 2026-03-05

### Added

- Added a dedicated command reference page at `docs/commands.md`.

### Changed

- Marketplace description was simplified to a shorter summary sentence.
- README command section now links to `docs/commands.md` for the full command reference.

### Fixed

- Fixed Status view source-awareness:
  - Session counts are now shown per enabled source (`Codex` / `Claude`).
  - Session roots are now shown per enabled source (`Codex` / `Claude`).
  - Pinned count is now aggregated only from enabled sources.

## [1.1.0] - 2026-03-05

### Added

- Optional Claude history support (in addition to Codex history).
- Session Webview tab icons now switch by session source (`Codex` / `Claude`).
- New source settings:
  - `codexHistoryViewer.sources.enabled`
  - `codexHistoryViewer.claude.sessionsRoot`
- New command to continue Claude sessions:
  - `Resume in Claude Code`
- Source filter actions for History:
  - `Show Codex History Only`
  - `Show Claude History Only`
  - `Show All Sources`

### Changed

- `codexHistoryViewer.sources.enabled` default changed to `["codex"]`.
- Source filter behavior is now locked when only one source is enabled (`codex` only or `claude` only).
- Pinned view now follows the active source filter consistently, including missing pinned entries.
- README command list now uses the exact command label `Refresh All`.
- Updated README to document:
  - how to enable Claude from **Codex History Viewer › Sources: Enabled**
  - when to run **Control → Maintenance → Rebuild Cache**

### Fixed

- Fixed compact user rendering so transport tags are hidden only when they are standalone metadata.
- Added line-break normalization after transport tag closing tokens to improve compact user message rendering.

## [1.0.1] - 2026-03-04

### Added

- New session viewer toolbar button to resume directly in OpenAI Codex:
  - `Open in OpenAI Codex`
- New `Pin / Unpin` toggle button next to `Open in OpenAI Codex`.

### Changed

- Reordered session viewer primary toolbar actions to improve continuation workflow:
  - Open in OpenAI Codex
  - Pin / Unpin toggle
- Moved `Open Markdown transcript` and `Copy prompt excerpt` to the right side (before `Show details`).
- Updated localization keys for the new session viewer toolbar actions and tooltips.

### Fixed

- In the session viewer, local file links in Markdown now open inside VS Code instead of launching an external browser tab.

## [1.0.0] - 2026-03-02

### Added

- New `codexHistoryViewer.resume.openTarget` setting to control where `Resume in OpenAI Codex (VS Code Extension)` opens:
  - `sidebar` (default)
  - `panel`

### Changed

- Promoted the extension version to **1.0.0** as the first stable release.
- Default resume behavior now explicitly targets the OpenAI Codex sidebar.
- Updated README and configuration docs to match the 1.0.0 behavior and defaults.

### Fixed

- Completed localization for resume target setting labels/descriptions (including sidebar/panel choices).
- Replaced remaining Japanese source-code comments with English comments for consistency.

## [0.1.4] - 2026-03-02

### Added

- New **Control** and **Status** views for operational actions and runtime metrics.
- Tag-aware workflows across views:
  - History/Pinned/Search tag filters.
  - Search hits for annotation tags/notes (`tag` / `note` sources).
  - Bulk tag operations (`Bulk Rename Tag...`, `Bulk Delete Tags...`) with Undo support.
- Import/Export workflow enhancements:
  - Session import with duplicate ID policy selection (skip or overwrite).
  - Session export as raw JSONL or sanitized Markdown transcripts.
- Search usability actions:
  - `Rerun Search` and `Initialize Search Pane`.
  - Configurable default search roles.
- Maintenance and state visibility enhancements:
  - `Cleanup Missing Pins` action in Control.
  - Status metrics for current project/search roles/search tag filters/total tag count.

### Changed

- View/header action organization and pane-specific refresh behavior were refined across Control/Pinned/History/Search/Status.
- Search and status displays now reflect current role/tag filtering context more clearly.
- Command and UI localization coverage was expanded for Japanese/English labels.
- Import/export handling was aligned to operational workflows:
  - Recursive `.jsonl` import from a selected folder.
  - Timestamped export root with preserved date hierarchy for multi-selection exports.

### Fixed

- Search preset execution reveal flow by ensuring parent resolution for search tree items.
- Multiple localization inconsistencies in command palette labels and toast messages.
- Post-operation guidance now reminds users to reload Codex CLI history when file changes are made while Codex is running.

## [0.1.3] - 2026-02-09

### Added

- New `Filter by Current Project` command in the History view toolbar.
- New localized message shown when filtering by current project without an open folder/workspace.

### Changed

- Current-project filtering now resolves the active workspace first, then falls back to the first workspace folder.
- Matching logic now prefers session CWDs under the workspace and otherwise selects the nearest ancestor path.
- Running the same current-project filter command again now toggles the project filter off.

## [0.1.2] - 2026-02-06

### Added

- Copy Prompt Excerpt support for continuing a selected session in the official OpenAI Codex VS Code extension.
- New session management commands in both Japanese and English.
- A new utility for resolving date/time settings (UI language + time zone).

### Changed

- Context menus now show language-specific commands based on the selected UI language.
- Date/time formatting now follows the resolved time zone.
- Session panel titles now refresh based on session data.
- Session summaries now include time zone-aware date and time.
- Transcript rendering now displays timestamps in the correct time zone.

### Updated

- SVG icons for better visual representation.

## [0.1.1] - 2026-01-20

### Changed

- Improved documentation and in-code comments for clarity.
- Updated Marketplace metadata (categories/keywords and repository/homepage links).

## [0.1.0] - 2026-01-20

### Added

- Initial release.
- Views: **Pinned**, **History**, and **Search**.
- Session viewer (Webview) with Markdown rendering, copy actions, and **Open Session as Markdown**.
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity).
- Session management: promote (copy to today), pin/unpin, and safe deletion (trash/recycle bin with fallback quarantine).
- Multi-select support for open/pin/promote/delete and drag & drop pinning.
