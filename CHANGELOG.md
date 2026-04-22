# Changelog

All notable changes to this project will be documented in this file.

## [1.3.2] - 2026-04-22

### Added

- Added opt-in diagnostic timing logs for history refresh and search-index maintenance.

### Changed

- Capped the in-memory Undo stack at 20 recent actions to avoid unbounded memory growth.
- Changed history refresh to process session files with bounded parallelism for better first-load and cache-miss performance.
- Changed history lookup to use a `Map`-backed index instead of scanning all sessions.
- Changed timestamp handling to use the VS Code extension host time zone.

### Fixed

- Fixed stale chat panels for deleted or missing session files by checking file existence before opening/reloading and closing missing panels on refresh/delete.
- Fixed delete Undo cleanup so temporary backup files are removed when Undo actions are discarded, cleared, or completed.
- Made search-index stale-entry cleanup explicit.
- Localized Undo notification labels and action names.

## [1.3.1] - 2026-04-20

### Added

- Added per-card full-width expansion controls in the chat viewer for messages, tool cards, notes, and grouped diffs.
- Added previous/next navigation controls to grouped diff cards.

### Changed

- Clarified localization ownership by keeping VS Code manifest strings in `package.nls.*` and runtime/Webview strings in `l10n/bundle.l10n.*`.

### Fixed

- Fixed wording inconsistencies around pinned-session labels, Codex/Claude resume messages, card-width tooltips, and history reload messages.

## [1.3.0] - 2026-04-18

### Added

- Added KaTeX-based equation rendering in the chat viewer for inline and block math expressions.
- Added `codexHistoryViewer.history.titleSource` to switch between generated titles and native titles when available.
- Added native title resolution for Codex sessions from `session_index.jsonl`, plus a lightweight cache to preserve known titles for older sessions.

### Changed

- Session list labels and chat panel titles can now use native titles when `history.titleSource` is set to `nativeWhenAvailable`.

## [1.2.1] - 2026-04-17

### Added

- Added grouped patch-based change cards in the chat viewer by parsing `patch_apply_end` events from session logs.
- Added collapsible side-by-side before/after diffs for patch entries, with per-hunk wrap toggles and jump-to-line actions.
- Added a right-side in-page search sidebar for the chat viewer with keyboard shortcuts, match counts, result snippets, and direct result navigation.

### Changed

- Changed patch cards so they are shown even when **Show details** is off, while each file entry remains collapsed by default.

## [1.2.0] - 2026-04-16

### Added

- Added tool-specific cards in the chat viewer, with a new `codexHistoryViewer.chat.toolDisplayMode` setting (`detailsOnly` / `compactCards`).
- Added independent long-message folding settings for chat viewer `user` and `assistant` messages:
  - `codexHistoryViewer.chat.userLongMessageFolding`
  - `codexHistoryViewer.chat.assistantLongMessageFolding`
- Added chat toolbar quick scroll buttons to jump to the top or bottom of the session.

### Changed

- Chat tool rows are now left-aligned and use card-style presentation with icons, accents, and status emphasis.
- Chat viewer reload now preserves scroll/selection and refreshes the tab title using the active history date basis.
- Chat toolbar now automatically switches label buttons to icon-only mode when the header width becomes narrow.
- Code block copy buttons in the chat viewer now use icon-only actions instead of text labels.

### Fixed

- Added support for workspace-relative Markdown file links in both Claude and Codex session views.
- Added transcript-side local link resolution so relative Markdown file links open the source file inside VS Code.
- Fixed chat tab title refresh when `codexHistoryViewer.history.dateBasis` is set to `lastActivity`.

## [1.1.5] - 2026-04-14

### Added

- Added `codexHistoryViewer.history.dateBasis` to switch the History tree and date-based search filters between session start date and last message date.
- Added tooltip date details so sessions can show both `Started` and `Last activity` when they differ.

## [1.1.4] - 2026-04-12

### Added

- Added syntax-highlighted fenced code blocks in the chat-like viewer (powered by Shiki).

## [1.1.3] - 2026-04-07

### Fixed

- Fixed chat-viewer local file links so `scripts/deploy.sh#L39` style paths open the file instead of failing.
- Added support for GitHub-style file locations such as `#L39C2` and `#L39-L45` when opening local links from the chat view.

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
- Chat Webview tab icons now switch by session source (`Codex` / `Claude`).
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

- New chat viewer toolbar button to resume directly in OpenAI Codex:
  - `Open in OpenAI Codex`
- New `Pin / Unpin` toggle button next to `Open in OpenAI Codex`.

### Changed

- Reordered chat viewer primary toolbar actions to improve continuation workflow:
  - Open in OpenAI Codex
  - Pin / Unpin toggle
- Moved `Open Markdown transcript` and `Copy prompt excerpt` to the right side (before `Show details`).
- Updated localization keys for the new chat toolbar actions and tooltips.

### Fixed

- In the chat viewer, local file links in Markdown now open inside VS Code instead of launching an external browser tab.

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
- Chat panel titles now refresh based on session data.
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
- Chat-like viewer (Webview) with Markdown rendering, copy actions, and "Open as Markdown".
- Full-text search across sessions (cancellable, configurable max results, optional case sensitivity).
- Session management: promote (copy to today), pin/unpin, and safe deletion (trash/recycle bin with fallback quarantine).
- Multi-select support for open/pin/promote/delete and drag & drop pinning.
