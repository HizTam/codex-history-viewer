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
| Open Settings | `codexHistoryViewer.openSettings` | Opens extension settings in the VS Code Settings UI. |
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
| Filter History... | `codexHistoryViewer.filterHistory` | Opens the History filter picker (date range/projects/source/archive location/tags). |
| Filter History by Tags... | `codexHistoryViewer.filterHistoryByTag` | Applies a tag-based filter to the History view. |
| Filter by Current Project | `codexHistoryViewer.filterHistoryCurrentProject` | Toggles History between all projects and the current project group. |
| Show Sessions List | `codexHistoryViewer.showHistoryLatestView` | Switches History to the latest-first list view. |
| Show by Date | `codexHistoryViewer.showHistoryDateView` | Switches History to the date-grouped view. |
| Show Codex History Only | `codexHistoryViewer.filterHistorySourceCodex` | Limits History to Codex sessions only. |
| Show Claude Code History Only | `codexHistoryViewer.filterHistorySourceClaude` | Limits History to Claude Code sessions only. |
| Toggle Codex Source Filter | `codexHistoryViewer.toggleHistorySourceCodex` | Toggles Codex in the active source filter. |
| Toggle Claude Code Source Filter | `codexHistoryViewer.toggleHistorySourceClaude` | Toggles Claude Code in the active source filter. |
| Cycle Source Filter (Codex + Claude Code -> Codex -> Claude Code) | `codexHistoryViewer.cycleHistorySourceFilter` | Cycles History through all enabled sources, Codex only, and Claude Code only. |
| Show All Sources | `codexHistoryViewer.clearHistorySourceFilter` | Clears source-only filtering and shows enabled sources. |
| Clear History Filters | `codexHistoryViewer.clearHistoryFilter` | Resets History date, explicit project, source, archive-location, and tag filters. The Current Project Group scope remains active when selected. |
| Clear History Tag Filter | `codexHistoryViewer.clearHistoryTagFilter` | Removes the active History tag filter. |
| Filter Pinned... | `codexHistoryViewer.filterPinned` | Opens the independent Pinned filter picker (date/project/source/archive location/tags). |
| Filter Pinned by Current Project | `codexHistoryViewer.filterPinnedCurrentProject` | Toggles Pinned between all projects and the current project group. |
| Filter Pinned by Tags... | `codexHistoryViewer.filterPinnedByTag` | Applies a tag filter to the Pinned view. |
| Clear Pinned Filters | `codexHistoryViewer.clearPinnedFilter` | Resets Pinned date, explicit project, source, archive-location, and tag filters. The Current Project Group scope remains active when selected. |
| Clear Pinned Tag Filter | `codexHistoryViewer.clearPinnedTagFilter` | Removes the active Pinned tag filter. |

## Search Commands

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Search... | `codexHistoryViewer.search` | Opens the search input flow and runs a full-text search. |
| Configure Default Search Roles... | `codexHistoryViewer.searchConfigureDefaultRoles` | Selects default roles included in Search. |
| Rerun Search | `codexHistoryViewer.searchRerun` | Re-runs the last query with its saved role and case options against the current History target. |
| Filter Search by Tags... | `codexHistoryViewer.searchFilterByTag` | Updates the History tag filter used as the Search scope. |
| Clear Search Tag Filter | `codexHistoryViewer.clearSearchTagFilter` | Clears the History tag filter used as the Search scope. |
| Run Saved Search... | `codexHistoryViewer.searchRunPreset` | Executes a saved search. |
| Initialize Search Pane | `codexHistoryViewer.searchClearResults` | Clears current Search results and resets the Search root node. |
| Save Current Search... | `codexHistoryViewer.searchSavePreset` | Saves the current search query as a saved search. |
| Run or Delete Saved Search... | `codexHistoryViewer.searchDeletePreset` | Opens the saved-search picker; selecting an item runs it, and the trash button deletes that saved search. |

