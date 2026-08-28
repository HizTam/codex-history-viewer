# Codex History Viewer

Browse, search, organize, and resume past Codex CLI / Claude Code sessions through the official VS Code extensions or prepared CLI commands.

Latest release: **2.12.0** (2026-08-28).

![Codex History Viewer screenshot](media/screenshot.png)

## Why Use This Extension?

Codex and Claude Code sessions can become hard to revisit once they are no longer active in the editor. Codex History Viewer keeps those local session files useful by presenting them in a searchable session history browser inside VS Code.

Use it to find past prompts, reuse useful answers, inspect file changes, organize sessions with tags and notes, resume same-source sessions, and prepare handoff context for other AI tools.

## Highlights

- **Revisit past Codex CLI and Claude Code sessions** that are no longer easy to access from the active editor flow.
- Browse sessions in a year / month / day tree, a sortable session list, or project views with related project groups.
- Open History Insights for the current History target to review overview metrics, activity patterns, source/model/project/tool breakdowns, the most active sessions, frequently changed files, detailed usage/message/turn/file-type composition, and data quality.
- Optionally include Codex `archived_sessions`, hide sessions without changing provider files, and switch among active, archived, and hidden display targets.
- Show valid cached History and Pinned data immediately at startup while local session files refresh in the background.
- Search across prompts, responses, tool output, tags, notes, and attachment metadata, with shared search history.
- View sessions in the Session Viewer with Markdown, including individually copyable tables, GFM task lists, Mermaid diagrams, code highlighting, math rendering, tool cards, and file-change diffs.
- Manage the extension's primary settings from a categorized settings page, with supported User, Workspace, and Workspace Folder targets, scope-specific JSON backups, and maintenance actions.
- Enable an opt-in Codex turn timeline to see turn boundaries, turn summaries, completed-turn folding, and running state in live mode.
- Use Agent Runs to distinguish Codex sub-agent sessions and inspect parent, sibling, and descendant relationships in a right-side tree. (Experimental; disabled by default.)
- Use Branch Navigation to inspect and switch between locally forked Codex histories and Claude Code **Fork conversation** histories in their respective session views. (Experimental; disabled by default.)
- Show Codex / Claude Code request interruptions as dedicated timeline cards.
- Open File AI Change History for a workspace file to review Codex / Claude Code diffs that touched that file.
- Bookmark important history cards and use date-guide markers to revisit them quickly.
- Keep open session tabs up to date with header-controlled auto-refresh modes.
- Show supported image attachments, Claude Code documents, and file references from Codex / Claude Code sessions as compact cards.
- Organize sessions with pins, tags, notes, custom titles, project aliases, project associations, saved searches, search history, display modes, and filters.
- Keep Pinned filters independent from History/Search, including project scope, source, visibility, tags, and saved sort preferences.
- Experimental opt-in restoration for session tabs, File AI Change History, History Insights, and the dedicated settings page after Reload Window or VS Code restart.
- Resume past sessions through the official Codex and Claude Code VS Code extensions or prepare commands for resuming them with the CLI.
- Copy session IDs and session file paths from the Session Viewer or tree context menus, and reveal session files in their containing folders.
- Export and restore original session data together with extension-managed metadata such as tags, notes, custom titles, hidden state, pins, and timeline bookmarks.
- Create handoff files and prompts when moving work to another AI tool, and copy the handoff file path directly.

