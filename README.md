# Codex History Viewer

Browse, search, organize, and resume past Codex CLI / Claude Code sessions through the official VS Code extensions.

Latest release: **2.7.0** (2026-07-02).

![Codex History Viewer screenshot](media/screenshot.png)

## Why Use This Extension?

Codex and Claude Code sessions can become hard to revisit once they are no longer active in the editor. Codex History Viewer keeps those local session files useful by turning them into a searchable, chat-like history browser inside VS Code.

Use it to find past prompts, reuse useful answers, inspect file changes, organize sessions with tags and notes, resume same-source sessions, and prepare handoff context for other AI tools.

## Highlights

- **Revisit past Codex CLI and Claude Code sessions** that are no longer easy to access from the active editor flow.
- Browse sessions in a year / month / day tree, a sortable session list, or project views with related project groups.
- Optionally include Codex `archived_sessions` when the Codex source is enabled, and switch archive visibility instantly.
- Show valid cached History and Pinned data immediately at startup while local session files refresh in the background.
- Search across prompts, responses, tool output, tags, notes, and attachment metadata, with shared search history.
- View sessions in a chat-like UI with Markdown, code highlighting, math rendering, tool cards, and file-change diffs.
- Enable an opt-in Codex turn timeline to see turn boundaries, turn summaries, completed-turn folding, and running state in live mode.
- Show Codex / Claude Code request interruptions as dedicated timeline cards.
- Open **File AI Change History** for a workspace file to review Codex / Claude diffs that touched that file.
- Bookmark important history cards and use date-guide markers to revisit them quickly.
- Keep open chat tabs up to date with header-controlled auto-refresh modes.
- Show supported image attachments, Claude documents, and file references from Codex / Claude sessions as compact cards.
- Organize sessions with pins, tags, notes, custom titles, project aliases, project associations, saved searches, search history, display modes, and filters.
- Keep Pinned filters independent from History/Search, including project scope, source, archive visibility, tags, and saved sort preferences.
- Experimental opt-in restoration for chat and file-change history Webviews after Reload Window or VS Code restart.
- Resume past sessions through the official Codex and Claude Code VS Code extensions.
- Create handoff files and prompts when moving work to another AI tool.

## Quick Start

1. Open the Activity Bar and select **Codex History**.
2. Use **Control** for global actions such as settings, import, rebuild cache, empty trash, and search defaults.
3. Browse sessions under **History** and switch between date-grouped/session-list layouts, List/Project display, All/Current Project Group scope, and saved sort preferences.
4. Select a session to open the reusable chat tab, or run **Open in New Tab (Chat)** to keep it in its own tab.
5. Use **Pinned** for saved sessions with its own date, project, source, archive, tag, and saved sort controls.
6. Run **Search...** and refine with roles, query syntax, search history, saved searches, and the current History filters.
7. Use context menus or chat header actions to edit tags/notes and run bulk tag operations when needed.
8. Enable **File Change History > Explorer Context Menu: Enabled** when you want file-level AI diff history from file right-click menus.
9. Keep Codex enabled in **Sources: Enabled**, then turn on Codex archived sessions if you want archived Codex history included.
10. Resume a same-source session through the official Codex or Claude Code extension, or use **Handoff to Other AI** when moving work between agents.

## History and Pinned Organization

History and Pinned separate project organization into display and scope controls. Display can switch between **List** and **Project** views, while scope can switch between **All** and **Current Project Group**. Project matching is case-insensitive across platforms. Project views preserve the existing layout choice: session-list history becomes `Project -> Session`, while date-grouped history becomes `Project -> Year -> Month -> Day -> Session`.

Project folders can have extension-local aliases from the History or Pinned project context menu. Aliases are stored in VS Code extension state without changing Codex or Claude Code history files. When set, aliases appear in project headings, session descriptions, tooltips, filter summaries, Status, and Search scope/session display while the original path remains available in detailed metadata.