## Archive Actions

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Move to Codex History | `codexHistoryViewer.restoreArchivedSession` | Restores selected archived Codex sessions back to normal Codex History. |
| Move to Archive | `codexHistoryViewer.archiveSession` | Moves selected active Codex sessions to the Codex archive location. |
| Toggle Archive Visibility | `codexHistoryViewer.filterArchiveLocation` | Cycles History, and the Search scope that follows it, between active-only, all, and archived-only Codex sessions. |
| Toggle Pinned Archive Visibility | `codexHistoryViewer.filterPinnedArchiveLocation` | Independently cycles Pinned between active-only, all, and archived-only Codex sessions. It is unavailable while Pinned shows Claude Code only. |

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

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Open Session in New Tab | `codexHistoryViewer.openSession` | Opens a selected session in its own session tab, or activates an existing matching session tab. |
| Open Session as Markdown | `codexHistoryViewer.openSessionMarkdown` | Opens a selected session as a Markdown transcript document. |
| Copy Quick Prompt | `codexHistoryViewer.copyResumePrompt` | Copies a compact resume prompt from the selected session view. |
| Resume in OpenAI Codex | `codexHistoryViewer.resumeSessionInCodex` | Sends the selected Codex session to the OpenAI Codex extension. |
| Resume in Claude Code | `codexHistoryViewer.resumeSessionInClaude` | Opens the selected Claude session in Claude Code. |
| Promote to Today (Copy) | `codexHistoryViewer.promoteSession` | Copies a past session into today's folder without modifying the original. |
| Pin | `codexHistoryViewer.pinSession` | Pins selected sessions for quick access. |
| Unpin | `codexHistoryViewer.unpinSession` | Removes selected sessions from Pinned. |
| Delete | `codexHistoryViewer.deleteSessions` | Deletes selected session files (trash-first behavior by default). |
| Custom Title... | `codexHistoryViewer.manageCustomTitle` | Opens the shared custom-title picker for setting or clearing a session title. |
| Set Custom Title... | `codexHistoryViewer.setCustomTitle` | Sets an extension-local display title for the selected session. |
| Clear Custom Title | `codexHistoryViewer.clearCustomTitle` | Removes the extension-local custom title from the selected session. |
| Edit Session Tags/Note... | `codexHistoryViewer.editSessionAnnotation` | Edits tags and note annotation for a selected session. |

## Handoff Actions

Handoff context-menu actions are shown only when `codexHistoryViewer.handoff.enabled` is enabled. `Delete Handoff Files` remains available from the Control view even when handoff context-menu actions are hidden.

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Handoff to OpenAI Codex | `codexHistoryViewer.handoffToCodex` | Creates or reuses a session handoff file, then opens OpenAI Codex with a prompt that points to it. |
| Handoff to Claude Code | `codexHistoryViewer.handoffToClaude` | Creates or reuses a Codex session handoff file, then opens Claude Code with a prompt that points to it. |
| Create Handoff File | `codexHistoryViewer.createHandoffFile` | Creates or reuses the selected session's `handoff.md` without opening another agent. |
| Copy Handoff Prompt to Clipboard | `codexHistoryViewer.copyHandoffPrompt` | Copies a prompt that tells the target agent to read the selected session's handoff file, creating it first if needed. |
| Open Handoff File | `codexHistoryViewer.openSessionHandoff` | Opens the selected session's handoff file, with an option to create it if it does not exist. |

## Tag Operations

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Bulk Rename Tag... | `codexHistoryViewer.renameTagGlobally` | Renames one tag across all annotated sessions. |
| Bulk Delete Tags... | `codexHistoryViewer.deleteTagsGlobally` | Removes selected tags across all annotated sessions. |

## Import and Export

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Export Sessions... | `codexHistoryViewer.exportSessions` | Exports selected sessions as raw JSONL or sanitized Markdown. |
| Import Sessions... | `codexHistoryViewer.importSessions` | Imports session files from a folder with duplicate ID handling options. |