## Quick Start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions such as opening settings, importing sessions, configuring default search roles, rebuilding the cache, and emptying the trash. **Open Settings** opens the categorized settings page; use its **Maintenance** page for settings backups and access to the standard VS Code settings.
3. Browse sessions under **History** and switch between date-grouped/session-list layouts, List/Project display, All/Current Project Group scope, visibility targets, and saved sort preferences.
4. Use **Show History Insights** from the History header when you want an aggregate view of the current History target.
5. Select a session to open the reusable session tab. Use **Open Session in Dedicated Tab** to keep a session assigned to its own tab, or **Open Session as Markdown** for a virtual transcript document named after the session, such as `Review release candidate.md`. The virtual document does not create a file unless you explicitly save it.
6. Use **Pinned** for saved sessions with its own date, project, source, visibility, tag, and saved sort controls.
7. Run **Search...** and refine with roles, query syntax, search history, saved searches, and the current History filters.
8. Use context menus to hide or show one or multiple sessions, or use context menus and the Session Viewer's header actions to edit tags/notes.
9. Enable **File Change History > Explorer Context Menu: Enabled** when you want file-level AI diff history from file right-click menus.
10. Keep Codex enabled in **Sources: Enabled**, then turn on Codex archived sessions if you want archived Codex history included.
11. Enable `codexHistoryViewer.agentRuns.enabled` when you want to inspect parent and sub-agent relationships with Agent Runs.
12. Enable `codexHistoryViewer.branchNavigation.enabled` when you want to navigate locally forked Codex histories and Claude Code **Fork conversation** histories.
13. Choose Extension, CLI, or Extension and CLI as the resume method for each source. CLI actions enter a command in a new VS Code integrated terminal without running it; press Enter to execute it. Use **Handoff to Other AI** when moving work between agents, including when you need to copy the handoff file path.
14. Use the session information actions in the Session Viewer or **Session Information** in the History, Pinned, and Search context menus to copy a session ID or session file path, or reveal the session file in its containing folder.

## History and Pinned Organization

History and Pinned separate project organization into display and scope controls. Display can switch between **List** and **Project** views, while scope can switch between **All** and **Current Project Group**. Project matching is case-insensitive across platforms. Project views preserve the existing layout choice: session-list history becomes `Project -> Session`, while date-grouped history becomes `Project -> Year -> Month -> Day -> Session`.

Project folders can have extension-local aliases from the History or Pinned project context menu. Aliases are stored in VS Code extension state without changing Codex or Claude Code history files. When set, aliases appear in project headings, session descriptions, tooltips, filter summaries, Status, and Search scope/session display while the original path remains available in detailed metadata.

Project associations can link another project's history into the current project display or group related projects together without moving the original history files. Associations are available from project context menus and are reflected in History, Pinned, Search, File AI Change History, and handoff content.

History, Pinned, and History Insights can target **Active Only**, **Active + Archived**, **Archived Only**, **Hidden Only**, or **All** sessions when the corresponding sources are available. Hidden sessions can come from either active or archived storage. Hidden and archived states are identified in tree descriptions and tooltips.

Pinned has its own project scope, source, visibility target, date, tag filters, and saved sort preference. It does not follow History/Search filter state, so saved sessions can stay focused on a different project or source while you browse and search elsewhere. History can sort by started date, last activity date, name, or source session file size. Pinned can sort by pinned time, started date, last activity date, name, or source session file size. When Tooltip Mode is set to Compact or Detailed, History and Pinned session tooltips also show the source session file size.

Use **Show timestamp** and **Show project/path** under **History List > Session rows** to simplify session rows in History, Pinned, and Search. The two elements can be hidden independently, while their full timestamp and project information remain available in session tooltips.

## Session Viewer

The Session Viewer renders local session files as readable timelines. It supports Markdown, Mermaid diagrams, syntax-highlighted fenced code blocks, KaTeX-compatible math, assistant usage metadata, environment snapshots, tool execution metadata, and grouped file-change cards from patch activity. GFM task-list markers render as read-only checkboxes without modifying the stored session content.

Markdown tables use clearer cell spacing and separators, wrap long content, and scroll horizontally within the table when needed. Each table has an action for copying only that table in its original Markdown form.

Fenced `mermaid` blocks render as inline diagrams. Each diagram can switch between Light and Dark display modes, open in a non-modal right-side pane for fit-to-view, zoom, scroll, drag-to-pan, and keyboard navigation, and be saved as SVG, PNG, or Mermaid source (`.mmd`).

The resume button follows the resume method selected separately for Codex and Claude Code. Extension and CLI uses a split button: the last used method becomes the main action, while the dropdown always lists both methods. CLI actions enter the resume command in a new VS Code integrated terminal without pressing Enter. The History, Pinned, and Search context menus follow the same source-specific settings.

The Session Viewer shows the validated session ID and session file name with actions to copy the ID, copy the full file path, or reveal the file in its containing folder. The same actions are available under **Session Information** in the History, Pinned, and Search context menus.

