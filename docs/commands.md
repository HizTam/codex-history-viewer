# Command Reference

This document lists user-facing command IDs and what each command does.

Notes:
- Labels shown in VS Code can appear in English or Japanese based on your `codexHistoryViewer.ui.language` setting.
- This page focuses on base command IDs (for example, `codexHistoryViewer.search`) and excludes internal UI alias commands (`codexHistoryViewer.ui.*`).

## Refresh and Maintenance

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Refresh All | `codexHistoryViewer.refresh` | Refreshes all extension views and reloads session data. |
| Refresh Pinned | `codexHistoryViewer.refreshPinned` | Refreshes only the Pinned view. |
| Refresh History | `codexHistoryViewer.refreshHistoryPane` | Refreshes only the History view. |
| Refresh Status | `codexHistoryViewer.refreshStatusPane` | Refreshes only the Status view. |
| Open Settings | `codexHistoryViewer.openSettings` | Opens the categorized settings page. Its Maintenance page provides scope-specific settings backups and access to VS Code Settings for advanced editing. |
| Rebuild Cache | `codexHistoryViewer.rebuildCache` | Rebuilds the history, search, and analysis caches from the current source sessions. |
| Rebuild Search Index | `codexHistoryViewer.rebuildSearchIndex` | Rebuilds only the local search index from source files. |
| Remove Missing Pins | `codexHistoryViewer.cleanupMissingPins` | Removes pinned entries whose source files no longer exist. |
| Delete Handoff Files | `codexHistoryViewer.cleanupHandoffs` | Deletes generated handoff files from extension global storage after confirmation. |
| Empty Trash | `codexHistoryViewer.emptyTrash` | Clears internal trash/quarantine files and legacy cache/index generations after confirmation. |
| Copy Path | `codexHistoryViewer.copyStatusPath` | Copies the selected Status view path or value to the clipboard. |
| Undo Last Action | `codexHistoryViewer.undoLastAction` | Reverts the latest undoable operation. |

