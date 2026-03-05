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
| Rebuild Cache | `codexHistoryViewer.rebuildCache` | Rebuilds the local session cache/index from source files. |
| Cleanup Missing Pins | `codexHistoryViewer.cleanupMissingPins` | Removes pinned entries whose source files no longer exist. |
| Debug Info (Copy) | `codexHistoryViewer.debugInfo` | Copies runtime diagnostics and state summary to the clipboard. |
| Undo Last Action | `codexHistoryViewer.undoLastAction` | Reverts the latest undoable operation. |

## History and Source Filters

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Filter History... | `codexHistoryViewer.filterHistory` | Opens the History filter picker (date/project/source/tags). |
| Filter History by Tags... | `codexHistoryViewer.filterHistoryByTag` | Applies a tag-based filter to the History view. |
| Filter by Current Project | `codexHistoryViewer.filterHistoryCurrentProject` | Filters History to the active workspace project path. |
| Show Codex History Only | `codexHistoryViewer.filterHistorySourceCodex` | Limits History to Codex sessions only. |
| Show Claude History Only | `codexHistoryViewer.filterHistorySourceClaude` | Limits History to Claude sessions only. |
| Show All Sources | `codexHistoryViewer.clearHistorySourceFilter` | Clears source-only filtering and shows enabled sources. |
| Clear History Filters | `codexHistoryViewer.clearHistoryFilter` | Clears date/project/source filtering in History. |
| Clear History Tag Filter | `codexHistoryViewer.clearHistoryTagFilter` | Removes the active History tag filter. |
| Filter Pinned by Tags... | `codexHistoryViewer.filterPinnedByTag` | Applies a tag filter to the Pinned view. |
| Clear Pinned Tag Filter | `codexHistoryViewer.clearPinnedTagFilter` | Removes the active Pinned tag filter. |

## Search Commands

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Search... | `codexHistoryViewer.search` | Opens the search input flow and runs a full-text search. |
| Configure Default Search Roles... | `codexHistoryViewer.searchConfigureDefaultRoles` | Selects default roles included in Search. |
| Rerun Search | `codexHistoryViewer.searchRerun` | Re-runs Search with the last saved query and filters. |
| Filter Search by Tags... | `codexHistoryViewer.searchFilterByTag` | Applies a tag filter to Search results. |
| Clear Search Tag Filter | `codexHistoryViewer.clearSearchTagFilter` | Removes the active Search tag filter. |
| Run Saved Search... | `codexHistoryViewer.searchRunPreset` | Executes a saved search preset. |
| Initialize Search Pane | `codexHistoryViewer.searchClearResults` | Clears current Search results and resets the Search root node. |
| Save Current Search Preset... | `codexHistoryViewer.searchSavePreset` | Saves the current search conditions as a preset. |
| Delete Saved Search... | `codexHistoryViewer.searchDeletePreset` | Deletes a saved search preset. |

## Session Actions

| Command (EN label) | Command ID | Description |
| --- | --- | --- |
| Open Session (Chat) | `codexHistoryViewer.openSession` | Opens a selected session in the chat-style webview. |
| Open Session (Markdown) | `codexHistoryViewer.openSessionMarkdown` | Opens a selected session as a Markdown transcript document. |
| Copy Prompt Excerpt | `codexHistoryViewer.copyResumePrompt` | Copies a compact handoff excerpt from the selected session. |
| Resume in OpenAI Codex | `codexHistoryViewer.resumeSessionInCodex` | Sends the selected Codex session to the OpenAI Codex extension. |
| Resume in Claude Code | `codexHistoryViewer.resumeSessionInClaude` | Opens the selected Claude session in Claude Code. |
| Promote to Today (Copy) | `codexHistoryViewer.promoteSession` | Copies a past session into today's folder without modifying the original. |
| Pin | `codexHistoryViewer.pinSession` | Pins selected sessions for quick access. |
| Unpin | `codexHistoryViewer.unpinSession` | Removes selected sessions from Pinned. |
| Delete | `codexHistoryViewer.deleteSessions` | Deletes selected session files (trash-first behavior by default). |
| Edit Session Tags/Note... | `codexHistoryViewer.editSessionAnnotation` | Edits tags and note annotation for a selected session. |

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