Tree context menus distinguish single-session actions from bulk actions. Resume, CLI preparation, handoff, session information, and custom-title actions always use the explicitly right-clicked session. Open, Markdown, annotation, export, pin/unpin, hide/show, promote, and delete actions use the same-view multi-selection only when it includes the right-clicked row; otherwise they use that row alone. Codex and Claude Code sessions can be mixed for these bulk actions. Archive and restore remain Codex-only and reject the whole selection when its source or archive state is incompatible. Menu availability is determined by the right-clicked row, and selections from different views are never combined.

Large histories can use the `auto`, `normal`, or `simplified` performance mode. Heavy tool details and large diff rows can be deferred until **Show details** is enabled or an individual entry is expanded.

Codex sessions can use an opt-in turn timeline. `basic` mode shows turn start/end markers, range rails, summaries, token counts, duration, and manual folding for completed turns. `live` mode adds running-turn indicators, elapsed time, and update activity effects.

Patch group cards can show compact file summaries and an in-place **Open all diffs** / **Close all diffs** action.

Request interruptions from Codex and Claude Code render as dedicated timeline cards. When available, details include reason, duration, turn ID, rollback state, and rolled-back turn count.

Claude Code peer and coordinator messages received from other sessions render as dedicated cross-session cards. They remain searchable as assistant-derived content and are excluded from previews, Resume, Handoff, and human-message analysis.

Session tabs preserve useful state across reload and auto-refresh, including scroll position, selected message, expanded cards/diffs, detail visibility, diff wrapping, and in-page search state. The experimental opt-in **Restore Webview Tabs After Reload** setting can also restore session tabs, File AI Change History, History Insights, and the dedicated settings page after **Developer: Reload Window** or VS Code restart. It is disabled by default because VS Code can defer Webview restoration and may occasionally create duplicate tabs when the same history is opened again.

The session timeline can keep the current user prompt visible at the top while you scroll. Codex memory citation information is rendered as a collapsible section instead of being left as raw metadata in the message body. Session runtime context and local-command output are likewise shown as collapsed cards instead of raw user messages.

Codex array-form tool outputs and standalone `local_shell_call`, `web_search_call`, and `image_generation_call` response items render as tool cards. Their arguments and outputs are projected through bounded, type-specific fields instead of exposing arbitrary protocol data.

## Attachments and References

The Session Viewer keeps attachments and file references out of the message body and renders them as cards instead.

- Supported images from Codex / Claude Code sessions, including Codex tool-output and image-generation images, are loaded on demand and can be previewed or saved. Separately recorded intermediate and final images remain visible in history order.
- Claude Code PDF, text, and generic documents render as document cards. Text document previews open inside the card, and embedded payloads are saved on demand.
- Claude Code pasted text and automatically truncated long input render as text document cards when the local prompt-history record can be matched unambiguously. Pasted-image placeholders use the corresponding session image metadata. If the auxiliary record cannot be verified, the primary session text remains visible.
- Claude Code IDE opened-file and selection markers render as file/selection reference cards instead of raw inline tags.
- Codex mentioned- and pasted-file blocks render as file reference cards while only an explicit request remains as message text. Attachment-only pasted requests remain card-only, including blocks that appear after IDE context.
- File reference cards can open local files through VS Code. Referenced files are not read automatically for rendering, search, resume, or handoff.
- On Windows, Claude Code scratchpad links under the current user's local Claude temporary directory can still open when the generated relative link crosses drives.
- Card metadata such as path, MIME type, and size is available from tooltips instead of taking over the session timeline.
- Markdown transcripts, resume text, and handoff files use clean text plus attachment summaries instead of repeating raw tags or file blocks.

## Search

Search is local, cancellable, and backed by an incremental search index. It can search message text, configured tool metadata, titles, tags, notes, and attachment metadata.

Supported query forms include normal substring search, `exact:...`, `re:...`, `/regex/`, and boolean `AND` / `OR` / `NOT`.

Search follows the current History target, including date, project scope, project filter, source, visibility, and tags. **Hidden Only** searches hidden sessions, while **All** searches both visible and hidden sessions. Search does not follow Pinned filters, and it does not create Search results from filters alone.