## History, Pinned, and Source Filters

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Filter History... | `codexHistoryViewer.filterHistory` | Opens the History filter picker (date range/projects/source/display target/tags). |
| Filter History by Tags... | `codexHistoryViewer.filterHistoryByTag` | Applies a tag-based filter to the History view. |
| Filter by Current Project | `codexHistoryViewer.filterHistoryCurrentProject` | Switches History to the session-list display and toggles its scope between all projects and the current project group. |
| Show by Project | `codexHistoryViewer.showHistoryProjectGrouped` | Groups History sessions by project and clears the current-project-group scope. |
| Clear Project Mode | `codexHistoryViewer.clearHistoryProjectMode` | Returns History to the ungrouped session list across all projects and clears an explicit project selection. |
| Toggle History Project Display | `codexHistoryViewer.toggleHistoryProjectDisplay` | Toggles History between the session list and project-grouped display. |
| Toggle History Current Project Group Scope | `codexHistoryViewer.toggleHistoryProjectScope` | Toggles History between all projects and the current workspace's associated project group. |
| Show Sessions List | `codexHistoryViewer.showHistoryLatestView` | Switches History to the flat session-list view while preserving the selected sort order. |
| Show by Date | `codexHistoryViewer.showHistoryDateView` | Switches History to the date-grouped view. |
| Toggle History View Format | `codexHistoryViewer.toggleHistoryViewMode` | Toggles History between the flat session-list and date-grouped views while preserving the selected sort order. |
| Show Codex History Only | `codexHistoryViewer.filterHistorySourceCodex` | Limits History to Codex sessions only. |
| Show Claude Code History Only | `codexHistoryViewer.filterHistorySourceClaude` | Limits History to Claude Code sessions only. |
| Toggle Codex Source Filter | `codexHistoryViewer.toggleHistorySourceCodex` | Toggles Codex in the active source filter. |
| Toggle Claude Code Source Filter | `codexHistoryViewer.toggleHistorySourceClaude` | Toggles Claude Code in the active source filter. |
| Cycle Source Filter (Codex + Claude Code -> Codex -> Claude Code) | `codexHistoryViewer.cycleHistorySourceFilter` | Cycles History through all enabled sources, Codex only, and Claude Code only. |
| Show All Sources | `codexHistoryViewer.clearHistorySourceFilter` | Clears source-only filtering and shows enabled sources. |
| Clear History Filters | `codexHistoryViewer.clearHistoryFilter` | Resets History date, explicit project, source, display-target, and tag filters. The Current Project Group scope remains active when selected. |
| Clear History Tag Filter | `codexHistoryViewer.clearHistoryTagFilter` | Removes the active History tag filter. |
| Cycle History Display Target | `codexHistoryViewer.filterHistoryDisplayTarget` | Cycles History and its Search scope through the available display targets. With Codex archive support enabled, the order is active only, active + archived, archived only, hidden only, and all. |
| History Display Target: Active Only | `codexHistoryViewer.setHistoryDisplayTargetActiveVisible` | Shows non-hidden sessions from normal session locations only. |
| History Display Target: Active + Archived | `codexHistoryViewer.setHistoryDisplayTargetVisibleAllLocations` | Shows non-hidden sessions from normal session locations and the Codex archive. |
| History Display Target: Archived Only | `codexHistoryViewer.setHistoryDisplayTargetArchivedVisible` | Shows non-hidden Codex sessions from the archive only. |
| History Display Target: Hidden Only | `codexHistoryViewer.setHistoryDisplayTargetHiddenAllLocations` | Shows hidden sessions from every available session location. |
| History Display Target: All | `codexHistoryViewer.setHistoryDisplayTargetAll` | Shows visible and hidden sessions from every available session location. |
| Filter Pinned... | `codexHistoryViewer.filterPinned` | Opens the independent Pinned filter picker (date/project/source/display target/tags). |
| Filter Pinned by Current Project | `codexHistoryViewer.filterPinnedCurrentProject` | Switches Pinned to the session-list display and toggles its scope between all projects and the current project group. |
| Show Pinned by Project | `codexHistoryViewer.showPinnedProjectGrouped` | Groups pinned sessions by project and clears the current-project-group scope. |
| Clear Pinned Project Mode | `codexHistoryViewer.clearPinnedProjectMode` | Returns Pinned to the ungrouped session list across all projects and clears an explicit project selection. |
| Toggle Pinned Project Display | `codexHistoryViewer.togglePinnedProjectDisplay` | Toggles Pinned between the session list and project-grouped display. |
| Toggle Pinned Current Project Group Scope | `codexHistoryViewer.togglePinnedProjectScope` | Toggles Pinned between all projects and the current workspace's associated project group. |
| Filter Pinned by Tags... | `codexHistoryViewer.filterPinnedByTag` | Applies a tag filter to the Pinned view. |
| Clear Pinned Filters | `codexHistoryViewer.clearPinnedFilter` | Resets Pinned date, explicit project, source, display-target, and tag filters. The Current Project Group scope remains active when selected. |
| Clear Pinned Tag Filter | `codexHistoryViewer.clearPinnedTagFilter` | Removes the active Pinned tag filter. |
| Cycle Pinned Display Target | `codexHistoryViewer.filterPinnedDisplayTarget` | Independently cycles Pinned through the available display targets. With Codex archive support enabled, the order is active only, active + archived, archived only, hidden only, and all. |
| Pinned Display Target: Active Only | `codexHistoryViewer.setPinnedDisplayTargetActiveVisible` | Shows non-hidden pinned sessions from normal session locations only. |
| Pinned Display Target: Active + Archived | `codexHistoryViewer.setPinnedDisplayTargetVisibleAllLocations` | Shows non-hidden pinned sessions from normal session locations and the Codex archive. |
| Pinned Display Target: Archived Only | `codexHistoryViewer.setPinnedDisplayTargetArchivedVisible` | Shows non-hidden pinned Codex sessions from the archive only. |
| Pinned Display Target: Hidden Only | `codexHistoryViewer.setPinnedDisplayTargetHiddenAllLocations` | Shows hidden pinned sessions from every available session location. |
| Pinned Display Target: All | `codexHistoryViewer.setPinnedDisplayTargetAll` | Shows visible and hidden pinned sessions from every available session location. |

