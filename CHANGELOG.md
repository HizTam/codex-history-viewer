# Changelog

All notable changes to this project will be documented in this file.

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