The global search input combines manual search and search history. Search history is shared with in-page search in the Session Viewer and File AI Change History, stores only query text, and can be selected to run or removed individually with the trash button. Saved searches also store and reuse only query text; role filters and case sensitivity are taken from the current settings when the saved search is run, and saved searches can be removed individually from the run picker.

Opening a Search result can pass the same query into the Session Viewer's in-page search. In-page search in the Session Viewer and File AI Change History supports the same query forms, including exact matching and regular expressions, and can show search-history suggestions below the search input.

Project aliases are shown in Search scope and result display, but they are not added to the search index or treated as searchable hit text.

The search index can be tuned with `codexHistoryViewer.search.indexToolContent`:

- `conversationOnly`
- `toolCalls`
- `toolCallsAndOutputs`

Attachment indexing includes labels, paths, MIME types, file kinds, and bounded text from Claude Code text documents. PDF / Office / binary / base64 document contents, raw image Base64 or data URI payloads, and Codex referenced-file contents are not indexed.

## Codex Archived Sessions

Codex History Viewer can optionally read Codex `archived_sessions` in addition to normal Codex `sessions`. The visibility target can show active sessions, visible sessions from active and archived storage, archived sessions, hidden sessions, or all sessions. Search follows the History visibility target, while Pinned keeps its own independent visibility state. Active Codex sessions expose **Move to Archive**, while archived Codex sessions expose **Move to Codex History**.

Archive and restore operations prefer the official Codex provider. Moving archived sessions back to normal Codex history can fall back to a filesystem move when the official provider is unavailable. Pins, annotations, bookmarks, and saved session positions are relocated when the session path changes.

Use **Hide Sessions** and **Show Sessions** from History, Pinned, or Search to change extension-local visibility without modifying the original session file. Hiding works for sessions in both active and archived storage. Hidden sessions remain available in File AI Change History.

## Session Data Export and Restore

**Export Sessions** can save either a sanitized Markdown transcript or the original session data. **Export original session data** includes the provider session files and extension-managed metadata for tags, notes, custom titles, hidden state, pins, and bookmarks for messages and other timeline entries.

**Import Sessions** can restore the session data and its metadata together, or restore only the selected part when that option is available. For Codex sessions, the active or archived storage location is also restored. A confirmation summarizes the planned session-data and metadata changes before anything is written.

## Handoff to Other AI

Handoff actions appear under **Handoff to Other AI** for eligible active Codex / Claude Code sessions when `codexHistoryViewer.handoff.enabled` is enabled. They can create a reusable handoff file, copy a prompt that points another AI to that file, copy the handoff file path to the clipboard, or open the handoff file for manual use. Codex sessions can also be handed off directly to Claude Code when the Claude Code extension is available.

Handoff files are stored in this extension's VS Code global storage and include a tail-prioritized transcript excerpt, the latest user request, the source session path, recoverable file changes, and attachment summaries. Tool calls, tool outputs, and binary attachment payloads are intentionally omitted.

When project associations are configured, handoff generation follows the associated project display and includes path mapping context for the receiving AI.

## File AI Change History

File AI Change History starts from a workspace file and shows the Codex / Claude Code changes that touched that file over time.

![File AI Change History screenshot](media/screenshot_2.png)

Use it when you want to answer questions such as:

- Which AI session changed this file?
- How did this file evolve across Codex and Claude Code sessions?
- What was the surrounding session context for a specific diff?

The Explorer file context menu entry is opt-in. Enable **File Change History > Explorer Context Menu: Enabled**, then right-click a file in VS Code Explorer and run **Show File AI Change History**.

The view is scoped to the current workspace and selected file. It supports Codex / Claude Code source toggles, in-page search with shared query history and richer query syntax, incremental **Load more**, previous/next navigation, and **Open in History** links back to the matching diff card in the original session. Diff code is syntax-highlighted when the language can be determined from the file path; otherwise, it is displayed as plain text.

File AI Change History follows project associations when resolving related history, so associated project displays and path mappings are reflected when possible. Hidden sessions remain part of its candidate history.

## History Insights

History Insights turns the current History target into a fixed analytics snapshot. Open it from **Show History Insights** in the History view header or from the Command Palette.

![History Insights screenshot](media/screenshot_4.png)