Archived display targets are unavailable when Codex archived sessions are disabled or a view is limited to Claude Code. In those cases, the cycle contains Active Only, Hidden Only, and All.

## Sorting Commands

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Sort History by Started Date (Newest First) | `codexHistoryViewer.setHistorySortCreatedDesc` | Sorts History by session start time, newest first. |
| Sort History by Started Date (Oldest First) | `codexHistoryViewer.setHistorySortCreatedAsc` | Sorts History by session start time, oldest first. |
| Sort History by Last Activity Date (Newest First) | `codexHistoryViewer.setHistorySortLastActivityDesc` | Sorts History by last activity time, newest first. |
| Sort History by Last Activity Date (Oldest First) | `codexHistoryViewer.setHistorySortLastActivityAsc` | Sorts History by last activity time, oldest first. |
| Sort History by Name (A to Z) | `codexHistoryViewer.setHistorySortTitleAsc` | Sorts History by display title in ascending order. |
| Sort History by Name (Z to A) | `codexHistoryViewer.setHistorySortTitleDesc` | Sorts History by display title in descending order. |
| Sort History by File Size (Largest First) | `codexHistoryViewer.setHistorySortFileSizeDesc` | Sorts History by source session file size, placing unavailable sizes last. In project display, projects use the total size of the sessions included in the current view. |
| Sort History by File Size (Smallest First) | `codexHistoryViewer.setHistorySortFileSizeAsc` | Sorts History by source session file size, placing unavailable sizes last. In project display, projects use the total size of the sessions included in the current view. |
| Sort Pinned by Pin Date (Newest First) | `codexHistoryViewer.setPinnedSortPinnedAtDesc` | Sorts Pinned by pin time, newest first. |
| Sort Pinned by Pin Date (Oldest First) | `codexHistoryViewer.setPinnedSortPinnedAtAsc` | Sorts Pinned by pin time, oldest first. |
| Sort Pinned by Started Date (Newest First) | `codexHistoryViewer.setPinnedSortCreatedDesc` | Sorts Pinned by session start time, newest first. |
| Sort Pinned by Started Date (Oldest First) | `codexHistoryViewer.setPinnedSortCreatedAsc` | Sorts Pinned by session start time, oldest first. |
| Sort Pinned by Last Activity Date (Newest First) | `codexHistoryViewer.setPinnedSortLastActivityDesc` | Sorts Pinned by last activity time, newest first. |
| Sort Pinned by Last Activity Date (Oldest First) | `codexHistoryViewer.setPinnedSortLastActivityAsc` | Sorts Pinned by last activity time, oldest first. |
| Sort Pinned by Name (A to Z) | `codexHistoryViewer.setPinnedSortTitleAsc` | Sorts Pinned by display title in ascending order. |
| Sort Pinned by Name (Z to A) | `codexHistoryViewer.setPinnedSortTitleDesc` | Sorts Pinned by display title in descending order. |
| Sort Pinned by File Size (Largest First) | `codexHistoryViewer.setPinnedSortFileSizeDesc` | Sorts Pinned by source session file size, placing missing or unavailable files last. In project display, projects use the total size of the pinned sessions included in the current view. |
| Sort Pinned by File Size (Smallest First) | `codexHistoryViewer.setPinnedSortFileSizeAsc` | Sorts Pinned by source session file size, placing missing or unavailable files last. In project display, projects use the total size of the pinned sessions included in the current view. |