Project associations can link another project's history into the current project display or group related projects together without moving the original history files. Associations are available from project context menus and are reflected in History, Pinned, Search, File AI Change History, and handoff content.

Pinned has its own project scope, source, archive visibility, date, tag filters, and saved sort preference. It does not follow History/Search filter state, so saved sessions can stay focused on a different project or source while you browse and search elsewhere. History can sort by started date, last activity date, or name. Pinned can sort by pinned time, started date, last activity date, or name.

## Chat Viewer

The chat viewer renders local session files as readable conversation timelines. It supports Markdown, syntax-highlighted fenced code blocks, KaTeX-compatible math, assistant usage metadata, environment snapshots, tool execution metadata, and grouped file-change cards from patch activity.

Large histories can use the `auto`, `normal`, or `simplified` performance mode. Heavy tool details and large diff rows can be deferred until **Show details** is enabled or an individual entry is expanded.

Codex sessions can use an opt-in turn timeline. `basic` mode shows turn start/end markers, range rails, summaries, token counts, duration, and manual folding for completed turns. `live` mode adds running-turn indicators, elapsed time, and update activity effects.

Patch group cards can show compact file summaries and an in-place **Open all diffs** / **Close all diffs** action.

Request interruptions from Codex and Claude Code render as dedicated timeline cards. When available, details include reason, duration, turn ID, rollback state, and rolled-back turn count.

Chat tabs preserve useful state across reload and auto-refresh, including scroll position, selected message, expanded cards/diffs, detail visibility, diff wrapping, and in-page search state. The experimental opt-in **Restore Webview Tabs After Reload** setting can also restore chat and file-change history panels after **Developer: Reload Window** or VS Code restart. It is disabled by default because VS Code can defer Webview restoration and may occasionally create duplicate tabs when the same history is opened again.

Chat history can keep the current user prompt visible at the top while you scroll. Codex memory citation information is rendered as a collapsible section instead of being left as raw metadata in the message body.

## Attachments and References

The chat viewer keeps attachments and file references out of the message body and renders them as cards instead.

- Supported images from Codex / Claude sessions are loaded on demand and can be previewed or saved.
- Claude Code PDF, text, and generic documents render as document cards. Text document previews open inside the card, and embedded payloads are saved on demand.
- Claude Code IDE opened-file and selection markers render as file/selection reference cards instead of raw inline tags.
- Codex mentioned-file blocks render as file reference cards while the actual request body remains as message text, including blocks that appear after IDE context.
- File reference cards can open local files through VS Code. Referenced files are not read automatically for rendering, search, resume, or handoff.
- Card metadata such as path, MIME type, and size is available from tooltips instead of taking over the conversation layout.
- Markdown transcripts, resume text, and handoff files use clean text plus attachment summaries instead of repeating raw tags or file blocks.

## Search

Search is local, cancellable, and backed by an incremental search index. It can search conversation text, configured tool metadata, titles, tags, notes, and attachment metadata.

Supported query forms include normal substring search, `exact:...`, `re:...`, `/regex/`, and boolean `AND` / `OR` / `NOT`.

Search follows the current History target, including date, project scope, project filter, source, archive visibility, and tags. It does not follow Pinned filters, and it does not create Search results from filters alone.

The global search input combines manual search and search history. Search history is shared with in-page search in the chat viewer and File AI Change History, stores only query text, and can be selected to run or removed individually with the trash button. Saved searches also store and reuse only query text; role filters and case sensitivity are taken from the current settings when the saved search is run, and saved searches can be removed individually from the run picker.

Opening a Search result can pass the same query into the chat viewer's in-page search. In-page search in the chat viewer and File AI Change History supports the same query forms, including exact matching and regular expressions, and can show search-history suggestions below the search input.

Project aliases are shown in Search scope and result display, but they are not added to the search index or treated as searchable hit text.

The search index can be tuned with `codexHistoryViewer.search.indexToolContent`:

- `conversationOnly`
- `toolCalls`
- `toolCallsAndOutputs`