The view includes overview metrics, an activity heatmap, breakdowns by source, model, project, and tool, the most active sessions, frequently changed files, usage details, and data quality information. The overview includes reasoning tokens and change events, and the heatmap can visualize reasoning tokens. Tool breakdowns can switch between call count and session count. Most-active-session rankings can switch between user requests, tool calls, reasoning tokens, total tokens, and changed lines, and each available row can open its session. Usage details summarize cached, cache-read, and cache-creation input tokens and reasoning tokens; user requests, assistant responses, developer messages, tool calls, and tool outputs; all, completed, interrupted, and rolled-back turns; and changed file types by distinct-file and change-event count. Partial logs are shown as confirmed lower bounds or unavailable values instead of being treated as exact zeros.

**Reaggregate** updates changed sessions while keeping the same target set. **Apply History filters** replaces the snapshot with the current History target. The filter panel can refine source, date range, visibility target, related project groups, and tags. These changes stay inside History Insights by default; they update the History view only when **Also apply to History** is selected before applying them.

Selecting a date cell opens its sessions in History. The History and Search actions on each project row apply that project while preserving the other snapshot conditions. The Search action reruns the current search when one is available, then opens the Search view. Frequently changed file entries can open the existing File AI Change History view or the corresponding workspace file.

## Agent Runs (Experimental)

Agent Runs currently supports Codex sessions only. When it is enabled and its relationship data is ready, sub-agent sessions with an available parent are omitted from History. They remain reachable from the parent session's Agent Runs panel, Search, and explicit Pinned entries. Sub-agent sessions whose parent cannot be resolved safely remain visible in History.

![Agent Runs screenshot](media/screenshot_5.png)

The Agent Runs action in a Codex session view opens a right-side relationship tree containing the parent, siblings, and descendants of the current session. The current route is blue, other agent routes are orange, and the open icon on each available node opens that related session directly.

Enable `codexHistoryViewer.agentRuns.enabled` to use this feature. Relationships are based only on explicit agent metadata; the feature does not merge session content, usage totals, annotations, or stored session files. (Experimental; disabled by default.)

## Branch Navigation (Experimental)

Branch Navigation recognizes locally forked Codex session histories, including histories created with **Fork locally** in the Codex app or **Continue in new task** in the Codex extension, and Claude Code histories created with **Fork conversation**. It lets you move between Fork destinations without leaving their respective session views.

![Branch Navigation screenshot](media/screenshot_3.png)

Inline controls at a Fork point switch to the previous or next route. The shared route-tree action shows the shared history, Fork points, and the start and end of each route. Selecting a route node switches the same session view to the corresponding stored session and message position.

Enable `codexHistoryViewer.branchNavigation.enabled` to use this feature. For Codex, Branch Navigation applies to local Forks whose parent and child remain in the same working directory. For Claude Code, Branch Navigation only navigates stored session history and does not invoke **Rewind code** or rewind workspace files. The extension never creates, modifies, merges, or deletes Forks or modifies stored session files. (Experimental; disabled by default.)

## Configuration

Run **Open Settings** from **Control** or the Command Palette to open the categorized settings page. Settings can be edited at the User, Workspace, or Workspace Folder level when supported by their scope. The **Maintenance** page can reset managed user settings, export or import scope-specific JSON settings backups, rebuild the history cache or search index, run cleanup actions, and open the standard VS Code settings for advanced editing.

Common settings include:

- `codexHistoryViewer.sources.enabled`: enable `codex` (Codex), `claude` (Claude Code), or both. VS Code Settings and `settings.json` use the stored identifiers `codex` and `claude`.
- `codexHistoryViewer.sessionsRoot`: Codex sessions root.
- `codexHistoryViewer.claude.sessionsRoot`: Claude Code sessions root.
- `codexHistoryViewer.agentRuns.enabled`: enable the experimental Agent Runs feature. It currently supports Codex sessions only. Disabled by default.
- `codexHistoryViewer.branchNavigation.enabled`: enable the experimental Branch Navigation feature for locally forked Codex histories and Claude Code Fork conversation histories. Disabled by default.
- `codexHistoryViewer.codex.archivedSessions.enabled`: include Codex archived sessions.
- `codexHistoryViewer.handoff.enabled`: show cross-agent handoff actions.
- `codexHistoryViewer.resume.codexMethod`: choose Extension, CLI, or Extension and CLI for resuming Codex sessions.
- `codexHistoryViewer.resume.claudeMethod`: choose Extension, CLI, or Extension and CLI for resuming Claude Code sessions.
- `codexHistoryViewer.preview.tooltipMode`: choose Detailed, Compact, or Title Only for session tree item tooltips.
- `codexHistoryViewer.preview.maxMessages`: set the maximum number of user/assistant messages collected for Detailed tooltips. This is not a guaranteed visible count; VS Code limits tooltip height to approximately 50% of the window, so some collected messages may be outside the visible area.
- `codexHistoryViewer.sessionRow.showTimestamp`: show or hide timestamps in History, Pinned, and Search session rows while keeping them available in tooltips.
- `codexHistoryViewer.sessionRow.showProject`: show or hide project aliases or paths in History, Pinned, and Search session rows while keeping them available in tooltips.
- `codexHistoryViewer.search.indexToolContent`: control search index tool-content scope.
- `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled`: show File AI Change History in Explorer.
- `codexHistoryViewer.autoRefresh.enabled`: watch local session files and refresh the History tree and opted-in session tabs when the VS Code window is focused and the History tree is visible or an opted-in session tab is open.
- `codexHistoryViewer.chat.openPosition`: open the session view at the top, the last viewed message, or the latest rendered card.
- `codexHistoryViewer.chat.stickyUserPrompt`: keep the current user prompt visible while scrolling the session timeline.
- `codexHistoryViewer.chat.performanceMode`: choose the default session rendering performance mode.
- `codexHistoryViewer.chat.turnTimeline.mode`: enable the opt-in Codex turn timeline with `off`, `basic`, or `live`.
- `codexHistoryViewer.webview.restoreAfterReload`: experimental opt-in to restoring session tabs, File AI Change History, History Insights, and the dedicated settings page after Reload Window or VS Code restart.
- `codexHistoryViewer.images.enabled`: show supported image attachments.
- `codexHistoryViewer.ui.timeGuide.enabled`: enable compact date guides and bookmark controls.
- `codexHistoryViewer.ui.language`: choose `auto`, `en`, or `ja`.

### Suggested Settings

The defaults are designed for regular use. These settings are useful starting points when you want a lighter UI, richer search, or more active refresh behavior:

| Situation                                            | Suggested settings                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large sessions or many diffs                         | Keep `codexHistoryViewer.chat.performanceMode` set to `auto`, or use `simplified` if session views feel heavy.                                            |
| Codex turn boundaries without live effects           | Set `codexHistoryViewer.chat.turnTimeline.mode` to `basic`.                                                                                               |
| Live Codex turn tracking                             | Set `codexHistoryViewer.chat.turnTimeline.mode` to `live`.                                                                                                |
| Agent Runs                                          | Enable `codexHistoryViewer.agentRuns.enabled` to navigate stored parent and sub-agent sessions in the session view.                                       |
| Branch Navigation                                   | Enable `codexHistoryViewer.branchNavigation.enabled` to navigate locally forked Codex histories and Claude Code Fork conversation histories. |
| Faster, narrower search                              | Use `codexHistoryViewer.search.indexToolContent: toolCalls` instead of `toolCallsAndOutputs`, and lower `codexHistoryViewer.search.maxResults` if needed. |
| More compact session rows                            | Turn off `codexHistoryViewer.sessionRow.showTimestamp`, `codexHistoryViewer.sessionRow.showProject`, or both. Hidden details remain available in tooltips. |
| Long sessions, bookmarks, or frequent timeline jumps | Enable `codexHistoryViewer.ui.timeGuide.enabled`.                                                                                                         |
| Frequent image-heavy sessions                        | Lower `codexHistoryViewer.images.thumbnailSize` or `codexHistoryViewer.images.maxSizeMB`.                                                                 |
| Live-updating session files                          | Enable `codexHistoryViewer.autoRefresh.enabled` when you want the History tree and opted-in session tabs to refresh while the VS Code window is focused.  |
| Restoring extension tabs after reload                | Enable `codexHistoryViewer.webview.restoreAfterReload` only if you accept the experimental duplicate-tab caveat.                                          |