## Search Commands

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Search... | `codexHistoryViewer.search` | Opens the search input flow and runs a full-text search. |
| Configure Default Search Roles... | `codexHistoryViewer.searchConfigureDefaultRoles` | Selects default roles included in Search. |
| Rerun Search | `codexHistoryViewer.searchRerun` | Re-runs the last query with its saved role and case options against the current History target. |
| Filter Search by Tags... | `codexHistoryViewer.searchFilterByTag` | Updates the History tag filter used as the Search scope. |
| Clear Search Tag Filter | `codexHistoryViewer.clearSearchTagFilter` | Clears the History tag filter used as the Search scope. |
| Run Saved Search... | `codexHistoryViewer.searchRunPreset` | Opens the saved-search picker; selecting an item runs it, and the trash button deletes that saved search. |
| Run from Search History... | `codexHistoryViewer.searchRunRecent` | Selects and reruns a query from the current project's search history. |
| Clear Project Search History... | `codexHistoryViewer.searchClearHistory` | Clears the current project's stored search history after confirmation. |
| Manage Search History... | `codexHistoryViewer.searchManageHistory` | Opens the current project's search history for rerunning or deleting individual queries. |
| Initialize Search Pane | `codexHistoryViewer.searchClearResults` | Clears current Search results and resets the Search root node. |
| Save Current Search... | `codexHistoryViewer.searchSavePreset` | Saves the current search query as a saved search. |

## Archive Actions

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Move to Codex History | `codexHistoryViewer.restoreArchivedSession` | Restores selected archived Codex sessions back to normal Codex History. |
| Move to Archive | `codexHistoryViewer.archiveSession` | Moves selected active Codex sessions to the Codex archive location. |

## File AI Change History

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Show File AI Change History | `codexHistoryViewer.openFileChangeHistory` | Opens AI-related change history for a selected workspace file. |

## History Insights and Agent Runs

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Show History Insights | `codexHistoryViewer.showHistoryInsights` | Opens an analytics snapshot for the sessions matching the current History conditions. It is available from the History view header and the Command Palette. |
| Open Parent Session | `codexHistoryViewer.openCodexAgentParent` | Opens the available parent of a selected Codex sub-agent session. When Agent Runs is enabled, this action appears only in the context menu for a sub-agent whose parent can be resolved; it is hidden from the Command Palette. |

## Session Actions

Tree context-menu targets follow these rules:

| Scope | Commands | Behavior |
| --- | --- | --- |
| Single session | Resume actions, CLI resume-command preparation, **Handoff to Other AI**, **Session Information**, **Custom Title...** | Always operates on the explicitly right-clicked session. |
| Multi-session | Open in a dedicated tab, open as Markdown, edit tags/note, export, pin/unpin, hide/unhide, promote, delete | Uses the same-view multi-selection only when it contains the right-clicked row; otherwise operates on that row alone. Codex and Claude Code sessions can be mixed. |
| Validated Codex multi-session | Move to Archive, Move to Codex History | Uses the same target rule as other multi-session actions, but rejects the whole selection unless every target is a Codex session in the required archive state. |