Attachment indexing includes labels, paths, MIME types, file kinds, and bounded text from Claude text documents. PDF / Office / binary / base64 document contents and Codex referenced-file contents are not indexed.

## Codex Archived Sessions

Codex History Viewer can optionally read Codex `archived_sessions` in addition to normal Codex `sessions`. Archived sessions can be shown as active only, archived only, or all. Search follows the History archive-visibility scope, while Pinned keeps its own independent archive-visibility state. Active Codex sessions expose **Move to Archive**, while archived Codex sessions expose **Move to Codex History**.

Archive and restore operations prefer the official Codex provider. Moving archived sessions back to normal Codex history can fall back to a filesystem move when the official provider is unavailable. Pins, annotations, bookmarks, and saved chat positions are relocated when the session path changes.

## Handoff to Other AI

Handoff actions appear under **Handoff to Other AI** for visible Codex / Claude sessions when `codexHistoryViewer.handoff.enabled` is enabled. They can create a reusable handoff file, copy a prompt that points another AI to that file, or open the handoff file for manual use. Codex sessions can also be handed off directly to Claude Code when the Claude Code extension is available.

Handoff files are stored in this extension's VS Code global storage and include a tail-prioritized transcript excerpt, the latest user request, the source session path, recoverable file changes, and attachment summaries. Tool calls, tool outputs, and binary attachment payloads are intentionally omitted.

When project associations are configured, handoff generation follows the associated project display and includes path mapping context for the receiving AI.

## File AI Change History

File AI Change History starts from a workspace file and shows the Codex / Claude changes that touched that file over time.

![File AI Change History screenshot](media/screenshot_2.png)

Use it when you want to answer questions such as:

- Which AI session changed this file?
- How did this file evolve across Codex and Claude sessions?
- What was the surrounding session context for a specific diff?

The Explorer file context menu entry is opt-in. Enable **File Change History > Explorer Context Menu: Enabled**, then right-click a file in VS Code Explorer and run **Show File AI Change History**.

The view is scoped to the current workspace and selected file. It supports Codex / Claude source toggles, in-page search with shared query history and richer query syntax, incremental **Load more**, previous/next navigation, and **Open in History** links back to the matching diff card in the original session.

File AI Change History follows project associations when resolving related history, so associated project displays and path mappings are reflected when possible.

## Configuration

Most settings are available from VS Code Settings under **Codex History Viewer**. Common settings include:

- `codexHistoryViewer.sources.enabled`: enable `codex`, `claude`, or both.
- `codexHistoryViewer.sessionsRoot`: Codex sessions root.
- `codexHistoryViewer.claude.sessionsRoot`: Claude Code sessions root.
- `codexHistoryViewer.codex.archivedSessions.enabled`: include Codex archived sessions.
- `codexHistoryViewer.handoff.enabled`: show cross-agent handoff actions.
- `codexHistoryViewer.search.indexToolContent`: control search index tool-content scope.
- `codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled`: show **File AI Change History** in Explorer.
- `codexHistoryViewer.autoRefresh.enabled`: watch local session files and refresh the History tree and opted-in chat tabs when the VS Code window is focused and the History tree is visible or an opted-in chat tab is open.
- `codexHistoryViewer.chat.openPosition`: open chat at top, last viewed message, or latest rendered card.
- `codexHistoryViewer.chat.stickyUserPrompt`: keep the current user prompt visible while scrolling chat history.
- `codexHistoryViewer.chat.performanceMode`: choose default chat rendering performance mode.
- `codexHistoryViewer.chat.turnTimeline.mode`: enable the opt-in Codex turn timeline with `off`, `basic`, or `live`.
- `codexHistoryViewer.webview.restoreAfterReload`: experimental opt-in to restoring chat and file-change history Webview tabs after Reload Window or VS Code restart.
- `codexHistoryViewer.images.enabled`: show supported image attachments.
- `codexHistoryViewer.ui.timeGuide.enabled`: enable compact date guides and bookmark controls.
- `codexHistoryViewer.ui.language`: choose `auto`, `en`, or `ja`.