If history, search, or analysis results look stale, run **Open Settings > Maintenance > Rebuild Cache** or **Control > Rebuild Cache**. After confirmation, it recreates the history cache, search index, and analysis data. A successful **Rebuild Cache** refreshes open History Insights and Branch Navigation only when its starting configuration is still current.

## Commands

Most actions are available from view title buttons and tree context menus.

For the primary user-facing commands with descriptions, see:

- [Command Reference](docs/commands.md)

## Codex Integration Notes

- The first **Resume in Codex** may show a VS Code security prompt for the target extension URI. Click **Open** to continue.
- If the official Codex extension stops reopening a session, try `Developer: Reload Webviews`, then `Developer: Restart Extension Host`, then `Developer: Reload Window`.
- **Move to Archive** and **Move to Codex History** use the official Codex provider when available. Moving archived sessions back to normal history can fall back to a filesystem move if needed.

## What's New in 2.12.0

- Added a new settings page that organizes settings by category and provides settings backups and maintenance actions. The standard VS Code settings remain available from **Maintenance**.
- Added settings to independently hide timestamps and project aliases or paths in History, Pinned, and Search session rows.
- Added a per-table action in the Session Viewer to copy only that table in its original Markdown form.
- Improved Markdown table presentation with clearer spacing, separators, wrapping, and table-local horizontal scrolling.
- Added support for Codex array-form tool outputs and standalone local-shell, web-search, and image-generation response items.
- Fixed current Codex pasted-file records and verified Claude Code pasted and automatically truncated input so they render as attachment cards.
- Fixed Claude Code cross-session peer and coordinator messages so they render as dedicated cross-session message cards.
- Fixed Claude Code scratchpad links generated as cross-drive relative paths on Windows.
- Fixed blank lines collapsing inside syntax-highlighted code blocks in the Session Viewer.
- Fixed Session Viewer resume and restore controls sometimes remaining hidden after session reload, auto-refresh, or initial background history refresh.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Security

See [SECURITY](SECURITY.md) for details. Use Codex History Viewer v2.11.0 or later, preferably the latest published release. Do not install or redistribute v1.2.1 or earlier VSIX files.

## Privacy

This extension reads local session files and renders them inside VS Code. For Claude Code sessions in the standard local project layout, it can also read matching entries from `.claude/history.jsonl` and hash-verified text files from `.claude/paste-cache` to identify pasted or truncated input. These auxiliary files remain local, and unverifiable data is ignored. The extension does not implement any network communication and does not send session content anywhere.

If you use **Copy Quick Prompt** or **Copy Handoff Prompt to Clipboard**, this extension copies session context to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths such as the session file path and CWD. Review before sharing.

Settings backup JSON files exported from the **Maintenance** page may contain configured local folder paths. Workspace- and folder-scoped backups may also contain the current workspace or selected folder's absolute path or URI in target metadata. Review them before sharing.

## Project Scope

Codex History Viewer is intentionally local-first. Features that cannot be implemented using only locally available session data and require the extension to access external services over the network are outside the project scope. The extension will not request, store, or use sign-in credentials such as account IDs, passwords, API keys, or access tokens.

This includes, for example, live lookups of account quota, subscription status, billing information, and costs. Features that require continuously updated provider pricing or account-plan data are also outside the project scope, even when authentication is not required.

## Supported Providers

Codex History Viewer currently focuses on Codex and Claude Code session history.

Support for additional providers may be considered in the future at the maintainer's discretion, and only when they can be routinely used, tested, and maintained by the maintainer over the long term without compromising the extension's quality, compatibility, or security.

## Disclaimer

Codex History Viewer is an independent project and is not affiliated with, endorsed by, or officially associated with OpenAI, Anthropic, Codex, or Claude Code.

This extension works with locally stored session and history files created by official tools and extensions. Their file formats and internal behaviors may change without notice, which may affect compatibility.

Archive, restore, delete, import, and other file operations are designed to be conservative, but they may move or modify local files and extension-managed metadata. The author and contributors cannot guarantee recovery of lost or corrupted data.

Please keep backups of important session data.

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support%20this%20project-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/hiztam)