Menu availability is based on the right-clicked row. Selections from History, Pinned, and Search are never combined.
Opening multiple sessions requires confirmation and opens at most the first 10 unique sessions.

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Open Session in Dedicated Tab | `codexHistoryViewer.openSession` | Opens a selected session in a dedicated tab that is not replaced by later tree selections, or activates an existing matching session tab. |
| Open Session as Markdown | `codexHistoryViewer.openSessionMarkdown` | Opens selected sessions as virtual Markdown transcript documents named `<session display title>.md`. No file is created unless the user explicitly saves one. |
| Copy Quick Prompt | `codexHistoryViewer.copyResumePrompt` | Copies a compact resume prompt from the selected session view. |
| Copy Session ID | `codexHistoryViewer.copySessionId` | Copies the target session's validated resume ID. Available under **Session Information**. |
| Copy Session File Path | `codexHistoryViewer.copySessionFilePath` | Copies the target session file's full path. Available under **Session Information**. |
| Reveal Session File | `codexHistoryViewer.revealSessionFile` | Reveals the target session file in its containing folder. Available under **Session Information**. |
| Resume in Codex | `codexHistoryViewer.resumeSessionInCodex` | Sends the target Codex session to the Codex extension. |
| Resume in Claude Code | `codexHistoryViewer.resumeSessionInClaude` | Opens the target Claude Code session in Claude Code. |
| Prepare Codex CLI Resume Command | `codexHistoryViewer.resumeSessionInCodexCli` | Creates a new terminal at the target session CWD and enters `codex resume <SESSION_ID>` without pressing Enter. |
| Prepare Claude Code CLI Resume Command | `codexHistoryViewer.resumeSessionInClaudeCli` | Creates a new terminal at the target session CWD and enters `claude --resume <SESSION_ID>` without pressing Enter. |
| Promote to Today (Copy) | `codexHistoryViewer.promoteSession` | Copies selected non-archived sessions into today's folder without modifying the originals. |
| Pin | `codexHistoryViewer.pinSession` | Pins selected sessions for quick access. |
| Unpin | `codexHistoryViewer.unpinSession` | Removes selected sessions from Pinned. |
| Hide Sessions | `codexHistoryViewer.hideSessions` | Hides selected sessions from visible-only History, Pinned, and Search results without moving or deleting their source files. |
| Show Sessions | `codexHistoryViewer.unhideSessions` | Makes selected hidden sessions visible again. Use the Hidden Only or All display target to select them. |
| Delete | `codexHistoryViewer.deleteSessions` | Deletes the right-clicked session, or a same-view multi-selection that includes it (trash-first behavior by default). |
| Custom Title... | `codexHistoryViewer.manageCustomTitle` | Opens the shared custom-title picker for setting or clearing a session title. |
| Set Custom Title... | `codexHistoryViewer.setCustomTitle` | Sets an extension-local display title for the selected session. |
| Clear Custom Title | `codexHistoryViewer.clearCustomTitle` | Removes the extension-local custom title from the selected session. |
| Edit Session Tags/Note... | `codexHistoryViewer.editSessionAnnotation` | Edits tags and note annotations for the selected sessions. Multi-session direct editing applies the same tags and note to every target. |

## Handoff Actions

Handoff context-menu actions are shown only when `codexHistoryViewer.handoff.enabled` is enabled. `Delete Handoff Files` remains available from the Control view even when handoff context-menu actions are hidden.

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Handoff to Claude Code | `codexHistoryViewer.handoffToClaude` | Creates or reuses a Codex session handoff file, then opens Claude Code with a prompt that points to it. |
| Create Handoff File | `codexHistoryViewer.createHandoffFile` | Creates or reuses the target session's `handoff.md` without opening another agent. Its completion notification can open the file, copy the handoff prompt, or copy the file's absolute path. |
| Copy Handoff Prompt to Clipboard | `codexHistoryViewer.copyHandoffPrompt` | Copies a prompt that tells the target agent to read the target session's handoff file, creating it first if needed. |
| Copy Handoff File Path to Clipboard | `codexHistoryViewer.copyHandoffPath` | Copies the full path of an active target session's handoff file, creating or refreshing the file first if needed. |
| Open Handoff File | `codexHistoryViewer.openSessionHandoff` | Opens the target session's handoff file, with an option to create it if it does not exist. |

## Tag Operations

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Bulk Rename Tag... | `codexHistoryViewer.renameTagGlobally` | Renames one tag across all annotated sessions. |
| Bulk Delete Tags... | `codexHistoryViewer.deleteTagsGlobally` | Removes selected tags across all annotated sessions. |

## Project Associations

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Project Association... | `codexHistoryViewer.manageProjectAssociation` | Selects a project and manages its workspace or project association, display mode, and association target. |
| Clear Project Association... | `codexHistoryViewer.clearProjectAssociation` | Selects a project and removes its applicable project association after confirmation. |

## Import and Export

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Export Sessions... | `codexHistoryViewer.exportSessions` | Exports selected original session data with extension metadata, or exports sanitized Markdown. |
| Import Sessions... | `codexHistoryViewer.importSessions` | Restores Codex or Claude Code session data from a selected directory and restores accompanying metadata when a valid export manifest is available, with selectable restore scope and duplicate-ID handling. |