### Suggested Settings

The defaults are designed for regular use. These settings are useful starting points when you want a lighter UI, richer search, or more active refresh behavior:

| Situation | Suggested settings |
| --- | --- |
| Large sessions or many diffs | Keep `codexHistoryViewer.chat.performanceMode` set to `auto`, or use `simplified` if chat views feel heavy. |
| Codex turn boundaries without live effects | Set `codexHistoryViewer.chat.turnTimeline.mode` to `basic`. |
| Live Codex turn tracking | Set `codexHistoryViewer.chat.turnTimeline.mode` to `live`. |
| Faster, narrower search | Use `codexHistoryViewer.search.indexToolContent: toolCalls` instead of `toolCallsAndOutputs`, and lower `codexHistoryViewer.search.maxResults` if needed. |
| Long sessions, bookmarks, or frequent timeline jumps | Enable `codexHistoryViewer.ui.timeGuide.enabled`. |
| Frequent image-heavy sessions | Lower `codexHistoryViewer.images.thumbnailSize` or `codexHistoryViewer.images.maxSizeMB`. |
| Live-updating session files | Enable `codexHistoryViewer.autoRefresh.enabled` when you want the History tree and opted-in chat tabs to refresh while the VS Code window is focused. |
| Restoring chat tabs after reload | Enable `codexHistoryViewer.webview.restoreAfterReload` only if you accept the experimental duplicate-tab caveat. |

If history or search results look stale, run **Control > Rebuild Cache**. It recreates both the history cache and search index after confirmation.

## Commands

Most actions are available from view title buttons and tree context menus.

For the full command list with per-command descriptions, see:

- [Command Reference](docs/commands.md)

## OpenAI Codex Integration Notes

- The first **Resume in OpenAI Codex** may show a VS Code security prompt for the target extension URI. Click **Open** to continue.
- If the official Codex extension stops reopening a conversation, try `Developer: Reload Webviews`, then `Developer: Restart Extension Host`, then `Developer: Reload Window`.
- **Move to Archive** and **Move to Codex History** use the official Codex provider when available. Moving archived sessions back to normal history can fall back to a filesystem move if needed.

## What's New in 2.7.0

- Added an opt-in Codex session turn timeline with turn boundaries, summaries, completed-turn folding, and running state in live mode.
- Added the `codexHistoryViewer.chat.turnTimeline.mode` setting with `off`, `basic`, and `live` modes.
- Added compact file summaries for patch group cards.
- Added an in-place **Open all diffs** / **Close all diffs** action for patch group cards.
- Improved auto-refresh `follow` mode and chat scrolling to the top, bottom, and latest positions.

## Changelog

See [CHANGELOG](CHANGELOG.md).

## Security

See [SECURITY](SECURITY.md). Use the latest release whenever possible; do not install or redistribute v1.2.1 or earlier VSIX files.

## Privacy

This extension reads local session files and renders them inside VS Code. It does not implement any network communication and does not send session content anywhere.

If you use **Copy Quick Prompt** or **Copy Handoff Prompt to Clipboard**, this extension copies session context to your clipboard. Data is only sent externally if you paste it into another tool or extension.

When you open a session as a Markdown transcript, the generated transcript includes local paths such as the session file path and CWD. Review before sharing.

## Disclaimer

Codex History Viewer is an independent project and is not affiliated with, endorsed by, or officially associated with OpenAI, Anthropic, Codex, or Claude.

This extension works with locally stored session and history files created by official tools and extensions. Their file formats and internal behaviors may change without notice, which may affect compatibility.

Archive, restore, delete, import, and other file operations are designed to be conservative, but they may move or modify local files and extension-managed metadata. The author and contributors cannot guarantee recovery of lost or corrupted data.

Please keep backups of important session data.

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Support%20this%20project-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/hiztam)
