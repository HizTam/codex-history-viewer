// Webview script. Communicates with the extension via postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const toolbarEl = document.getElementById("toolbar");
  const scrollRootEl = document.getElementById("scrollRoot");
  const metaEl = document.getElementById("meta");
  const annotationEl = document.getElementById("annotation");
  const timelineEl = document.getElementById("timeline");
  const btnResumeInCodex = document.getElementById("btnResumeInCodex");
  const btnPinToggle = document.getElementById("btnPinToggle");
  const btnCustomTitle = document.getElementById("btnCustomTitle");
  const btnMarkdown = document.getElementById("btnMarkdown");
  const btnCopyResume = document.getElementById("btnCopyResume");
  const btnToggleDetails = document.getElementById("btnToggleDetails");
  const btnPathMode = document.getElementById("btnPathMode");
  const btnScrollTop = document.getElementById("btnScrollTop");
  const btnScrollBottom = document.getElementById("btnScrollBottom");
  const btnPageSearch = document.getElementById("btnPageSearch");
  const btnPerformanceMode = document.getElementById("btnPerformanceMode");
  const btnAutoRefresh = document.getElementById("btnAutoRefresh");
  const btnReload = document.getElementById("btnReload");
  const pageSearchBarEl = document.getElementById("pageSearchBar");
  const pageSearchResizeHandleEl = document.getElementById("pageSearchResizeHandle");
  const pageSearchTitleEl = document.getElementById("pageSearchTitle");
  const pageSearchRoleFiltersEl = document.getElementById("pageSearchRoleFilters");
  const pageSearchInputEl = document.getElementById("pageSearchInput");
  const pageSearchCountEl = document.getElementById("pageSearchCount");
  const pageSearchSuggestionsEl = document.getElementById("pageSearchSuggestions");
  const pageSearchResultsEl = document.getElementById("pageSearchResults");
  const btnPageSearchPrev = document.getElementById("btnPageSearchPrev");
  const btnPageSearchNext = document.getElementById("btnPageSearchNext");
  const btnPageSearchClose = document.getElementById("btnPageSearchClose");
  const restoreCoverEl = document.getElementById("restoreCover");

  const md = createMarkdownRenderer();
  const CODE_COMMENT_DIRECTIVE_PREFIX = "::code-comment{";
  const MAX_CODE_COMMENT_DIRECTIVES_PER_MESSAGE = 50;
  const MAX_CODE_COMMENT_DIRECTIVE_LENGTH = 20000;
  const MAX_CODE_COMMENT_FILE_LENGTH = 4096;
  const MAX_CODE_COMMENT_TITLE_LENGTH = 512;
  const MAX_CODE_COMMENT_BODY_LENGTH = 20000;
  const MAX_PAGE_SEARCH_HISTORY_CANDIDATES = 20;
  const CODE_COMMENT_ATTRIBUTE_KEYS = new Set(["file", "title", "body", "start", "end", "priority"]);
  const COPY_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 1.5H6A1.5 1.5 0 0 0 4.5 3H3.75A1.75 1.75 0 0 0 2 4.75v8.5C2 14.216 2.784 15 3.75 15h8.5c.966 0 1.75-.784 1.75-1.75v-8.5C14 3.784 13.216 3 12.25 3H11.5A1.5 1.5 0 0 0 10 1.5Zm-4 1H10a.5.5 0 0 1 .5.5V3H5.5V3a.5.5 0 0 1 .5-.5ZM3.75 4h8.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-8.5a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 3.75 4Z"/></svg>';
  const RELOAD_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75.75.75 0 0 0-1.5 0A4.25 4.25 0 1 1 8 3.75h2.06l-.8.8a.75.75 0 0 0 1.06 1.06l2.08-2.08a.75.75 0 0 0 0-1.06L10.32.39A.75.75 0 0 0 9.26 1.45l.8.8H8Z"/></svg>';
  const SCROLL_TOP_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 2h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1 0-1.5Zm4.22 2.47a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 1 1-1.06 1.06L8.75 6.81V13a.75.75 0 0 1-1.5 0V6.81L5.28 8.78a.75.75 0 1 1-1.06-1.06l3.25-3.25Z"/></svg>';
  const SCROLL_BOTTOM_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 12.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1 0-1.5Zm4-9.5a.75.75 0 0 1 1.5 0v6.19l1.97-1.97a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 8.28a.75.75 0 1 1 1.06-1.06l1.97 1.97V3Z"/></svg>';
  const NAV_UP_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.2a.75.75 0 0 1 .53.22l4.1 4.1a.75.75 0 1 1-1.06 1.06L8 4.99 4.43 8.58a.75.75 0 1 1-1.06-1.06l4.1-4.1A.75.75 0 0 1 8 3.2Z"/></svg>';
  const NAV_DOWN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 12.8a.75.75 0 0 1-.53-.22l-4.1-4.1a.75.75 0 0 1 1.06-1.06L8 11.01l3.57-3.59a.75.75 0 0 1 1.06 1.06l-4.1 4.1A.75.75 0 0 1 8 12.8Z"/></svg>';
  const NAV_LEFT_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M9.53 3.22a.75.75 0 0 1 0 1.06L5.81 8l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"/></svg>';
  const NAV_RIGHT_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.47 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L10.19 8 6.47 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';
  const CARD_EXPAND_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h3a.75.75 0 0 1 0 1.5H5.56l2.22 2.22a.75.75 0 1 1-1.06 1.06L4.5 4.56v1.19a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 3.75 2Zm5.5 0h3a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0V4.56L9.28 6.78a.75.75 0 1 1-1.06-1.06l2.22-2.22H9.25a.75.75 0 0 1 0-1.5ZM7.78 10.28 5.56 12.5h1.19a.75.75 0 0 1 0 1.5h-3A.75.75 0 0 1 3 13.25v-3a.75.75 0 0 1 1.5 0v1.19l2.22-2.22a.75.75 0 1 1 1.06 1.06Zm1.44 0a.75.75 0 0 1 1.06-1.06l2.22 2.22v-1.19a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-.75.75h-3a.75.75 0 0 1 0-1.5h1.19l-2.22-2.22Z"/></svg>';
  const CARD_RESTORE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a.75.75 0 0 1 .75.75v3A.75.75 0 0 1 6.75 6h-3a.75.75 0 0 1 0-1.5h1.19L2.72 2.28a.75.75 0 1 1 1.06-1.06L6 3.44V2.75A.75.75 0 0 1 6.75 2Zm2.5 0a.75.75 0 0 1 .75.75v.69l2.22-2.22a.75.75 0 1 1 1.06 1.06L11.06 4.5h1.19a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75v-3A.75.75 0 0 1 9.25 2ZM3.75 10h3a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-.69l-2.22 2.22a.75.75 0 1 1-1.06-1.06L4.94 12H3.75a.75.75 0 0 1 0-1.5Zm5.5 0h3a.75.75 0 0 1 0 1.5h-1.19l2.22 2.22a.75.75 0 1 1-1.06 1.06L10 12.56v.69a.75.75 0 0 1-1.5 0v-3a.75.75 0 0 1 .75-.75Z"/></svg>';
  const RESUME_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.5 2.5a.75.75 0 0 1 .75.75v2.53A5.25 5.25 0 1 1 2.75 8a.75.75 0 0 1 1.5 0 3.75 3.75 0 1 0 2-3.31v2.06a.75.75 0 0 1-1.28.53L2.7 5.03a.75.75 0 0 1 0-1.06l2.27-2.25a.75.75 0 0 1 .53-.22Z"/></svg>';
  const PIN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.25 1.5a.75.75 0 0 0-.53 1.28L5.94 4v2.38L3.72 8.6a.75.75 0 0 0 .53 1.28h3v4.37a.75.75 0 0 0 1.5 0V9.88h3a.75.75 0 0 0 .53-1.28L10.06 6.38V4l1.22-1.22a.75.75 0 0 0-.53-1.28h-5.5Z"/></svg>';
  const BOOKMARK_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.25 2A1.25 1.25 0 0 1 5.5.75h5A1.25 1.25 0 0 1 11.75 2v11.8a.75.75 0 0 1-1.14.64L8 12.86l-2.61 1.58a.75.75 0 0 1-1.14-.64V2Zm1.5.25v10.22l1.86-1.13a.75.75 0 0 1 .78 0l1.86 1.13V2.25h-4.5Z"/></svg>';
  const CUSTOM_TITLE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.56 1.56a1.9 1.9 0 0 1 2.68 2.68l-7.4 7.4a2.25 2.25 0 0 1-1.01.57l-2.24.56a.75.75 0 0 1-.91-.91l.56-2.24c.1-.4.3-.74.57-1.01l7.4-7.4Zm1.62 1.06a.4.4 0 0 0-.56 0l-1.04 1.04 1.62 1.62 1.04-1.04a.4.4 0 0 0 0-.56l-1.06-1.06ZM10.52 4.72 4.31 10.93a.75.75 0 0 0-.19.34l-.3 1.2 1.2-.3a.75.75 0 0 0 .34-.19l6.21-6.21-1.05-1.05Z"/></svg>';
  const MARKDOWN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 2h9.5A1.75 1.75 0 0 1 14.5 3.75v8.5A1.75 1.75 0 0 1 12.75 14h-9.5A1.75 1.75 0 0 1 1.5 12.25v-8.5A1.75 1.75 0 0 1 3.25 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h9.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-9.5Zm1.5 1.75h1.5l1.25 1.88 1.25-1.88h1.5v5.5H9V7.55L7.5 9.75 6 7.55v3.2H4.75v-5.5Zm6.5 3h1.25l-1.88 2.5-1.87-2.5h1.25V5.25h1.25v3Z"/></svg>';
  const SEARCH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm4.9 6.83 2.13 2.14a.75.75 0 1 1-1.06 1.06l-2.14-2.13a.75.75 0 1 1 1.07-1.07Z"/></svg>';
  const AUTO_REFRESH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><g fill="none"><path d="M5.2 2.6A5.2 5.2 0 0 1 13 7"/><path d="M13 7l1.15-1.55M13 7l-1.55-1.15"/><path d="M10.8 13.4A5.2 5.2 0 0 1 3 9"/><path d="M3 9l-1.15 1.55M3 9l1.55 1.15"/><circle cx="8" cy="8" r="2.25"/><path d="M8 6.75v1.45l1.05.65"/></g></svg>';
  const PERFORMANCE_NORMAL_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><g fill="none"><path d="M2.75 10.75a5.25 5.25 0 1 1 10.5 0"/><path d="M8 10.75 10.7 6.9"/><path d="M4.75 10.75h6.5"/></g></svg>';
  const PERFORMANCE_SIMPLIFIED_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><g fill="none"><path d="M2.75 10.75a5.25 5.25 0 1 1 10.5 0"/><path d="M8 10.75 11.6 5.5"/><path d="M6.9 2.95 5.65 6.3h2.3l-1.1 3.05 3.45-4.6H8.1l1.05-1.8"/></g></svg>';
  const CLOSE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
  const SAVE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h7.5c.4 0 .78.16 1.06.44l1.25 1.25c.28.28.44.66.44 1.06v7.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25V5.06L10.94 3.5H10.5v2.25c0 .414-.336.75-.75.75h-4.5a.75.75 0 0 1-.75-.75V3.5h-.75Zm2.25 0V5h3V3.5H6Zm-.25 5h4.5A1.75 1.75 0 0 1 12 10.25v2.25h-1.5v-2.25a.25.25 0 0 0-.25-.25h-4.5a.25.25 0 0 0-.25.25v2.25H4v-2.25C4 9.284 4.784 8.5 5.75 8.5Z"/></svg>';
  const TRASH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.25 1.75h3.5c.69 0 1.25.56 1.25 1.25v.5h2.25a.75.75 0 0 1 0 1.5H12.9l-.62 8.05A1.75 1.75 0 0 1 10.54 14H5.46a1.75 1.75 0 0 1-1.74-1.95L3.1 5H2.75a.75.75 0 0 1 0-1.5H5V3c0-.69.56-1.25 1.25-1.25Zm1.25 5a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 1.5 0v-5Zm2.5 0a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 1.5 0v-5ZM6.5 3.5h3V3h-3v.5Zm-1 1.5.61 7.94c.01.03.03.06.07.06h5.08c.04 0 .06-.03.07-.06L11.5 5h-6Z"/></svg>';
  const PATCH_WRAP_ON_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.75 4h10.5a.75.75 0 0 1 0 1.5H5.56l1.22 1.22a.75.75 0 0 1-1.06 1.06L3.22 5.28a.75.75 0 0 1 0-1.06l2.5-2.5a.75.75 0 0 1 1.06 1.06L5.56 4H2.75Zm0 4.5h6.5a2.75 2.75 0 1 1 0 5.5H7.31l1.22 1.22a.75.75 0 1 1-1.06 1.06l-2.5-2.5a.75.75 0 0 1 0-1.06l2.5-2.5a.75.75 0 1 1 1.06 1.06L7.31 12.5h1.94a1.25 1.25 0 0 0 0-2.5h-6.5a.75.75 0 0 1 0-1.5Z"/></svg>';
  const PATCH_WRAP_OFF_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.75 4h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 3.25h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5Zm0 3.25h8.7l-1.2-1.2a.75.75 0 1 1 1.06-1.06l2.47 2.47a.75.75 0 0 1 0 1.06l-2.47 2.47a.75.75 0 0 1-1.06-1.06l1.2-1.2h-8.7a.75.75 0 0 1 0-1.5Z"/></svg>';
  const PATCH_JUMP_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h5.5a.75.75 0 0 1 0 1.5h-5.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm4.72 1.22a.75.75 0 0 1 .53-.22h4.25a.75.75 0 0 1 .75.75V8a.75.75 0 0 1-1.5 0V5.56L8.78 9.28a.75.75 0 1 1-1.06-1.06l3.72-3.72H9a.75.75 0 0 1-.53-1.28Z"/></svg>';
  const DETAILS_ON_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.25c3.53 0 6.25 3.62 6.25 4.75S11.53 12.75 8 12.75 1.75 9.13 1.75 8 4.47 3.25 8 3.25Zm0 1.5c-2.7 0-4.75 2.54-4.75 3.25s2.05 3.25 4.75 3.25 4.75-2.54 4.75-3.25S10.7 4.75 8 4.75Zm0 1a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5Z"/></svg>';
  const DETAILS_OFF_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.28 1.72a.75.75 0 1 0-1.06 1.06l11 11a.75.75 0 0 0 1.06-1.06l-1.45-1.45A7.74 7.74 0 0 0 14.25 8C14.25 6.87 11.53 3.25 8 3.25c-.97 0-1.88.27-2.72.7L2.28 1.72Zm4.09 4.09a2.25 2.25 0 0 1 3.82 2.43L6.37 5.81Zm2.82 5.94A5.65 5.65 0 0 1 8 12.75C4.47 12.75 1.75 9.13 1.75 8c0-.7 1.07-2.14 2.75-2.86l1.16 1.16a2.25 2.25 0 0 0 3.04 3.04l.49.49Z"/></svg>';
  const PATH_RECORDED_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Zm0 1.5a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5Zm.75 2.25v2.18l1.47 1.47a.75.75 0 1 1-1.06 1.06L7.47 8.53A.75.75 0 0 1 7.25 8V5.5a.75.75 0 0 1 1.5 0Z"/></svg>';
  const PATH_RELOCATED_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.75 3.25h4.4a.75.75 0 0 1 .53.22L9.2 5h4.05c.97 0 1.75.78 1.75 1.75v6A1.75 1.75 0 0 1 13.25 14H2.75A1.75 1.75 0 0 1 1 12.75v-7.5c0-.97.78-1.75 1.75-1.75Zm0 1.5a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-6a.25.25 0 0 0-.25-.25H8.58a.75.75 0 0 1-.53-.22L6.83 4.75H2.75Zm2.5 3.5h4.69l-.72-.72a.75.75 0 1 1 1.06-1.06l2 2a.75.75 0 0 1 0 1.06l-2 2a.75.75 0 1 1-1.06-1.06l.72-.72H5.25a.75.75 0 0 1 0-1.5Z"/></svg>';
  const TOOL_ICON_SVGS = Object.freeze({
    agent:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75a.75.75 0 0 1 .75.75v.84a4.5 4.5 0 0 1 3.91 3.91h.84a.75.75 0 0 1 0 1.5h-.84a4.5 4.5 0 0 1-3.91 3.91v.84a.75.75 0 0 1-1.5 0v-.84a4.5 4.5 0 0 1-3.91-3.91H2.5a.75.75 0 0 1 0-1.5h.84a4.5 4.5 0 0 1 3.91-3.91V2.5A.75.75 0 0 1 8 1.75Zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>',
    bash:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.75 2h10.5C14.216 2 15 2.784 15 3.75v8.5c0 .966-.784 1.75-1.75 1.75H2.75A1.75 1.75 0 0 1 1 12.25v-8.5C1 2.784 1.784 2 2.75 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H2.75Zm1.66 2.03a.75.75 0 0 1 1.06 0l1.94 1.94a.75.75 0 0 1 0 1.06l-1.94 1.94a.75.75 0 1 1-1.06-1.06L5.81 8 4.41 6.59a.75.75 0 0 1 0-1.06ZM8 10.25h3a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1 0-1.5Z"/></svg>',
    edit:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.56 1.56a1.9 1.9 0 0 1 2.68 2.68l-7.4 7.4a2.25 2.25 0 0 1-1.01.57l-2.24.56a.75.75 0 0 1-.91-.91l.56-2.24c.1-.4.3-.74.57-1.01l7.4-7.4Zm1.62 1.06a.4.4 0 0 0-.56 0l-1.04 1.04 1.62 1.62 1.04-1.04a.4.4 0 0 0 0-.56l-1.06-1.06ZM10.52 4.72 4.31 10.93a.75.75 0 0 0-.19.34l-.3 1.2 1.2-.3a.75.75 0 0 0 .34-.19l6.21-6.21-1.05-1.05Z"/></svg>',
    glob:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.75 3A1.75 1.75 0 0 0 1 4.75v6.5C1 12.216 1.784 13 2.75 13h5.7a.75.75 0 0 0 0-1.5h-5.7a.25.25 0 0 1-.25-.25v-6.5c0-.14.11-.25.25-.25h3.12l1.5 1.5h1.88a.25.25 0 0 1 .25.25v1.2a.75.75 0 0 0 1.5 0v-1.2A1.75 1.75 0 0 0 9.25 4.5H7.99L6.49 3H2.75Zm9.82 5.6a2.6 2.6 0 1 1-1.84 4.44l-1.7 1.7a.75.75 0 1 1-1.06-1.06l1.7-1.7A2.6 2.6 0 0 1 12.57 8.6Zm0 1.5a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"/></svg>',
    grep:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm4.9 6.83 2.13 2.14a.75.75 0 1 1-1.06 1.06l-2.14-2.13a.75.75 0 1 1 1.07-1.07Zm-5.9-4.08h2.8a.75.75 0 0 1 0 1.5h-2.8a.75.75 0 0 1 0-1.5Z"/></svg>',
    read:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 1.75h6.7c.4 0 .78.16 1.06.44l1.8 1.8c.28.28.44.66.44 1.06v7.7c0 .97-.78 1.75-1.75 1.75h-8A1.75 1.75 0 0 1 1.75 12.75v-9c0-.97.78-1.75 1.75-1.75Zm0 1.5a.25.25 0 0 0-.25.25v9c0 .14.11.25.25.25h8a.25.25 0 0 0 .25-.25V5.56L9.69 3.75H3.25Zm1.5 3.5h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Zm0 2.5h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Z"/></svg>',
    unknown:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75a3.25 3.25 0 0 1 3.25 3.25c0 1.11-.53 1.88-1.1 2.43-.27.26-.52.45-.72.6-.14.1-.27.2-.36.29-.18.16-.32.34-.32.68v.25a.75.75 0 0 1-1.5 0V9c0-.9.43-1.44.82-1.79.16-.15.34-.28.51-.41.17-.12.33-.24.47-.38.42-.4.7-.82.7-1.42A1.75 1.75 0 0 0 6.25 5a.75.75 0 0 1-1.5 0A3.25 3.25 0 0 1 8 1.75Zm0 11.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>',
    webFetch:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Zm0 1.5A4.75 4.75 0 0 0 5.15 12h1.28c-.28-.78-.45-1.7-.45-2.7H3.55a4.74 4.74 0 0 0 1.6 2.7H8Zm2.85-1.25h-1.28c.28.78.45 1.7.45 2.7h2.43a4.74 4.74 0 0 0-1.6-2.7Zm-5.7 0a4.74 4.74 0 0 0-1.6 2.7h2.43c0-1 .17-1.92.45-2.7H5.15ZM8 3.37c-.35.52-.68 1.4-.68 2.83h1.36c0-1.43-.33-2.31-.68-2.83Zm2.02 4.33H6c0 1.24.18 2.28.48 3.05h3.04c.3-.77.48-1.81.48-3.05Zm-.77 5.55h1.6a4.76 4.76 0 0 0 1.6-2.7h-2.43c0 .99-.17 1.92-.45 2.7Zm-2.5 0c-.28-.78-.45-1.71-.45-2.7H3.55a4.76 4.76 0 0 0 1.6 2.7h1.6Zm1.25-.62c.35-.52.68-1.4.68-2.83H7.32c0 1.43.33 2.31.68 2.83Z"/></svg>',
    webSearch:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm4.9 6.83 2.13 2.14a.75.75 0 1 1-1.06 1.06l-2.14-2.13a.75.75 0 1 1 1.07-1.07Z"/></svg>',
    write:
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 1.75h7.5c.4 0 .78.16 1.06.44l1 1c.28.28.44.66.44 1.06v8.5c0 .97-.78 1.75-1.75 1.75h-8A1.75 1.75 0 0 1 1.75 12.75v-9c0-.97.78-1.75 1.75-1.75Zm0 1.5a.25.25 0 0 0-.25.25v9c0 .14.11.25.25.25h8a.25.25 0 0 0 .25-.25v-8.19l-.81-.81H3.25Zm1.5 1.5h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Zm3 3.25a.75.75 0 0 1 .75.75v1h1a.75.75 0 0 1 0 1.5h-1v1a.75.75 0 0 1-1.5 0v-1h-1a.75.75 0 0 1 0-1.5h1v-1A.75.75 0 0 1 7.75 8Z"/></svg>',
  });
  const PAGE_SEARCH_ROLE_ORDER = Object.freeze(["user", "assistant", "tool"]);
  const PAGE_SEARCH_ROLE_SET = new Set(PAGE_SEARCH_ROLE_ORDER);
  const PAGE_SEARCH_ROLE_SHORT_LABELS = Object.freeze({
    user: "U",
    assistant: "A",
    tool: "T",
  });
  const PATCH_LANGUAGE_BY_EXTENSION = Object.freeze({
    ".bash": "shellscript",
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".htm": "html",
    ".html": "html",
    ".ini": "ini",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsonc": "jsonc",
    ".jsx": "jsx",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".md": "markdown",
    ".nginx": "nginx",
    ".php": "php",
    ".proto": "proto",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shellscript",
    ".sql": "sql",
    ".swift": "swift",
    ".tf": "terraform",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zsh": "shellscript",
  });
  const PATCH_LANGUAGE_BY_FILENAME = Object.freeze({
    dockerfile: "dockerfile",
    makefile: "makefile",
  });
  const MIN_PAGE_SEARCH_WIDTH = 280;
  const PAGE_SEARCH_HORIZONTAL_MARGIN = 16;
  const PAGE_SEARCH_REFRESH_DEBOUNCE_MS = 180;
  const RESTORE_POSITION_SAVE_DEBOUNCE_MS = 500;
  const OPEN_POSITION_SAVE_DEBOUNCE_MS = 800;
  const MAX_CACHED_IMAGE_DATA = 64;
  const TIME_GUIDE_REBUILD_IDLE_TIMEOUT_MS = 900;
  const TIME_GUIDE_REBUILD_FALLBACK_DELAY_MS = 80;
  const RESTORE_COVER_HIDE_DELAY_MS = 140;
  const RESTORE_COVER_MIN_VISIBLE_MS = 220;
  const RESTORE_COVER_MAX_WAIT_MS = 900;
  const RESTORE_COVER_STABLE_FRAMES = 3;
  const DEFERRED_RENDER_FRAME_BUDGET_MS = 8;
  const DEFERRED_PATCH_ROOT_MARGIN = "1200px 0px";
  const DEFERRED_PATCH_PLACEHOLDER_MIN_HEIGHT = 120;
  const DEFERRED_SEARCH_REFRESH_DELAY_MS = 180;
  const SIMPLIFIED_FILE_SIZE_BYTES = 16 * 1024 * 1024;
  const SIMPLIFIED_ITEM_COUNT = 1000;
  const SIMPLIFIED_DIFF_ENTRY_COUNT = 300;
  const SIMPLIFIED_DIFF_LINE_ESTIMATE = 8000;
  const SIMPLIFIED_IMAGE_COUNT = 80;
  const STICKY_USER_SUMMARY_LIMIT = 180;
  const STICKY_USER_PREVIEW_LIMIT = 6000;
  const STICKY_USER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

  /** @type {any} */
  let model = null;
  /** @type {any} */
  let i18n = {};
  /** @type {{ timeZone?: string }} */
  let dateTime = {};
  let toolDisplayMode = "detailsOnly";
  let userLongMessageFolding = "off";
  let assistantLongMessageFolding = "off";
  let stickyUserPromptEnabled = true;
  let turnTimelineMode = "off";
  let imageSettings = { thumbnailSize: "medium" };
  let panelKind = "session";
  let chatOpenPosition = "top";
  let configuredPerformanceMode = "auto";
  let temporaryPerformanceMode = null;
  let effectivePerformanceMode = "normal";
  let performanceStats = {};
  let lastPerformanceDebugSignature = "";
  let autoPerformanceToastShown = false;
  let autoRefreshAvailable = false;
  let autoRefreshMode = "off";
  let pathMode = "recorded";
  let pathModeEnabled = false;
  let debugLoggingEnabled = false;
  let imagePreview = null;
  const imageDataById = new Map();
  const pendingImageIds = new Set();
  const failedImageIds = new Set();
  let showDetails = false;
  let detailsLoaded = false;
  let detailReloadPending = false;
  let expandedNote = false;
  let selectedMessageIndex = null;
  let pendingDetailScrollAnchor = null;
  let messageNavMap = new Map();
  let patchGroupNavMap = new Map();
  let currentTurnSummaryById = new Map();
  let expandedMessageIndexes = new Set();
  let expandedStickyUserKeys = new Set();
  let collapsedTurnIds = new Set();
  let pageSearchTemporaryTurnExpansionActive = false;
  let pageSearchTemporaryPatchGroupExpansionActive = false;
  let pageSearchTemporaryAttachmentExpansionActive = false;
  let stickyUserOverlayEl = null;
  let stickyUserRows = [];
  let stickyUserUpdateFrame = 0;
  let activeStickyUserKey = null;
  let stickyUserSuppressedUntilUserScroll = false;
  let stickyUserPointerScrollIntent = false;
  let runningTurnAnchorEl = null;
  let runningTurnFallbackEl = null;
  let runningTurnFallbackFrame = 0;
  let runningTurnElapsedTimer = 0;
  let runningTurnElapsedTimerIntervalMs = 0;
  let runningTurnActivitySignatures = new Map();
  let expandedPatchEntries = new Set();
  let expandedPatchGroupFileLists = new Set();
  let allDiffPatchGroupKeys = new Set();
  let allDiffPatchGroupPreviouslyWideKeys = new Set();
  let expandedAttachmentDetails = new Set();
  let pageSearchTemporaryAttachmentDetailKeys = new Set();
  let expandedUsageCardKeys = new Set();
  let wideTimelineCardKeys = new Set();
  let wrappedPatchHunkKeys = new Set();
  let isPinned = false;
  let bookmarkedKeys = new Set();
  let pageSearchMatches = [];
  let pageSearchResults = [];
  let activePageSearchResultIndex = -1;
  let pageSearchHistoryCandidates = [];
  let pendingPageSearchSeed = null;
  let pendingPageSearchRefreshOptions = null;
  let pageSearchShowingSuggestions = false;
  let activePageSearchSuggestionIndex = -1;
  let suppressNextPageSearchFocusSuggestions = false;
  let pageSearchCaseSensitive = false;
  let pageSearchErrorText = "";
  let pageSearchRefreshTimer = 0;
  let pageSearchContentRevision = 0;
  let lastCommittedPageSearchHistory = null;
  let pageSearchSelectedRoles = new Set();
  let pageSearchSuppressedTemporaryAttachmentDetailKeys = new Set();
  let pageSearchPanelWidth = null;
  let pageSearchResizeState = null;
  let renderDepth = 0;
  let renderAfterCurrentFrame = 0;
  let renderAfterCurrentCallbacks = [];
  let openPositionSaveTimer = 0;
  let restorePositionSaveTimer = 0;
  let toolbarCompactFrame = 0;
  let patchLayoutFrame = 0;
  let timeGuideEnabled = false;
  let timeGuide = null;
  let timeGuideItems = [];
  let timeGuideUpdateFrame = 0;
  let timeGuideUpdateTimer = 0;
  let timeGuideUpdateIdle = 0;
  let timeGuideUpdateNeedsRebuild = false;
  let timeGuideUpdateGeneration = 0;
  let restoreCoverActive = false;
  let restoreCoverFrame = 0;
  let restoreCoverTimer = 0;
  let restoreCoverShownAt = 0;
  let pendingTimeGuideAfterRestoreCover = null;
  let deferredRenderGeneration = 0;
  let deferredRenderQueue = [];
  let deferredRenderKeys = new Set();
  let deferredRenderFrame = 0;
  let deferredRenderTimer = 0;
  let deferredPatchObserver = null;
  let deferredPageSearchRefreshTimer = 0;
  const patchBodyHeightByEntryId = new Map();
  const patchEntrySummaryById = new Map();
  const patchEntryDetailsById = new Map();
  const patchEntryDetailsLoading = new Set();
  const patchEntryDetailsFailed = new Map();
  const deferredPatchBodyRequests = new WeakMap();
  let webviewState = typeof vscode.getState === "function" ? vscode.getState() || {} : {};
  const lazyImageObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              if (!(entry.target instanceof HTMLElement)) continue;
              lazyImageObserver.unobserve(entry.target);
              requestImageData(entry.target.dataset.imageId);
            }
          },
          {
            root: scrollRootEl instanceof Element ? scrollRootEl : null,
            rootMargin: "720px 0px",
          },
        )
      : null;
  const toolbarResizeObserver =
    typeof ResizeObserver === "function" && toolbarEl instanceof HTMLElement
      ? new ResizeObserver(() => {
          scheduleToolbarCompactMode();
        })
      : null;

  if (Number.isFinite(Number(webviewState.pageSearchPanelWidth))) {
    pageSearchPanelWidth = Number(webviewState.pageSearchPanelWidth);
  }

  if (scrollRootEl instanceof HTMLElement) {
    scrollRootEl.addEventListener("scroll", handleScrollRootScroll, { passive: true });
    scrollRootEl.addEventListener("wheel", handleStickyUserDirectScrollIntent, { passive: true });
    scrollRootEl.addEventListener("touchmove", handleStickyUserDirectScrollIntent, { passive: true });
    scrollRootEl.addEventListener("pointerdown", handleStickyUserPointerScrollIntent, { passive: true });
    scrollRootEl.addEventListener("mousedown", handleStickyUserPointerScrollIntent, { passive: true });
  }
  window.addEventListener("blur", () => {
    persistCurrentChatOpenPosition({ immediate: true });
    persistRestorePosition({ immediate: true });
  });
  window.addEventListener("pagehide", () => {
    showRestoreCover();
    persistCurrentChatOpenPosition({ immediate: true });
    persistRestorePosition({ immediate: true });
  });
  window.addEventListener("pageshow", () => {
    scheduleRestoreCoverRelease();
    if (!isRestoreCoverBlockingTimeGuide()) resumeDeferredRenderWork();
  });
  window.addEventListener("resize", () => {
    scheduleStickyUserOverlayUpdate();
    scheduleRunningTurnFallbackUpdate();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopRunningTurnElapsedTimer();
      showRestoreCover();
      persistCurrentChatOpenPosition({ immediate: true });
      persistRestorePosition({ immediate: true });
    } else if (document.visibilityState === "visible") {
      scheduleRestoreCoverRelease();
      if (!isRestoreCoverBlockingTimeGuide()) resumeDeferredRenderWork();
      syncRunningTurnElapsedTimer();
    }
  });

  // Initial button labels (overwritten after receiving sessionData).
  setToolbarButtonWithIcon(btnResumeInCodex, "Resume in Codex", RESUME_ICON_SVG);
  setToolbarIconButton(btnPinToggle, PIN_ICON_SVG, "Pin");
  setToolbarIconButton(btnCustomTitle, CUSTOM_TITLE_ICON_SVG, "Custom title");
  setToolbarIconButton(btnMarkdown, MARKDOWN_ICON_SVG, "Markdown");
  setToolbarIconButton(btnCopyResume, COPY_ICON_SVG, "Copy prompt");
  // Scroll buttons stay icon-only in the toolbar.
  setToolbarIconButton(btnToggleDetails, DETAILS_OFF_ICON_SVG, "Details");
  setToolbarIconButton(btnPathMode, PATH_RECORDED_ICON_SVG, "Recorded path");
  setToolbarIconButton(btnScrollTop, SCROLL_TOP_ICON_SVG, "Top");
  setToolbarIconButton(btnScrollBottom, SCROLL_BOTTOM_ICON_SVG, "Bottom");
  setToolbarIconButton(btnPageSearch, SEARCH_ICON_SVG, "Find");
  setToolbarIconButton(btnPerformanceMode, PERFORMANCE_NORMAL_ICON_SVG, "Performance");
  setToolbarIconButton(btnAutoRefresh, AUTO_REFRESH_ICON_SVG, "Auto refresh");
  // Reload is icon-only (tooltip is set via i18n).
  setToolbarIconButton(btnReload, RELOAD_ICON_SVG, "Reload");
  setToolbarIconButton(btnPageSearchPrev, NAV_UP_ICON_SVG, "Previous match");
  setToolbarIconButton(btnPageSearchNext, NAV_DOWN_ICON_SVG, "Next match");
  setToolbarIconButton(btnPageSearchClose, CLOSE_ICON_SVG, "Close search");

  btnResumeInCodex.addEventListener("click", () => {
    if (!isArchivedCodexSession()) {
      vscode.postMessage({ type: "resumeInSource" });
      return;
    }
    persistCurrentChatOpenPosition({ immediate: true });
    const revealMessageIndex = chatOpenPosition === "lastMessage" ? findTopVisibleMessageIndex() : null;
    vscode.postMessage({
      type: "restoreArchivedSession",
      revealMessageIndex: typeof revealMessageIndex === "number" ? revealMessageIndex : undefined,
    });
  });
  btnPinToggle.addEventListener("click", () => {
    vscode.postMessage({ type: "togglePin" });
  });
  if (btnCustomTitle instanceof HTMLElement) {
    btnCustomTitle.addEventListener("click", () => {
      vscode.postMessage({ type: "manageCustomTitle" });
    });
  }
  btnPageSearch.addEventListener("click", () => {
    togglePageSearch();
  });
  if (btnPerformanceMode instanceof HTMLElement) {
    btnPerformanceMode.addEventListener("click", () => {
      toggleTemporaryPerformanceMode();
    });
  }

  btnMarkdown.addEventListener("click", () => {
    vscode.postMessage({
      type: "openMarkdown",
      revealMessageIndex: typeof selectedMessageIndex === "number" ? selectedMessageIndex : undefined,
    });
  });
  btnCopyResume.addEventListener("click", () => {
    vscode.postMessage({ type: "copyResumePrompt" });
  });

  btnScrollTop.addEventListener("click", () => {
    scrollToBoundary("top");
  });

  btnScrollBottom.addEventListener("click", () => {
    scrollToBoundary("bottom");
  });

  btnAutoRefresh.addEventListener("click", () => {
    if (!autoRefreshAvailable) return;
    autoRefreshMode = cycleAutoRefreshMode(autoRefreshMode);
    updateToolbar();
    vscode.postMessage({ type: "setAutoRefreshMode", mode: autoRefreshMode });
    persistRestoreState();
    showToast(getAutoRefreshToast(autoRefreshMode), { key: "autoRefresh" });
  });

  btnReload.addEventListener("click", () => {
    requestReload();
  });

  btnToggleDetails.addEventListener("click", () => {
    const nextShowDetails = !showDetails;
    const anchor = captureTimelineScrollAnchor();
    const expectsSessionData = nextShowDetails ? !detailsLoaded : true;
    pendingDetailScrollAnchor = anchor
      ? {
          ...anchor,
          targetShowDetails: nextShowDetails,
        }
      : null;

    withPageSearchContentMutation(() => {
      showDetails = nextShowDetails;
      return true;
    });
    syncPageSearchRoleFilters({ reset: false });
    updateToolbar();
    persistRestoreState();
    if (showDetails) requestFullDetailsIfNeeded({ restoreByCard: true });
    else requestReload({ includeDetails: false, preserveUiState: true, restoreByCard: true });
    render();
    restorePendingDetailScrollAnchorAfterRender({ clear: !expectsSessionData });
  });
  if (btnPathMode instanceof HTMLElement) {
    btnPathMode.addEventListener("click", () => {
      if (!pathModeEnabled) return;
      withPageSearchContentMutation(() => {
        pathMode = getEffectivePathMode() === "relocated" ? "recorded" : "relocated";
        return true;
      });
      updateToolbar();
      render();
      persistRestoreState({ preserveReveal: true });
      vscode.postMessage({ type: "setPathMode", mode: pathMode });
    });
  }
  btnPageSearchPrev.addEventListener("click", () => {
    navigatePageSearchResults(-1);
  });
  btnPageSearchNext.addEventListener("click", () => {
    navigatePageSearchResults(1);
  });
  btnPageSearchClose.addEventListener("click", () => {
    closePageSearch();
  });
  pageSearchInputEl.addEventListener("input", () => {
    pageSearchSuppressedTemporaryAttachmentDetailKeys = new Set();
    if (pageSearchShowingSuggestions) {
      updatePageSearchSuggestionsAfterInput();
    }
    schedulePageSearchRefresh({ reveal: false, keepSuggestions: true });
  });
  pageSearchInputEl.addEventListener("focus", () => {
    if (suppressNextPageSearchFocusSuggestions) {
      suppressNextPageSearchFocusSuggestions = false;
    }
  });
  pageSearchInputEl.addEventListener("click", () => {
    showPageSearchSuggestions();
  });
  pageSearchInputEl.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (pageSearchShowingSuggestions) movePageSearchSuggestion(1);
      else showPageSearchSuggestions();
      return;
    }
    if (pageSearchShowingSuggestions && event.key === "ArrowUp") {
      event.preventDefault();
      movePageSearchSuggestion(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (pageSearchShowingSuggestions && activatePageSearchSuggestion(activePageSearchSuggestionIndex)) return;
      if (!getCurrentPageSearchQuery()) {
        clearPageSearchForEmptyInput();
        return;
      }
      commitCurrentPageSearchQuery();
      if (!flushPageSearchRefresh({ preserveIndex: true, reveal: false })) {
        refreshPageSearchResults({ preserveIndex: true, reveal: false });
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (pageSearchShowingSuggestions) {
        hidePageSearchSuggestions();
        return;
      }
      closePageSearch();
    }
  });
  if (pageSearchResizeHandleEl instanceof HTMLElement) {
    pageSearchResizeHandleEl.addEventListener("pointerdown", (event) => {
      if (!(pageSearchBarEl instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      pageSearchResizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: pageSearchBarEl.getBoundingClientRect().width,
      };
      pageSearchResizeHandleEl.setPointerCapture(event.pointerId);
      document.body.classList.add("pageSearchResizing");
    });
    pageSearchResizeHandleEl.addEventListener("pointermove", (event) => {
      if (!pageSearchResizeState || pageSearchResizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextWidth = normalizePageSearchPanelWidth(pageSearchResizeState.startWidth + (pageSearchResizeState.startX - event.clientX));
      if (nextWidth == null) return;
      pageSearchPanelWidth = nextWidth;
      applyPageSearchPanelWidth();
    });
    const finishResize = (event) => {
      if (!pageSearchResizeState || pageSearchResizeState.pointerId !== event.pointerId) return;
      pageSearchResizeState = null;
      document.body.classList.remove("pageSearchResizing");
      persistPageSearchPanelWidth();
      if (pageSearchResizeHandleEl.hasPointerCapture(event.pointerId)) {
        pageSearchResizeHandleEl.releasePointerCapture(event.pointerId);
      }
    };
    pageSearchResizeHandleEl.addEventListener("pointerup", finishResize);
    pageSearchResizeHandleEl.addEventListener("pointercancel", finishResize);
    pageSearchResizeHandleEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      pageSearchPanelWidth = null;
      applyPageSearchPanelWidth();
      persistPageSearchPanelWidth();
    });
  }

  window.addEventListener("resize", () => {
    applyPageSearchPanelWidth();
    scheduleToolbarCompactMode();
    schedulePatchLayoutSync();
    updateTimeGuide({ afterPaint: true });
    scheduleStickyUserOverlayUpdate({ rebuildRows: true });
  });
  applyPageSearchPanelWidth();
  if (toolbarResizeObserver) toolbarResizeObserver.observe(toolbarEl);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (pageSearchShowingSuggestions && !isPageSearchSuggestionInteractionTarget(target)) {
      hidePageSearchSuggestions();
    }
    const anchor = target.closest("a");
    if (!anchor) return;

    const href = String(anchor.getAttribute("href") || "").trim();
    const localTarget = tryParseLocalFileLink(href);
    if (!localTarget) return;

    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({
      type: "openLocalFile",
      fsPath: localTarget.fsPath,
      line: localTarget.line,
      column: localTarget.column,
    });
  });

  document.addEventListener("keydown", (event) => {
    handleStickyUserKeyScrollIntent(event);
    if (event.key === "Escape" && isImagePreviewOpen()) {
      event.preventDefault();
      closeImagePreview();
      return;
    }
    if (isImagePreviewOpen() && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      navigateImagePreview(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openPageSearch();
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      if (isPageSearchOpen()) navigatePageSearchResults(event.shiftKey ? -1 : 1);
      else openPageSearch();
      return;
    }
    if (event.key === "Escape" && isPageSearchOpen() && !isTextInputElement(document.activeElement)) {
      event.preventDefault();
      closePageSearch();
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "viewState") {
      if (msg.visible === false) showRestoreCover();
      else if (msg.visible === true) {
        scheduleRestoreCoverRelease();
        if (!isRestoreCoverBlockingTimeGuide()) resumeDeferredRenderWork();
      }
      return;
    }
    if (msg.type === "sessionData") {
      cancelRenderAfterCurrent();
      const restoreScrollY = typeof msg.restoreScrollY === "number" ? msg.restoreScrollY : undefined;
      const restoreSelectedMessageIndex =
        typeof msg.restoreSelectedMessageIndex === "number" ? msg.restoreSelectedMessageIndex : undefined;
      const preserveUiState = msg.preserveUiState === true;
      const autoScrollToBottom = msg.autoScrollToBottom === true;
      const savedOpenMessageIndex =
        typeof msg.savedOpenMessageIndex === "number" && Number.isFinite(msg.savedOpenMessageIndex)
          ? Math.max(0, Math.floor(msg.savedOpenMessageIndex))
          : null;
      const revealTarget = normalizeRevealTarget(msg.revealTarget);
      const pageSearchSeed = normalizePageSearchSeed(msg.pageSearchSeed);
      pageSearchHistoryCandidates = normalizeSearchHistoryCandidates(msg.searchHistoryCandidates);
      debugLoggingEnabled = msg.debugLoggingEnabled === true;
      const isRestore = typeof restoreScrollY === "number" || typeof restoreSelectedMessageIndex === "number";
      let shouldPreserveUiState = preserveUiState || isRestore;

      const prevShowDetails = showDetails;
      const prevExpandedNote = expandedNote;
      const prevSelectedMessageIndex = selectedMessageIndex;
      const prevExpandedMessageIndexes = new Set(expandedMessageIndexes);
      const prevExpandedStickyUserKeys = new Set(expandedStickyUserKeys);
      const prevCollapsedTurnIds = new Set(collapsedTurnIds);
      const prevExpandedPatchEntries = new Set(expandedPatchEntries);
      const prevExpandedPatchGroupFileLists = new Set(expandedPatchGroupFileLists);
      const prevAllDiffPatchGroupKeys = new Set(allDiffPatchGroupKeys);
      const prevAllDiffPatchGroupPreviouslyWideKeys = new Set(allDiffPatchGroupPreviouslyWideKeys);
      const prevExpandedAttachmentDetails = new Set(expandedAttachmentDetails);
      const prevExpandedUsageCardKeys = new Set(expandedUsageCardKeys);
      const prevWideTimelineCardKeys = new Set(wideTimelineCardKeys);
      const prevWrappedPatchHunkKeys = new Set(wrappedPatchHunkKeys);
      const previousModelPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
      persistCurrentChatOpenPosition({ immediate: true });

      const incomingModel = msg.model || null;
      const nextModelPath = incomingModel && typeof incomingModel.fsPath === "string" ? incomingModel.fsPath : "";
      const sessionChanged = !!(previousModelPath && nextModelPath && previousModelPath !== nextModelPath);
      if (sessionChanged) {
        resetSessionScopedUiState();
        pendingDetailScrollAnchor = null;
        shouldPreserveUiState = false;
      }
      if (!shouldPreserveUiState) resetStickyUserSuppression();
      const previousPageSearchContentRevision = pageSearchContentRevision;
      model = incomingModel;
      bumpPageSearchContentRevision();
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || {};
      panelKind = normalizePanelKind(msg.panelKind, msg.isPreview);
      chatOpenPosition = normalizeChatOpenPosition(msg.chatOpenPosition);
      autoRefreshAvailable = msg.autoRefreshAvailable === true;
      autoRefreshMode = normalizeAutoRefreshMode(msg.autoRefreshMode);
      pathModeEnabled = msg.pathModeEnabled === true;
      pathMode = pathModeEnabled ? normalizePathMode(msg.pathMode) : "recorded";
      timeGuideEnabled = msg.timeGuideEnabled === true;
      stickyUserPromptEnabled = msg.stickyUserPrompt !== false;
      turnTimelineMode = normalizeTurnTimelineMode(msg.turnTimelineMode);
      syncTurnTimelineModeClass();
      configuredPerformanceMode = normalizePerformanceMode(msg.chatPerformanceMode);
      performanceStats = normalizePerformanceStats(msg.performanceStats);
      toolDisplayMode = msg.toolDisplayMode === "compactCards" ? "compactCards" : "detailsOnly";
      userLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.userLongMessageFolding === "string" ? msg.userLongMessageFolding : msg.longMessageFolding,
      );
      assistantLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.assistantLongMessageFolding === "string"
          ? msg.assistantLongMessageFolding
          : msg.longMessageFolding,
      );
      imageSettings = normalizeImageSettings(msg.imageSettings);
      isPinned = !!msg.isPinned;
      bookmarkedKeys = normalizeBookmarkKeys(msg.bookmarks);
      detailsLoaded = msg.detailsLoaded === true || msg.detailMode === "full";
      detailReloadPending = false;
      updateEffectivePerformanceMode({ showAutoToast: true });
      debugChatOpenPosition("sessionData", {
        session: getDebugSessionName(nextModelPath),
        mode: chatOpenPosition,
        panelKind,
        changed: sessionChanged,
        hostIndex: savedOpenMessageIndex,
        restore: isRestore,
        preserveUiState: shouldPreserveUiState,
        autoScrollToBottom,
        reveal: typeof msg.revealMessageIndex === "number" || !!revealTarget,
      });
      expandedNote = shouldPreserveUiState ? prevExpandedNote : false;
      selectedMessageIndex = shouldPreserveUiState
        ? typeof restoreSelectedMessageIndex === "number"
          ? restoreSelectedMessageIndex
          : prevSelectedMessageIndex
        : typeof msg.revealMessageIndex === "number"
          ? msg.revealMessageIndex
          : revealTarget && typeof revealTarget.messageIndex === "number"
            ? revealTarget.messageIndex
          : null;
      expandedMessageIndexes = shouldPreserveUiState ? prevExpandedMessageIndexes : new Set();
      expandedStickyUserKeys = shouldPreserveUiState ? prevExpandedStickyUserKeys : new Set();
      collapsedTurnIds = shouldPreserveUiState && isTurnTimelineEnabled() ? prevCollapsedTurnIds : new Set();
      clearAllPageSearchTemporaryExpansions();
      pendingPageSearchRefreshOptions = null;
      queuePageSearchContentMutationRefresh(previousPageSearchContentRevision);
      expandedPatchEntries = shouldPreserveUiState ? prevExpandedPatchEntries : new Set();
      expandedPatchGroupFileLists = shouldPreserveUiState ? prevExpandedPatchGroupFileLists : new Set();
      allDiffPatchGroupKeys = shouldPreserveUiState ? prevAllDiffPatchGroupKeys : new Set();
      allDiffPatchGroupPreviouslyWideKeys = shouldPreserveUiState
        ? prevAllDiffPatchGroupPreviouslyWideKeys
        : new Set();
      expandedAttachmentDetails = shouldPreserveUiState ? prevExpandedAttachmentDetails : new Set();
      expandedUsageCardKeys = shouldPreserveUiState ? prevExpandedUsageCardKeys : new Set();
      wideTimelineCardKeys = shouldPreserveUiState ? prevWideTimelineCardKeys : new Set();
      wrappedPatchHunkKeys = shouldPreserveUiState ? prevWrappedPatchHunkKeys : new Set();
      if (!shouldPreserveUiState && typeof msg.revealMessageIndex === "number") {
        expandedMessageIndexes.add(msg.revealMessageIndex);
      }
      if (!shouldPreserveUiState && revealTarget) {
        if (typeof revealTarget.messageIndex === "number") expandedMessageIndexes.add(revealTarget.messageIndex);
        if (typeof revealTarget.entryId === "string" && revealTarget.entryId) {
          expandedPatchEntries.add(revealTarget.entryId);
        }
      }
      if (!isTurnTimelineEnabled()) {
        collapsedTurnIds = new Set();
        clearAllPageSearchTemporaryExpansions();
      }

      // Preserve details visibility only for reload-like updates; fresh opens start with details hidden.
      showDetails = shouldPreserveUiState ? prevShowDetails : false;
      syncPageSearchRoleFilters({ reset: !shouldPreserveUiState });
      updateToolbar();
      render();
      let pendingRestoreCompletions = 0;
      let restoreStatePersisted = false;
      let pageSearchSeedApplied = false;
      const applyPendingPageSearchSeed = () => {
        if (pageSearchSeedApplied || !pageSearchSeed) return;
        pageSearchSeedApplied = true;
        if (pageSearchSeed.autoOpen === false && !isPageSearchOpen()) {
          pendingPageSearchSeed = pageSearchSeed;
          return;
        }
        applyPageSearchSeed(pageSearchSeed);
      };
      const persistAfterRestore = () => {
        if (restoreStatePersisted) return;
        restoreStatePersisted = true;
        persistRestoreState({
          revealTarget,
          revealMessageIndex: typeof selectedMessageIndex === "number" ? selectedMessageIndex : undefined,
        });
        applyPendingPageSearchSeed();
      };
      const createRestoreCompletion = () => {
        pendingRestoreCompletions += 1;
        let active = true;
        return {
          callback: () => {
            if (!active) return;
            active = false;
            pendingRestoreCompletions = Math.max(0, pendingRestoreCompletions - 1);
            if (pendingRestoreCompletions === 0) persistAfterRestore();
          },
          cancel: () => {
            if (!active) return;
            active = false;
            pendingRestoreCompletions = Math.max(0, pendingRestoreCompletions - 1);
          },
        };
      };
      const detailRestoreCompletion = createRestoreCompletion();
      const restoredDetailAnchor = autoScrollToBottom
        ? clearPendingDetailScrollAnchor()
        : restorePendingDetailScrollAnchorAfterRender({ clear: true, onRestored: detailRestoreCompletion.callback });
      if (!restoredDetailAnchor) detailRestoreCompletion.cancel();
      if (isImagePreviewOpen()) syncImagePreviewControls();

      if (shouldPreserveUiState) {
        if (typeof selectedMessageIndex === "number") restoreHighlight(selectedMessageIndex);
        if (autoScrollToBottom) {
          restoreScrollToBottom(createRestoreCompletion().callback);
        } else if (!restoredDetailAnchor) {
          if (typeof restoreScrollY === "number") restoreScroll(restoreScrollY, createRestoreCompletion().callback);
        }
      } else if (revealTarget) {
        revealPatchTarget(revealTarget, createRestoreCompletion().callback);
      } else if (typeof msg.revealMessageIndex === "number") {
        revealMessage(msg.revealMessageIndex, createRestoreCompletion().callback);
      } else if (chatOpenPosition === "top") {
        debugChatOpenPosition("restoreTop", { reason: "mode", session: getDebugSessionName(nextModelPath) });
        restoreScroll(0, createRestoreCompletion().callback);
      } else if (chatOpenPosition === "latest") {
        debugChatOpenPosition("restoreLatest", { reason: "mode", session: getDebugSessionName(nextModelPath) });
        restoreScrollToLatestBoundary(createRestoreCompletion().callback);
      } else {
        const restoredIndex = restoreSavedChatOpenPosition(
          nextModelPath,
          savedOpenMessageIndex,
          createRestoreCompletion().callback,
        );
        if (typeof restoredIndex === "number") {
          selectedMessageIndex = restoredIndex;
        }
      }
      if (pendingRestoreCompletions === 0) persistAfterRestore();
      return;
    }
    if (msg.type === "searchHistoryCandidates") {
      pageSearchHistoryCandidates = normalizeSearchHistoryCandidates(msg.candidates);
      reconcileCommittedPageSearchHistory();
      if (pageSearchShowingSuggestions) updatePageSearchSuggestionsAfterInput();
      return;
    }
    if (msg.type === "i18n") {
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || dateTime || {};
      debugLoggingEnabled = msg.debugLoggingEnabled === true;
      chatOpenPosition = normalizeChatOpenPosition(msg.chatOpenPosition);
      autoRefreshAvailable = msg.autoRefreshAvailable === true;
      timeGuideEnabled = msg.timeGuideEnabled === true;
      stickyUserPromptEnabled = msg.stickyUserPrompt !== false;
      turnTimelineMode = normalizeTurnTimelineMode(msg.turnTimelineMode);
      syncTurnTimelineModeClass();
      configuredPerformanceMode = normalizePerformanceMode(msg.chatPerformanceMode);
      if (!isTurnTimelineEnabled()) clearTurnTimelineInteractiveState();
      updateEffectivePerformanceMode({ showAutoToast: true });
      const previousToolDisplayMode = toolDisplayMode;
      const previousUserLongMessageFolding = userLongMessageFolding;
      const previousAssistantLongMessageFolding = assistantLongMessageFolding;
      if (msg.toolDisplayMode === "compactCards" || msg.toolDisplayMode === "detailsOnly") {
        toolDisplayMode = msg.toolDisplayMode;
      }
      userLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.userLongMessageFolding === "string" ? msg.userLongMessageFolding : msg.longMessageFolding,
      );
      assistantLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.assistantLongMessageFolding === "string"
          ? msg.assistantLongMessageFolding
          : msg.longMessageFolding,
      );
      if (
        previousToolDisplayMode !== toolDisplayMode ||
        previousUserLongMessageFolding !== userLongMessageFolding ||
        previousAssistantLongMessageFolding !== assistantLongMessageFolding
      ) {
        bumpPageSearchContentRevisionAndQueueRefresh();
      }
      imageSettings = normalizeImageSettings(msg.imageSettings);
      updateToolbar();
      render();
      if (isImagePreviewOpen()) syncImagePreviewControls();
      return;
    }
    if (msg.type === "bookmarkState") {
      bookmarkedKeys = normalizeBookmarkKeys(msg.keys);
      applyBookmarkStateToDom();
      updateTimeGuide({ afterPaint: true, rebuildItems: true });
      return;
    }
    if (msg.type === "requestReload") {
      requestReload({ followLatest: msg.mode === "follow" });
      return;
    }
    if (msg.type === "patchEntryDetails") {
      handlePatchEntryDetailsMessage(msg);
      return;
    }
    if (msg.type === "patchEntryDetailsFailed") {
      handlePatchEntryDetailsFailedMessage(msg);
      return;
    }
    if (msg.type === "copied") {
      showToast(i18n.copied || "Copied.", { key: "copied" });
      return;
    }
    if (msg.type === "imageData") {
      handleImageDataMessage(msg);
      return;
    }
    if (msg.type === "imageDataFailed") {
      handleImageDataFailedMessage(msg);
      return;
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest(".bookmarkBtn[data-bookmark-key]");
      if (!(button instanceof HTMLButtonElement)) return;
      const key = button.dataset.bookmarkKey || "";
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      toggleBookmarkKeyLocally(key);
      debugWebview("bookmark", "toggleClick", { key });
      vscode.postMessage({ type: "toggleBookmark", key });
    },
    true,
  );

  vscode.postMessage({
    type: "ready",
    detailMode:
      webviewState && webviewState.restore && webviewState.restore.detailMode === "full" ? "full" : "summary",
  });

  function looksLikeMojibake(text) {
    return (
      typeof text === "string" &&
      /(?:\u7e3a|\u7e67|\u7e5d|\u8373|\u879f|\u9adf|\u8c3a|\u8711|\u96a7|\u90b1|\u8b80|\u87fe|\u86fb|\u9058|\u8c9e|\u9aee)/u.test(
        text,
      )
    );
  }

  function getSafeUiText(value, fallback) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && !looksLikeMojibake(text)) return text;
    return fallback;
  }

  function normalizeTurnTimelineMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "basic" || normalized === "live" ? normalized : "off";
  }

  function isTurnTimelineEnabled() {
    return turnTimelineMode === "basic" || turnTimelineMode === "live";
  }

  function isTurnTimelineLive() {
    return turnTimelineMode === "live";
  }

  function syncTurnTimelineModeClass() {
    if (!(document.body instanceof HTMLElement)) return;
    document.body.classList.toggle("turnTimelineEnabled", isTurnTimelineEnabled());
  }

  function prefersReducedMotion() {
    return !!(
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function clearTurnTimelineInteractiveState() {
    collapsedTurnIds = new Set();
    clearAllPageSearchTemporaryExpansions();
    pendingPageSearchRefreshOptions = null;
    runningTurnActivitySignatures = new Map();
    resetRunningTurnIndicators({ keepFallback: false });
  }

  function isArchivedCodexSession() {
    return !!(
      model &&
      model.meta &&
      model.meta.historySource === "codex" &&
      model.sessionLocation &&
      model.sessionLocation.archiveState === "archived"
    );
  }

  function updateToolbar() {
    const isClaudeSession = !!(model && model.meta && model.meta.historySource === "claude");
    const archivedCodexSession = isArchivedCodexSession();
    const resumeLabel = archivedCodexSession
      ? i18n.restoreArchived || "Move to Codex History"
      : isClaudeSession
      ? i18n.resumeInClaude || "Resume in Claude Code"
      : i18n.resumeInCodex || "Resume in Codex";
    const resumeTooltip = archivedCodexSession
      ? i18n.restoreArchivedTooltip || resumeLabel
      : isClaudeSession
      ? i18n.resumeInClaudeTooltip || resumeLabel
      : i18n.resumeInCodexTooltip || resumeLabel;
    setToolbarButtonWithIcon(btnResumeInCodex, resumeLabel, archivedCodexSession ? CARD_RESTORE_ICON_SVG : RESUME_ICON_SVG);
    btnResumeInCodex.title = resumeTooltip;
    btnResumeInCodex.setAttribute("aria-label", resumeTooltip);

    const pinLabel = isPinned ? i18n.unpin || "Unpin" : i18n.pin || "Pin";
    const pinTooltip = isPinned
      ? i18n.unpinTooltip || pinLabel
      : i18n.pinTooltip || pinLabel;
    setToolbarIconButton(btnPinToggle, PIN_ICON_SVG, pinTooltip);
    btnPinToggle.setAttribute("aria-pressed", isPinned ? "true" : "false");

    if (btnCustomTitle instanceof HTMLElement) {
      const customTitleLabel = getSafeUiText(i18n.customTitle, "Custom title");
      const customTitleTooltip = getSafeUiText(i18n.customTitleTooltip, customTitleLabel);
      setToolbarIconButton(btnCustomTitle, CUSTOM_TITLE_ICON_SVG, customTitleTooltip);
    }

    const pageSearchLabel = getSafeUiText(i18n.pageSearch, "Find");
    const pageSearchTooltip = getSafeUiText(i18n.pageSearchTooltip, "Toggle in-page search");
    setToolbarIconButton(btnPageSearch, SEARCH_ICON_SVG, pageSearchTooltip);
    updatePerformanceToolbarButton();
    if (btnAutoRefresh instanceof HTMLElement) {
      const autoRefreshTooltip = getAutoRefreshTooltip(autoRefreshMode);
      btnAutoRefresh.hidden = !autoRefreshAvailable;
      setToolbarIconButton(btnAutoRefresh, AUTO_REFRESH_ICON_SVG, autoRefreshTooltip);
      btnAutoRefresh.dataset.mode = autoRefreshMode;
      btnAutoRefresh.setAttribute("aria-pressed", autoRefreshMode === "off" ? "false" : "true");
    }

    const markdownLabel = i18n.markdown || "Markdown";
    const markdownTooltip = i18n.markdownTooltip || markdownLabel;
    setToolbarIconButton(btnMarkdown, MARKDOWN_ICON_SVG, markdownTooltip);
    const copyResumeLabel = i18n.copyResume || "Copy prompt";
    // Show a descriptive tooltip so the button intent is clear.
    const copyResumeTooltip = i18n.copyResumeTooltip || copyResumeLabel;
    setToolbarIconButton(btnCopyResume, COPY_ICON_SVG, copyResumeTooltip);
    const scrollTopLabel = i18n.scrollTop || "Top";
    const scrollTopTooltip = i18n.scrollTopTooltip || scrollTopLabel;
    setToolbarIconButton(btnScrollTop, SCROLL_TOP_ICON_SVG, scrollTopTooltip);
    const scrollBottomLabel = i18n.scrollBottom || "Bottom";
    const scrollBottomTooltip = i18n.scrollBottomTooltip || scrollBottomLabel;
    setToolbarIconButton(btnScrollBottom, SCROLL_BOTTOM_ICON_SVG, scrollBottomTooltip);
    const reloadLabel = i18n.reload || "Reload";
    const reloadTooltip = i18n.reloadTooltip || reloadLabel;
    setToolbarIconButton(btnReload, RELOAD_ICON_SVG, reloadTooltip);
    const detailsLabel = showDetails
      ? i18n.detailsOn || "Hide details"
      : i18n.detailsOff || "Show details";
    const detailsTooltip = showDetails
      ? i18n.detailsOnTooltip || detailsLabel
      : i18n.detailsOffTooltip || detailsLabel;
    const detailsIcon = showDetails ? DETAILS_ON_ICON_SVG : DETAILS_OFF_ICON_SVG;
    setToolbarIconButton(btnToggleDetails, detailsIcon, detailsTooltip);
    btnToggleDetails.setAttribute("aria-pressed", showDetails ? "true" : "false");
    updatePathModeToolbarButton();
    if (pageSearchInputEl instanceof HTMLInputElement) {
      const searchPlaceholder = getSafeUiText(i18n.pageSearchPlaceholder, "Find in this view");
      pageSearchInputEl.placeholder = searchPlaceholder;
      pageSearchInputEl.setAttribute("aria-label", searchPlaceholder);
    }
    if (pageSearchTitleEl instanceof HTMLElement) {
      pageSearchTitleEl.textContent = pageSearchLabel;
    }
    renderPageSearchRoleFilters();
    const prevTooltip = getSafeUiText(i18n.pageSearchPrevTooltip, "Previous match");
    const nextTooltip = getSafeUiText(i18n.pageSearchNextTooltip, "Next match");
    const closeTooltip = getSafeUiText(i18n.pageSearchCloseTooltip, "Close search");
    setToolbarIconButton(btnPageSearchPrev, NAV_UP_ICON_SVG, prevTooltip);
    setToolbarIconButton(btnPageSearchNext, NAV_DOWN_ICON_SVG, nextTooltip);
    setToolbarIconButton(btnPageSearchClose, CLOSE_ICON_SVG, closeTooltip);
    updatePageSearchStatus();
    scheduleToolbarCompactMode();
  }

  function setToolbarButtonWithIcon(button, label, iconSvg) {
    if (!(button instanceof HTMLElement)) return;

    const icon = document.createElement("span");
    icon.className = "toolbarBtnIcon";
    icon.innerHTML = iconSvg;

    const text = document.createElement("span");
    text.className = "toolbarBtnLabel";
    text.textContent = label;

    button.replaceChildren(icon, text);
  }

  function setToolbarIconButton(button, iconSvg, tooltip) {
    if (!(button instanceof HTMLElement)) return;
    const safeTooltip = typeof tooltip === "string" && tooltip.trim() ? tooltip.trim() : "";
    button.innerHTML = iconSvg;
    if (safeTooltip) {
      button.title = safeTooltip;
      button.setAttribute("aria-label", safeTooltip);
    }
  }

  function updatePerformanceToolbarButton() {
    if (!(btnPerformanceMode instanceof HTMLElement)) return;
    const simplified = effectivePerformanceMode === "simplified";
    const tooltip = getPerformanceTooltip();
    setToolbarIconButton(btnPerformanceMode, simplified ? PERFORMANCE_SIMPLIFIED_ICON_SVG : PERFORMANCE_NORMAL_ICON_SVG, tooltip);
    btnPerformanceMode.dataset.mode = effectivePerformanceMode;
    btnPerformanceMode.dataset.configuredMode = configuredPerformanceMode;
    btnPerformanceMode.setAttribute("aria-pressed", simplified ? "true" : "false");
  }

  function updatePathModeToolbarButton() {
    if (!(btnPathMode instanceof HTMLButtonElement)) return;
    const effectiveMode = getEffectivePathMode();
    const relocated = effectiveMode === "relocated";
    const tooltip = pathModeEnabled
      ? relocated
        ? getSafeUiText(i18n.pathModeRelocatedTooltip, "Associated history: using target path. Click to use recorded path.")
        : getSafeUiText(i18n.pathModeRecordedTooltip, "Associated history: using recorded path. Click to use target path.")
      : getSafeUiText(i18n.pathModeDisabledTooltip, "This is not relocated history, so the recorded path is used.");
    setToolbarIconButton(btnPathMode, relocated ? PATH_RELOCATED_ICON_SVG : PATH_RECORDED_ICON_SVG, tooltip);
    btnPathMode.disabled = !pathModeEnabled;
    btnPathMode.dataset.mode = effectiveMode;
    btnPathMode.setAttribute("aria-pressed", relocated ? "true" : "false");
  }

  function toggleTemporaryPerformanceMode() {
    temporaryPerformanceMode = getNextTemporaryPerformanceMode();
    updateEffectivePerformanceMode();
    updateToolbar();
    if (effectivePerformanceMode === "normal") restoreHibernatedPatchBodies({ force: true });
    showToast(getPerformanceSwitchToast(), { durationMs: 2400, key: "performanceMode" });
  }

  function updateEffectivePerformanceMode(options = {}) {
    const previousMode = effectivePerformanceMode;
    const nextMode = resolveEffectivePerformanceMode();
    effectivePerformanceMode = nextMode;
    document.body.classList.toggle("performanceSimplified", nextMode === "simplified");

    if (
      options.showAutoToast === true &&
      getSelectedPerformanceMode() === "auto" &&
      nextMode === "simplified" &&
      !autoPerformanceToastShown
    ) {
      autoPerformanceToastShown = true;
      showToast(getSafeUiText(i18n.performanceLargeHistoryToast, "Using simplified view for this large history."), {
        durationMs: 3600,
        key: "performanceMode",
      });
    }

    if (previousMode === "simplified" && nextMode === "normal") restoreHibernatedPatchBodies({ force: true });
    debugPerformanceModeIfChanged(previousMode, nextMode);
  }

  function getNextTemporaryPerformanceMode() {
    const currentMode = getSelectedPerformanceMode();
    if (currentMode === "auto") return "normal";
    if (currentMode === "normal") return "simplified";
    return "auto";
  }

  function getPerformanceSwitchToast() {
    if (temporaryPerformanceMode === "auto") {
      return getSafeUiText(i18n.performanceSwitchedAuto, "Set this view's performance mode to Auto.");
    }
    return temporaryPerformanceMode === "simplified"
      ? getSafeUiText(i18n.performanceSwitchedSimplified, "Set this view's performance mode to Simplified.")
      : getSafeUiText(i18n.performanceSwitchedNormal, "Set this view's performance mode to Normal.");
  }

  function resolveEffectivePerformanceMode() {
    if (temporaryPerformanceMode === "normal" || temporaryPerformanceMode === "simplified") return temporaryPerformanceMode;
    if (temporaryPerformanceMode === "auto") return shouldAutoUseSimplifiedPerformance() ? "simplified" : "normal";
    if (configuredPerformanceMode === "normal" || configuredPerformanceMode === "simplified") return configuredPerformanceMode;
    return shouldAutoUseSimplifiedPerformance() ? "simplified" : "normal";
  }

  function getPerformanceTooltip() {
    if (temporaryPerformanceMode === "normal") return getSafeUiText(i18n.performanceNormal, "Performance: Normal");
    if (temporaryPerformanceMode === "simplified") return getSafeUiText(i18n.performanceSimplified, "Performance: Simplified");
    if (temporaryPerformanceMode === "auto") {
      return effectivePerformanceMode === "simplified"
        ? getSafeUiText(i18n.performanceAutoSimplified, "Performance: Auto (Simplified)")
        : getSafeUiText(i18n.performanceAutoNormal, "Performance: Auto (Normal)");
    }
    if (configuredPerformanceMode === "normal") return getSafeUiText(i18n.performanceNormal, "Performance: Normal");
    if (configuredPerformanceMode === "simplified") return getSafeUiText(i18n.performanceSimplified, "Performance: Simplified");
    return effectivePerformanceMode === "simplified"
      ? getSafeUiText(i18n.performanceAutoSimplified, "Performance: Auto (Simplified)")
      : getSafeUiText(i18n.performanceAutoNormal, "Performance: Auto (Normal)");
  }

  function getSelectedPerformanceMode() {
    return temporaryPerformanceMode === "auto" || temporaryPerformanceMode === "normal" || temporaryPerformanceMode === "simplified"
      ? temporaryPerformanceMode
      : configuredPerformanceMode;
  }

  function shouldAutoUseSimplifiedPerformance() {
    return (
      readPerformanceNumber("fileSizeBytes") >= SIMPLIFIED_FILE_SIZE_BYTES ||
      readPerformanceNumber("itemCount") >= SIMPLIFIED_ITEM_COUNT ||
      readPerformanceNumber("diffEntryCount") >= SIMPLIFIED_DIFF_ENTRY_COUNT ||
      readPerformanceNumber("diffLineEstimate") >= SIMPLIFIED_DIFF_LINE_ESTIMATE ||
      readPerformanceNumber("imageCount") >= SIMPLIFIED_IMAGE_COUNT
    );
  }

  function debugPerformanceModeIfChanged(previousMode, nextMode) {
    if (!debugLoggingEnabled) return;
    const reason = getPerformanceSimplifiedReason();
    const signature = [
      configuredPerformanceMode,
      temporaryPerformanceMode || "",
      nextMode,
      reason,
      readPerformanceNumber("fileSizeBytes"),
      readPerformanceNumber("itemCount"),
      readPerformanceNumber("diffEntryCount"),
      readPerformanceNumber("diffLineEstimate"),
      readPerformanceNumber("imageCount"),
    ].join("|");
    if (signature === lastPerformanceDebugSignature) return;
    lastPerformanceDebugSignature = signature;
    debugWebview("chatPerformance", "effective", {
      configured: configuredPerformanceMode,
      temporary: temporaryPerformanceMode || "none",
      previous: previousMode,
      effective: nextMode,
      reason,
      fileSizeBytes: readPerformanceNumber("fileSizeBytes"),
      items: readPerformanceNumber("itemCount"),
      patchEntries: readPerformanceNumber("diffEntryCount"),
      diffLineEstimate: readPerformanceNumber("diffLineEstimate"),
      images: readPerformanceNumber("imageCount"),
    });
  }

  function getPerformanceSimplifiedReason() {
    if (effectivePerformanceMode !== "simplified") return "none";
    if (getSelectedPerformanceMode() === "simplified") return "manual";
    if (readPerformanceNumber("fileSizeBytes") >= SIMPLIFIED_FILE_SIZE_BYTES) return "fileSizeBytes";
    if (readPerformanceNumber("itemCount") >= SIMPLIFIED_ITEM_COUNT) return "itemCount";
    if (readPerformanceNumber("diffEntryCount") >= SIMPLIFIED_DIFF_ENTRY_COUNT) return "diffEntryCount";
    if (readPerformanceNumber("diffLineEstimate") >= SIMPLIFIED_DIFF_LINE_ESTIMATE) return "diffLineEstimate";
    if (readPerformanceNumber("imageCount") >= SIMPLIFIED_IMAGE_COUNT) return "imageCount";
    return "none";
  }

  function readPerformanceNumber(key) {
    const value = performanceStats && typeof performanceStats === "object" ? Number(performanceStats[key]) : 0;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  function normalizePerformanceMode(value) {
    return value === "normal" || value === "simplified" ? value : "auto";
  }

  function normalizePerformanceStats(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      fileSizeBytes: normalizePerformanceStatNumber(source.fileSizeBytes),
      itemCount: normalizePerformanceStatNumber(source.itemCount),
      messageChars: normalizePerformanceStatNumber(source.messageChars),
      diffGroupCount: normalizePerformanceStatNumber(source.diffGroupCount),
      diffEntryCount: normalizePerformanceStatNumber(source.diffEntryCount),
      diffLineEstimate: normalizePerformanceStatNumber(source.diffLineEstimate),
      imageCount: normalizePerformanceStatNumber(source.imageCount),
    };
  }

  function normalizePerformanceStatNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
  }

  function isSimplifiedPerformanceMode() {
    return effectivePerformanceMode === "simplified";
  }

  function scrollToBoundary(direction) {
    if (direction === "bottom") {
      const target = getTimelineBoundaryCard("bottom");
      if (target) {
        scrollElementIntoRootView(target, { behavior: "smooth", block: "end", endInset: getTimelineEndScrollInset(target) });
        return;
      }
      const scrollingEl = getScrollRoot();
      scrollingEl.scrollTo({ top: scrollingEl.scrollHeight, behavior: "smooth" });
      return;
    }

    const target = getTimelineBoundaryCard(direction);
    if (target) {
      scrollElementIntoRootView(target, {
        behavior: "smooth",
        block: "start",
        startInset: direction === "top" ? getTimelineStartScrollInset(target) : 0,
      });
      return;
    }

    const scrollingEl = getScrollRoot();
    const top = direction === "bottom" ? scrollingEl.scrollHeight : 0;
    scrollingEl.scrollTo({ top, behavior: "smooth" });
  }

  function requestReload(options = {}) {
    const followLatest = options.followLatest === true;
    const restoreByCard = options.restoreByCard === true;
    const includeDetails =
      options.includeDetails === true
        ? true
        : options.includeDetails === false
          ? false
          : shouldRequestFullDetailsOnReload();
    const message = {
      type: "reload",
      preserveUiState: true,
      autoScrollToBottom: followLatest,
      includeDetails,
    };
    detailReloadPending = includeDetails && !detailsLoaded;
    if (!followLatest && !restoreByCard) {
      message.scrollY = getScrollTop();
    }
    if (!followLatest) {
      if (typeof selectedMessageIndex === "number") {
        message.selectedMessageIndex = selectedMessageIndex;
      }
    }
    vscode.postMessage(message);
  }

  function shouldRequestFullDetailsOnReload() {
    return showDetails;
  }

  function requestFullDetailsIfNeeded(options = {}) {
    if (detailsLoaded || detailReloadPending) return;
    requestReload({
      includeDetails: true,
      preserveUiState: true,
      restoreByCard: options.restoreByCard === true,
    });
  }

  function getScrollRoot() {
    return scrollRootEl instanceof HTMLElement
      ? scrollRootEl
      : document.scrollingElement || document.documentElement;
  }

  function getScrollTop() {
    return Math.max(0, Math.floor(Number(getScrollRoot().scrollTop) || 0));
  }

  function handleScrollRootScroll() {
    releaseStickyUserSuppressionForPointerScroll();
    schedulePersistChatOpenPosition();
    schedulePersistRestorePosition();
    if (isSimplifiedPerformanceMode()) restoreHibernatedPatchBodies();
    if (timeGuideEnabled && timeGuide) timeGuide.handleScroll();
    scheduleStickyUserOverlayUpdate();
    scheduleRunningTurnFallbackUpdate();
  }

  function isEventInsideScrollRoot(event) {
    const root = getScrollRoot();
    const target = event && event.target instanceof Node ? event.target : null;
    return !!(root instanceof HTMLElement && target && root.contains(target));
  }

  function suppressStickyUserUntilUserScroll() {
    stickyUserSuppressedUntilUserScroll = true;
    stickyUserPointerScrollIntent = false;
    expandedStickyUserKeys = new Set();
    hideStickyUserOverlay();
  }

  function resetStickyUserSuppression() {
    stickyUserSuppressedUntilUserScroll = false;
    stickyUserPointerScrollIntent = false;
  }

  function releaseStickyUserSuppressionForUserScroll() {
    stickyUserPointerScrollIntent = false;
    if (!stickyUserSuppressedUntilUserScroll) return;
    stickyUserSuppressedUntilUserScroll = false;
    scheduleStickyUserOverlayUpdate();
  }

  function releaseStickyUserSuppressionForPointerScroll() {
    if (!stickyUserPointerScrollIntent) return;
    releaseStickyUserSuppressionForUserScroll();
  }

  function handleStickyUserDirectScrollIntent(event) {
    if (!stickyUserSuppressedUntilUserScroll || !isEventInsideScrollRoot(event)) return;
    releaseStickyUserSuppressionForUserScroll();
  }

  function handleStickyUserPointerScrollIntent(event) {
    if (!stickyUserSuppressedUntilUserScroll || !isEventInsideScrollRoot(event)) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    stickyUserPointerScrollIntent = true;
  }

  function handleStickyUserKeyScrollIntent(event) {
    if (!stickyUserSuppressedUntilUserScroll || !event || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTextInputElement(document.activeElement)) return;
    const key = typeof event.key === "string" ? event.key : "";
    if (!STICKY_USER_SCROLL_KEYS.has(key)) return;
    releaseStickyUserSuppressionForUserScroll();
  }

  function schedulePersistRestorePosition() {
    if (restorePositionSaveTimer) window.clearTimeout(restorePositionSaveTimer);
    restorePositionSaveTimer = window.setTimeout(() => {
      restorePositionSaveTimer = 0;
      persistRestoreState({ preserveReveal: true });
    }, RESTORE_POSITION_SAVE_DEBOUNCE_MS);
  }

  function persistRestorePosition(options = {}) {
    if (restorePositionSaveTimer && options.immediate) {
      window.clearTimeout(restorePositionSaveTimer);
      restorePositionSaveTimer = 0;
    }
    persistRestoreState({ preserveReveal: true });
  }

  function schedulePersistChatOpenPosition() {
    if (openPositionSaveTimer) window.clearTimeout(openPositionSaveTimer);
    openPositionSaveTimer = window.setTimeout(() => {
      openPositionSaveTimer = 0;
      persistCurrentChatOpenPosition();
    }, OPEN_POSITION_SAVE_DEBOUNCE_MS);
  }

  function persistCurrentChatOpenPosition(options = {}) {
    if (openPositionSaveTimer && options.immediate) {
      window.clearTimeout(openPositionSaveTimer);
      openPositionSaveTimer = 0;
    }
    if (!model || typeof model.fsPath !== "string" || !model.fsPath) {
      debugChatOpenPosition("rememberSkip", { reason: "noModel" });
      return;
    }
    const messageIndex = findTopVisibleMessageIndex();
    if (typeof messageIndex !== "number") {
      debugChatOpenPosition("rememberSkip", {
        reason: "noVisibleMessage",
        session: getDebugSessionName(model.fsPath),
        scrollTop: getScrollTop(),
      });
      return;
    }

    const updatedAt = Date.now();
    const positions =
      webviewState && webviewState.chatOpenPositions && typeof webviewState.chatOpenPositions === "object"
        ? { ...webviewState.chatOpenPositions }
        : {};
    positions[model.fsPath] = { messageIndex, updatedAt };
    trimChatOpenPositions(positions);
    webviewState = {
      ...(webviewState && typeof webviewState === "object" ? webviewState : {}),
      chatOpenPositions: positions,
    };
    if (typeof vscode.setState === "function") vscode.setState(webviewState);
    vscode.postMessage({ type: "rememberOpenPosition", fsPath: model.fsPath, messageIndex });
    debugChatOpenPosition("remember", {
      session: getDebugSessionName(model.fsPath),
      index: messageIndex,
      scrollTop: getScrollTop(),
      immediate: options.immediate === true,
    });
  }

  function findTopVisibleMessageIndex() {
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const viewportTop = rootRect.top + 8;
    const viewportBottom = rootRect.bottom;
    let bestIndex = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let previousIndex = null;
    let previousBottom = Number.NEGATIVE_INFINITY;

    for (const node of document.querySelectorAll("[id^='msg-']")) {
      if (!(node instanceof HTMLElement)) continue;
      const index = readMessageAnchorIndex(node);
      if (typeof index !== "number") continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < viewportTop) {
        if (rect.bottom > previousBottom) {
          previousBottom = rect.bottom;
          previousIndex = index;
        }
        continue;
      }
      if (rect.top > viewportBottom) continue;
      const distance = Math.abs(rect.top - viewportTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    const resolvedIndex = Number.isFinite(bestIndex) ? bestIndex : previousIndex;
    if (!Number.isFinite(resolvedIndex)) return 0;
    return isFirstRenderedMessageIndex(resolvedIndex) ? 0 : resolvedIndex;
  }

  function captureTimelineScrollAnchor() {
    const targets = getRenderedTimelineVisualTargets();
    if (targets.length === 0) return null;

    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const viewportTop = rootRect.top + 8;
    const viewportBottom = rootRect.bottom;
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
      const score = rect.top <= viewportTop && rect.bottom >= viewportTop ? 0 : Math.abs(rect.top - viewportTop) + 1;
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }

    if (!best) best = targets[0];
    const anchor = buildTimelineScrollAnchorFromVisualTarget(best);
    if (anchor) return anchor;
    for (const target of targets) {
      const fallbackAnchor = buildTimelineScrollAnchorFromVisualTarget(target);
      if (fallbackAnchor) return fallbackAnchor;
    }
    return null;
  }

  function capturePageSearchCloseScrollAnchor() {
    if (timelineEl instanceof HTMLElement) {
      const activeMatch = timelineEl.querySelector("mark.pageSearchMatch-active");
      if (activeMatch instanceof HTMLElement && isElementVisibleInScrollViewport(activeMatch)) {
        const activeAnchor = captureTimelineScrollAnchorFromElement(activeMatch);
        if (activeAnchor) return activeAnchor;
      }
    }
    return captureTimelineScrollAnchor();
  }

  function captureTimelineScrollAnchorFromElement(element) {
    if (!(element instanceof HTMLElement)) return null;
    const target = element.closest(
      ".row[data-item-index], .turnMarker[data-turn-boundary], .runningTurnAnchorRow[data-running-turn-anchor='true']",
    );
    return target instanceof HTMLElement ? buildTimelineScrollAnchorFromVisualTarget(target, element) : null;
  }

  function buildTimelineScrollAnchorFromVisualTarget(target, offsetSource) {
    if (!(target instanceof HTMLElement)) return null;
    if (target.matches(".row[data-item-index]")) return buildTimelineScrollAnchorFromRow(target, offsetSource);
    if (target.classList.contains("turnMarker") && target.dataset.turnBoundary) {
      return buildTimelineScrollAnchorFromMarker(target, "turnMarker", offsetSource);
    }
    if (target.classList.contains("runningTurnAnchorRow") && target.dataset.runningTurnAnchor === "true") {
      return buildTimelineScrollAnchorFromMarker(target, "runningTurnAnchor", offsetSource);
    }
    return null;
  }

  function buildTimelineScrollAnchorFromRow(row, offsetSource) {
    if (!(row instanceof HTMLElement)) return null;
    const itemIndex = Number(row.dataset.itemIndex);
    const anchor = {
      fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
      anchorKind: "row",
      cardKey: typeof row.dataset.cardKey === "string" ? row.dataset.cardKey : "",
      itemIndex: Number.isFinite(itemIndex) ? Math.max(0, Math.floor(itemIndex)) : 0,
      turnId: typeof row.dataset.turnId === "string" ? normalizeTurnId(row.dataset.turnId) : "",
    };
    captureTimelineScrollAnchorOffsets(anchor, row, offsetSource);
    return anchor;
  }

  function buildTimelineScrollAnchorFromMarker(marker, anchorKind, offsetSource) {
    if (!(marker instanceof HTMLElement)) return null;
    const turnId = normalizeTurnId(marker.dataset.turnId);
    if (!turnId) return null;
    const safeKind = anchorKind === "runningTurnAnchor" ? "runningTurnAnchor" : "turnMarker";
    const anchor = {
      fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
      anchorKind: safeKind,
      turnId,
    };
    if (safeKind === "turnMarker") {
      const turnBoundary = normalizeTimelineTurnBoundary(marker.dataset.turnBoundary);
      if (turnBoundary) anchor.turnBoundary = turnBoundary;
    }
    const runKey = normalizeTurnRunKey(marker.dataset.turnRunKey);
    if (runKey) anchor.runKey = runKey;
    captureTimelineScrollAnchorOffsets(anchor, marker, offsetSource);
    return anchor;
  }

  function captureTimelineScrollAnchorOffsets(anchor, target, offsetSource) {
    if (!anchor || !(target instanceof HTMLElement)) return;
    const root = getScrollRoot();
    if (root instanceof HTMLElement) {
      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetOffsetTop = targetRect.top - rootRect.top;
      if (Number.isFinite(targetOffsetTop)) {
        anchor.targetOffsetTop = targetOffsetTop;
        if (anchor.anchorKind === "row") anchor.rowOffsetTop = targetOffsetTop;
        else anchor.sourceOffsetTop = targetOffsetTop;
      }
      if (offsetSource instanceof HTMLElement) {
        const sourceRect = offsetSource.getBoundingClientRect();
        const sourceOffsetTop = sourceRect.top - rootRect.top;
        if (Number.isFinite(sourceOffsetTop)) anchor.sourceOffsetTop = sourceOffsetTop;
        const sourceWithinRowTop = sourceRect.top - targetRect.top;
        if (Number.isFinite(sourceWithinRowTop)) anchor.sourceWithinRowTop = sourceWithinRowTop;
      }
    }
  }

  function getRenderedTimelineRows() {
    if (!(timelineEl instanceof HTMLElement)) return [];
    return Array.from(timelineEl.querySelectorAll(".row[data-item-index]")).filter(isRenderedTimelineVisualTarget);
  }

  function getRenderedTimelineVisualTargets() {
    if (!(timelineEl instanceof HTMLElement)) return [];
    return Array.from(
      timelineEl.querySelectorAll(
        ".row[data-item-index], .turnMarker[data-turn-boundary], .runningTurnAnchorRow[data-running-turn-anchor='true']",
      ),
    ).filter(isRenderedTimelineVisualTarget);
  }

  function restorePendingDetailScrollAnchorAfterRender(options = {}) {
    const anchor = pendingDetailScrollAnchor;
    if (!anchor) return false;
    restoreTimelineScrollAnchorAfterLayout(anchor, options.onRestored);
    if (options.clear === true) pendingDetailScrollAnchor = null;
    return true;
  }

  function clearPendingDetailScrollAnchor() {
    pendingDetailScrollAnchor = null;
    return false;
  }

  function restoreTimelineScrollAnchorAfterLayout(anchor, onRestored) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreTimelineScrollAnchor(anchor, onRestored);
      });
    });
  }

  function restoreTimelineScrollAnchor(anchor, onRestored) {
    const finish = () => {
      if (typeof onRestored === "function") onRestored();
    };
    if (!anchor || typeof anchor !== "object") {
      finish();
      return false;
    }
    const currentPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
    if (anchor.fsPath && currentPath && anchor.fsPath !== currentPath) {
      finish();
      return false;
    }

    if (isTimelineMarkerScrollAnchor(anchor)) {
      const markerTarget = findTimelineMarkerForAnchor(anchor);
      if (markerTarget) {
        scrollElementToCapturedOffset(markerTarget, getTimelineCapturedTargetOffset(anchor));
        finish();
        return true;
      }

      const markerFallback = findTimelineRowFallbackForMarkerAnchor(anchor);
      if (markerFallback) {
        restoreTimelineElementToOffset(markerFallback, getTimelineCapturedTargetOffset(anchor));
        finish();
        return true;
      }

      finish();
      return false;
    } else {
      const anchorTurnId = resolveTurnIdForAnchor(anchor);
      if (ensureTurnExpandedForReveal(anchorTurnId, { render: true })) {
        restoreTimelineScrollAnchorAfterLayout(anchor, onRestored);
        return true;
      }
    }

    const target = findTimelineRowForAnchor(anchor);
    if (target) {
      restoreTimelineElementToOffset(target, getTimelineCapturedTargetOffset(anchor));
      finish();
      return true;
    }

    restoreScroll(0, finish);
    return false;
  }

  function restorePageSearchCloseScrollAnchorAfterLayout(anchor) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restorePageSearchCloseScrollAnchor(anchor);
      });
    });
  }

  function restorePageSearchCloseScrollAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return false;
    const currentPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
    if (anchor.fsPath && currentPath && anchor.fsPath !== currentPath) return false;

    const resolved = findPageSearchCloseScrollTarget(anchor);
    if (!resolved || !(resolved.target instanceof HTMLElement)) return false;
    return restoreTimelineElementToOffset(resolved.target, resolved.offsetTop);
  }

  function findPageSearchCloseScrollTarget(anchor) {
    if (isTimelineMarkerScrollAnchor(anchor)) {
      const markerTarget = findTimelineMarkerForAnchor(anchor);
      if (markerTarget) {
        return { target: markerTarget, offsetTop: getTimelineCapturedTargetOffset(anchor) };
      }

      const markerFallback = findTimelineRowFallbackForMarkerAnchor(anchor);
      if (markerFallback) {
        return { target: markerFallback, offsetTop: getTimelineCapturedTargetOffset(anchor) };
      }

      return null;
    }

    const cardKey = typeof anchor.cardKey === "string" ? anchor.cardKey : "";
    if (cardKey) {
      const exact = getRenderedTimelineRows().find((row) => row.dataset.cardKey === cardKey);
      if (exact) {
        return { target: exact, offsetTop: getPageSearchExactRowRestoreOffset(anchor, exact) };
      }
    }

    const turnId = normalizeTurnId(anchor.turnId || resolveTurnIdForAnchor(anchor));
    if (turnId && timelineEl instanceof HTMLElement) {
      const runKey = normalizeTurnRunKey(anchor.runKey);
      const runSelector = runKey ? `[data-turn-run-key="${cssEscape(runKey)}"]` : "";
      let collapsedMarker = timelineEl.querySelector(
        `.turnCollapsedSummaryMarker[data-turn-id="${cssEscape(turnId)}"]${runSelector}`,
      );
      if (!(collapsedMarker instanceof HTMLElement) && runKey) {
        collapsedMarker = timelineEl.querySelector(`.turnCollapsedSummaryMarker[data-turn-id="${cssEscape(turnId)}"]`);
      }
      if (collapsedMarker instanceof HTMLElement) {
        const sourceOffsetTop = Number(anchor.sourceOffsetTop);
        return {
          target: collapsedMarker,
          offsetTop: Number.isFinite(sourceOffsetTop) ? sourceOffsetTop : getTimelineCapturedTargetOffset(anchor),
        };
      }
    }

    const fallback = findTimelineRowForAnchor(anchor);
    return fallback ? { target: fallback, offsetTop: anchor.rowOffsetTop } : null;
  }

  function getPageSearchExactRowRestoreOffset(anchor, row) {
    const rowOffsetTop = Number(anchor && anchor.rowOffsetTop);
    const sourceOffsetTop = Number(anchor && anchor.sourceOffsetTop);
    const sourceWithinRowTop = Number(anchor && anchor.sourceWithinRowTop);
    if (
      row instanceof HTMLElement &&
      Number.isFinite(sourceOffsetTop) &&
      Number.isFinite(sourceWithinRowTop) &&
      sourceWithinRowTop > row.getBoundingClientRect().height
    ) {
      return sourceOffsetTop;
    }
    return Number.isFinite(rowOffsetTop) ? rowOffsetTop : sourceOffsetTop;
  }

  function scrollElementToCapturedOffset(element, offsetTop) {
    if (!(element instanceof HTMLElement)) return false;
    const root = getScrollRoot();
    if (!(root instanceof HTMLElement)) {
      element.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
      return true;
    }

    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const desiredOffset = Number(offsetTop);
    if (!Number.isFinite(desiredOffset)) {
      scrollElementIntoRootView(element, { behavior: "auto", block: "start" });
      return true;
    }
    const nextTop = root.scrollTop + elementRect.top - rootRect.top - desiredOffset;
    root.scrollTo({ top: Math.max(0, Math.floor(nextTop)), behavior: "auto" });
    return true;
  }

  function restoreTimelineElementToOffset(element, offsetTop) {
    if (!(element instanceof HTMLElement)) return false;
    if (isUserTimelineElement(element)) suppressStickyUserUntilUserScroll();
    return scrollElementToCapturedOffset(element, offsetTop);
  }

  function getTimelineCapturedTargetOffset(anchor) {
    if (!anchor || typeof anchor !== "object") return undefined;
    const targetOffsetTop = Number(anchor.targetOffsetTop);
    if (Number.isFinite(targetOffsetTop)) return targetOffsetTop;
    const rowOffsetTop = Number(anchor.rowOffsetTop);
    if (Number.isFinite(rowOffsetTop)) return rowOffsetTop;
    const sourceOffsetTop = Number(anchor.sourceOffsetTop);
    return Number.isFinite(sourceOffsetTop) ? sourceOffsetTop : undefined;
  }

  function normalizeTimelineScrollAnchorKind(value) {
    if (value === "turnMarker" || value === "runningTurnAnchor" || value === "row") return value;
    return "";
  }

  function normalizeTimelineTurnBoundary(value) {
    return value === "start" || value === "end" ? value : "";
  }

  function isTimelineMarkerScrollAnchor(anchor) {
    const kind = normalizeTimelineScrollAnchorKind(anchor && anchor.anchorKind);
    return kind === "turnMarker" || kind === "runningTurnAnchor";
  }

  function isRenderedTimelineVisualTarget(element) {
    return element instanceof HTMLElement && element.offsetParent !== null;
  }

  function findTimelineMarkerForAnchor(anchor) {
    if (!isTimelineMarkerScrollAnchor(anchor) || !(timelineEl instanceof HTMLElement)) return null;
    const turnId = normalizeTurnId(anchor && anchor.turnId);
    if (!turnId) return null;
    const kind = normalizeTimelineScrollAnchorKind(anchor.anchorKind);
    const runKey = normalizeTurnRunKey(anchor.runKey);
    const runSelector = runKey ? `[data-turn-run-key="${cssEscape(runKey)}"]` : "";
    if (kind === "runningTurnAnchor") {
      const runningAnchor = timelineEl.querySelector(
        `.runningTurnAnchorRow[data-running-turn-anchor="true"][data-turn-id="${cssEscape(turnId)}"]${runSelector}`,
      );
      return isRenderedTimelineVisualTarget(runningAnchor) ? runningAnchor : null;
    }

    const boundary = normalizeTimelineTurnBoundary(anchor.turnBoundary);
    if (boundary) {
      if (runKey) {
        const exactRunMarker = timelineEl.querySelector(
          `.turnMarker[data-turn-id="${cssEscape(turnId)}"][data-turn-boundary="${cssEscape(boundary)}"]${runSelector}`,
        );
        if (isRenderedTimelineVisualTarget(exactRunMarker)) return exactRunMarker;
      }
      const exactBoundaryMarker = timelineEl.querySelector(
        `.turnMarker[data-turn-id="${cssEscape(turnId)}"][data-turn-boundary="${cssEscape(boundary)}"]`,
      );
      if (isRenderedTimelineVisualTarget(exactBoundaryMarker)) return exactBoundaryMarker;
    }

    const marker = timelineEl.querySelector(`.turnMarker[data-turn-id="${cssEscape(turnId)}"]`);
    return isRenderedTimelineVisualTarget(marker) ? marker : null;
  }

  function findTimelineRowFallbackForMarkerAnchor(anchor) {
    const turnId = normalizeTurnId(anchor && anchor.turnId);
    if (!turnId) return null;
    const turnRows = getRenderedTimelineRows().filter((row) => row instanceof HTMLElement && row.dataset.turnId === turnId);
    if (turnRows.length === 0) return null;
    return getLatestMeaningfulTimelineCard(turnRows) || turnRows[0];
  }

  function findTimelineRowForAnchor(anchor) {
    const rows = getRenderedTimelineRows();
    if (rows.length === 0) return null;

    const cardKey = typeof anchor.cardKey === "string" ? anchor.cardKey : "";
    if (cardKey) {
      const exact = rows.find((row) => row.dataset.cardKey === cardKey);
      if (exact) return exact;
    }

    const itemIndex = Number(anchor.itemIndex);
    const safeItemIndex = Number.isFinite(itemIndex) ? Math.max(0, Math.floor(itemIndex)) : 0;
    const indexedRows = rows
      .map((row) => ({ row, itemIndex: Number(row.dataset.itemIndex) }))
      .filter((entry) => Number.isFinite(entry.itemIndex))
      .sort((a, b) => a.itemIndex - b.itemIndex);
    return (
      indexedRows.find((entry) => entry.itemIndex > safeItemIndex)?.row ??
      [...indexedRows].reverse().find((entry) => entry.itemIndex < safeItemIndex)?.row ??
      rows[0]
    );
  }

  function getFirstRenderedMessageIndex() {
    if (!model || !Array.isArray(model.items)) return null;
    for (const item of model.items) {
      if (!canRenderMessage(item)) continue;
      if (typeof item.messageIndex !== "number" || !Number.isFinite(item.messageIndex)) continue;
      return Math.max(0, Math.floor(item.messageIndex));
    }
    return null;
  }

  function readMessageAnchorIndex(node) {
    if (!(node instanceof HTMLElement)) return null;
    const match = /^msg-(\d+)$/u.exec(node.id);
    if (!match) return null;
    const index = Number(match[1]);
    return Number.isFinite(index) ? Math.max(0, Math.floor(index)) : null;
  }

  function findPreviousRenderedMessageElement(messageIndex) {
    const safeIndex = Math.max(0, Math.floor(Number(messageIndex) || 0));
    let bestElement = null;
    let bestIndex = Number.NEGATIVE_INFINITY;
    for (const node of document.querySelectorAll("[id^='msg-']")) {
      if (!(node instanceof HTMLElement)) continue;
      const index = readMessageAnchorIndex(node);
      if (typeof index !== "number" || index >= safeIndex) continue;
      if (index > bestIndex) {
        bestIndex = index;
        bestElement = node;
      }
    }
    return bestElement;
  }

  function isFirstRenderedMessageIndex(messageIndex) {
    const firstIndex = getFirstRenderedMessageIndex();
    return typeof firstIndex === "number" && firstIndex === Math.max(0, Math.floor(Number(messageIndex) || 0));
  }

  function trimChatOpenPositions(positions) {
    const entries = Object.entries(positions)
      .filter(([, value]) => value && typeof value === "object" && typeof value.messageIndex === "number")
      .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0));
    for (const [key] of entries.slice(100)) {
      delete positions[key];
    }
  }

  function scheduleToolbarCompactMode() {
    if (!(toolbarEl instanceof HTMLElement)) return;
    if (toolbarCompactFrame) cancelAnimationFrame(toolbarCompactFrame);
    toolbarCompactFrame = requestAnimationFrame(() => {
      toolbarCompactFrame = 0;
      updateToolbarCompactMode();
    });
  }

  function updateToolbarCompactMode() {
    if (!(toolbarEl instanceof HTMLElement)) return;
    toolbarEl.classList.remove("toolbarCompact");
    const needsCompact = toolbarEl.scrollWidth > toolbarEl.clientWidth + 1;
    toolbarEl.classList.toggle("toolbarCompact", needsCompact);
    document.documentElement.style.setProperty("--chv-toolbar-height", `${toolbarEl.offsetHeight}px`);
    updateTimeGuide({ afterPaint: true });
    scheduleStickyUserOverlayUpdate();
  }

  function normalizePageSearchPanelWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) return null;
    const availableWidth = Math.max(1, window.innerWidth - PAGE_SEARCH_HORIZONTAL_MARGIN);
    const minimumWidth = Math.min(MIN_PAGE_SEARCH_WIDTH, availableWidth);
    return Math.max(minimumWidth, Math.min(Math.round(width), availableWidth));
  }

  function applyPageSearchPanelWidth() {
    if (!(pageSearchBarEl instanceof HTMLElement)) return;
    const preferredWidth = Number(pageSearchPanelWidth);
    if (!Number.isFinite(preferredWidth) || preferredWidth <= 0) {
      pageSearchBarEl.style.removeProperty("--chv-page-search-width");
      return;
    }
    pageSearchBarEl.style.setProperty(
      "--chv-page-search-width",
      `${Math.max(MIN_PAGE_SEARCH_WIDTH, Math.round(preferredWidth))}px`,
    );
  }

  function persistPageSearchPanelWidth() {
    if (typeof vscode.setState !== "function") return;
    webviewState = {
      ...(webviewState && typeof webviewState === "object" ? webviewState : {}),
      pageSearchPanelWidth,
    };
    vscode.setState(webviewState);
  }

  function persistRestoreState(options = {}) {
    if (typeof vscode.setState !== "function") return;
    if (!model || typeof model.fsPath !== "string" || !model.fsPath) return;
    const previousRestore =
      webviewState && webviewState.restore && typeof webviewState.restore === "object" ? webviewState.restore : {};
    const revealMessageIndex =
      typeof options.revealMessageIndex === "number" && Number.isFinite(options.revealMessageIndex)
        ? Math.max(0, Math.floor(options.revealMessageIndex))
        : options.preserveReveal === true &&
            typeof previousRestore.revealMessageIndex === "number" &&
            Number.isFinite(previousRestore.revealMessageIndex)
          ? Math.max(0, Math.floor(previousRestore.revealMessageIndex))
          : options.preserveReveal !== true && typeof selectedMessageIndex === "number" && Number.isFinite(selectedMessageIndex)
          ? Math.max(0, Math.floor(selectedMessageIndex))
          : undefined;
    const revealTarget = normalizeRevealTarget(options.revealTarget) || (
      options.preserveReveal === true ? normalizeRevealTarget(previousRestore.revealTarget) : null
    );
    const topMessageIndex = findTopVisibleMessageIndex();
    const restore = {
      version: 1,
      kind: panelKind === "reusable" ? "reusable" : "session",
      fsPath: model.fsPath,
      autoRefreshMode: normalizeAutoRefreshMode(autoRefreshMode),
      detailMode: showDetails ? "full" : "summary",
      pathMode: getEffectivePathMode(),
      scrollY: getScrollTop(),
      ...(typeof topMessageIndex === "number" ? { topMessageIndex } : {}),
      ...(revealMessageIndex !== undefined ? { revealMessageIndex } : {}),
      ...(revealTarget ? { revealTarget } : {}),
    };
    webviewState = {
      ...(webviewState && typeof webviewState === "object" ? webviewState : {}),
      restore,
    };
    vscode.setState(webviewState);
  }

  function isPageSearchOpen() {
    return pageSearchBarEl instanceof HTMLElement && !pageSearchBarEl.hidden;
  }

  function normalizeAutoRefreshMode(value) {
    return value === "preserve" || value === "follow" ? value : "off";
  }

  function normalizePathMode(value) {
    return value === "relocated" ? "relocated" : "recorded";
  }

  function getEffectivePathMode() {
    return pathModeEnabled && pathMode === "relocated" ? "relocated" : "recorded";
  }

  function cycleAutoRefreshMode(mode) {
    if (mode === "off") return "preserve";
    if (mode === "preserve") return "follow";
    return "off";
  }

  function getAutoRefreshTooltip(mode) {
    if (mode === "follow") {
      return getSafeUiText(
        i18n.autoRefreshFollowTooltip,
        "Chat auto-refresh is on (follow latest).",
      );
    }
    if (mode === "off") {
      return getSafeUiText(i18n.autoRefreshOffTooltip, "Chat auto-refresh is off.");
    }
    return getSafeUiText(
      i18n.autoRefreshPreserveTooltip,
      "Chat auto-refresh is on (preserve view).",
    );
  }

  function getAutoRefreshToast(mode) {
    if (mode === "follow") {
      return getSafeUiText(
        i18n.autoRefreshFollowToast,
        "Auto-refresh turned on (follow latest).",
      );
    }
    if (mode === "off") {
      return getSafeUiText(i18n.autoRefreshOffToast, "Auto-refresh turned off.");
    }
    return getSafeUiText(
      i18n.autoRefreshPreserveToast,
      "Auto-refresh turned on (preserve view).",
    );
  }

  function isTextInputElement(element) {
    return (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    );
  }

  function togglePageSearch() {
    if (isPageSearchOpen()) {
      closePageSearch();
      return;
    }
    openPageSearch();
  }

  function clearAllPageSearchTemporaryExpansions() {
    const changed =
      pageSearchTemporaryTurnExpansionActive ||
      pageSearchTemporaryPatchGroupExpansionActive ||
      pageSearchTemporaryAttachmentExpansionActive ||
      pageSearchTemporaryAttachmentDetailKeys.size > 0;
    pageSearchTemporaryTurnExpansionActive = false;
    pageSearchTemporaryPatchGroupExpansionActive = false;
    pageSearchTemporaryAttachmentExpansionActive = false;
    pageSearchTemporaryAttachmentDetailKeys = new Set();
    pageSearchSuppressedTemporaryAttachmentDetailKeys = new Set();
    return changed;
  }

  function resetSessionScopedUiState() {
    cancelRenderAfterCurrent();
    resetPageSearchState();
    if (imagePreview || isImagePreviewOpen()) closeImagePreview();
    resetImageDataCache();
    resetPatchEntryDetailsCache();
    resetStickyUserSuppression();
    temporaryPerformanceMode = null;
    pendingDetailScrollAnchor = null;
    expandedStickyUserKeys = new Set();
    collapsedTurnIds = new Set();
    clearAllPageSearchTemporaryExpansions();
    expandedPatchGroupFileLists = new Set();
    expandedAttachmentDetails = new Set();
  }

  function resetPatchEntryDetailsCache() {
    patchEntrySummaryById.clear();
    patchEntryDetailsById.clear();
    patchEntryDetailsLoading.clear();
    patchEntryDetailsFailed.clear();
  }

  function resetPageSearchState() {
    cancelRenderAfterCurrent();
    cancelPageSearchRefresh();
    cancelPageSearchResize();
    if (pageSearchBarEl instanceof HTMLElement) pageSearchBarEl.hidden = true;
    document.body.classList.remove("pageSearchOpen");
    if (pageSearchInputEl instanceof HTMLInputElement) pageSearchInputEl.value = "";
    pageSearchShowingSuggestions = false;
    pendingPageSearchSeed = null;
    pendingPageSearchRefreshOptions = null;
    activePageSearchSuggestionIndex = -1;
    suppressNextPageSearchFocusSuggestions = false;
    pageSearchCaseSensitive = false;
    pageSearchErrorText = "";
    lastCommittedPageSearchHistory = null;
    pageSearchSelectedRoles = new Set();
    clearAllPageSearchTemporaryExpansions();
    clearPageSearchHighlights();
    renderPageSearchResults();
    renderPageSearchSuggestions();
    renderPageSearchRoleFilters([]);
    updatePageSearchStatus();
    scheduleRunningTurnFallbackUpdate();
  }

  function cancelPageSearchResize() {
    const resizeState = pageSearchResizeState;
    pageSearchResizeState = null;
    document.body.classList.remove("pageSearchResizing");
    if (
      resizeState &&
      pageSearchResizeHandleEl instanceof HTMLElement &&
      pageSearchResizeHandleEl.hasPointerCapture(resizeState.pointerId)
    ) {
      pageSearchResizeHandleEl.releasePointerCapture(resizeState.pointerId);
    }
  }

  function openPageSearch() {
    if (!(pageSearchBarEl instanceof HTMLElement) || !(pageSearchInputEl instanceof HTMLInputElement)) return;
    applyPageSearchPanelWidth();
    pageSearchBarEl.hidden = false;
    document.body.classList.add("pageSearchOpen");
    updateToolbarCompactMode();
    const usedPendingSeed = !pageSearchInputEl.value && applyPendingPageSearchSeedOnOpen();
    if (!usedPendingSeed) {
      const selectedText = window.getSelection ? String(window.getSelection() || "").trim() : "";
      if (!pageSearchInputEl.value && selectedText && !/\s*\n\s*/u.test(selectedText)) {
        pageSearchInputEl.value = selectedText;
      }
      if (pageSearchInputEl.value) refreshPageSearchResults({ preserveIndex: true, reveal: false });
      else {
        renderPageSearchResults();
        updatePageSearchStatus();
      }
    }
    suppressNextPageSearchFocusSuggestions = true;
    pageSearchInputEl.focus();
    pageSearchInputEl.select();
    scheduleRunningTurnFallbackUpdate();
  }

  function closePageSearch() {
    if (!(pageSearchBarEl instanceof HTMLElement)) return;
    const closeScrollAnchor = capturePageSearchCloseScrollAnchor();
    pageSearchBarEl.hidden = true;
    document.body.classList.remove("pageSearchOpen");
    cancelPageSearchRefresh();
    cancelPageSearchResize();
    hidePageSearchSuggestions();
    suppressNextPageSearchFocusSuggestions = false;
    pendingPageSearchRefreshOptions = null;
    pageSearchCaseSensitive = false;
    pageSearchSelectedRoles = new Set();
    pageSearchErrorText = "";
    lastCommittedPageSearchHistory = null;
    const hadTemporaryExpansion = setPageSearchTemporaryExpansions(false, { render: false });
    clearPageSearchHighlights();
    renderPageSearchResults();
    renderPageSearchRoleFilters();
    updatePageSearchStatus();
    scheduleRunningTurnFallbackUpdate();
    if (hadTemporaryExpansion) render();
    restorePageSearchCloseScrollAnchorAfterLayout(closeScrollAnchor);
  }

  function schedulePageSearchRefresh(options = {}) {
    const query = getCurrentPageSearchQuery();
    if (!query) {
      cancelPageSearchRefresh();
      pageSearchErrorText = "";
      pendingPageSearchRefreshOptions = null;
      const resetScrollAnchor = capturePageSearchCloseScrollAnchor();
      if (resetPageSearchTemporaryExpansionsWithScrollAnchor(resetScrollAnchor)) return;
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }
    if (pageSearchRefreshTimer) window.clearTimeout(pageSearchRefreshTimer);
    pageSearchRefreshTimer = window.setTimeout(() => {
      pageSearchRefreshTimer = 0;
      refreshPageSearchResults(options);
    }, PAGE_SEARCH_REFRESH_DEBOUNCE_MS);
  }

  function flushPageSearchRefresh(options = {}) {
    if (!pageSearchRefreshTimer) return false;
    window.clearTimeout(pageSearchRefreshTimer);
    pageSearchRefreshTimer = 0;
    refreshPageSearchResults(options);
    return true;
  }

  function normalizePageSearchRefreshOptions(options = {}) {
    const source = options && typeof options === "object" ? options : {};
    const preferredMessageIndex =
      typeof source.preferredMessageIndex === "number" && Number.isFinite(source.preferredMessageIndex)
        ? Math.max(0, Math.floor(source.preferredMessageIndex))
        : undefined;
    const preferredResultIndex =
      typeof source.preferredResultIndex === "number" && Number.isFinite(source.preferredResultIndex)
        ? Math.max(0, Math.floor(source.preferredResultIndex))
        : undefined;
    const navigationDelta =
      typeof source.navigationDelta === "number" && Number.isFinite(source.navigationDelta)
        ? Math.trunc(source.navigationDelta)
        : 0;
    const contentRevision =
      typeof source.contentRevision === "number" && Number.isFinite(source.contentRevision)
        ? Math.max(0, Math.floor(source.contentRevision))
        : undefined;
    const anchor = normalizePageSearchResultAnchor(source.anchor || source.preferredAnchor);
    return {
      preserveIndex: source.preserveIndex === true,
      reveal: source.reveal !== false,
      keepSuggestions: source.keepSuggestions === true,
      fallbackToNearest: source.fallbackToNearest === true,
      focusResult: source.focusResult === true,
      ...(typeof preferredMessageIndex === "number" ? { preferredMessageIndex } : {}),
      ...(typeof preferredResultIndex === "number" ? { preferredResultIndex } : {}),
      ...(navigationDelta !== 0 ? { navigationDelta } : {}),
      ...(typeof source.queryInput === "string" ? { queryInput: source.queryInput } : {}),
      ...(typeof source.caseSensitive === "boolean" ? { caseSensitive: source.caseSensitive } : {}),
      ...(typeof source.roleFilterKey === "string" ? { roleFilterKey: source.roleFilterKey } : {}),
      ...(typeof contentRevision === "number" ? { contentRevision } : {}),
      ...(anchor ? { anchor } : {}),
    };
  }

  function normalizePageSearchResultAnchor(value) {
    if (!value || typeof value !== "object") return null;
    const messageIndex =
      typeof value.messageIndex === "number" && Number.isFinite(value.messageIndex)
        ? Math.max(0, Math.floor(value.messageIndex))
        : undefined;
    const ordinalWithinAnchor =
      typeof value.ordinalWithinAnchor === "number" && Number.isFinite(value.ordinalWithinAnchor)
        ? Math.max(0, Math.floor(value.ordinalWithinAnchor))
        : undefined;
    const anchor = {
      ...(typeof messageIndex === "number" ? { messageIndex } : {}),
      ...(typeof ordinalWithinAnchor === "number" ? { ordinalWithinAnchor } : {}),
    };
    for (const key of ["role", "turnId", "turnBoundary", "runKey", "textDigest"]) {
      if (typeof value[key] === "string" && value[key].trim()) anchor[key] = value[key].trim().slice(0, 256);
    }
    return Object.keys(anchor).length > 0 ? anchor : null;
  }

  function withPageSearchRefreshSnapshot(options, query) {
    const refreshOptions = normalizePageSearchRefreshOptions(options);
    return {
      ...refreshOptions,
      queryInput: String(query || ""),
      caseSensitive: pageSearchCaseSensitive === true,
      roleFilterKey: getPageSearchRoleFilterKey(),
      contentRevision: pageSearchContentRevision,
    };
  }

  function bumpPageSearchContentRevision() {
    pageSearchContentRevision += 1;
    return pageSearchContentRevision;
  }

  function bumpPageSearchContentRevisionAndQueueRefresh(options = {}) {
    const previousRevision = pageSearchContentRevision;
    const currentRevision = bumpPageSearchContentRevision();
    queuePageSearchContentMutationRefresh(previousRevision, options);
    return currentRevision;
  }

  function withPageSearchContentMutation(mutate, options = {}) {
    const previousRevision = beginPageSearchContentMutation();
    let changed = false;
    try {
      changed = mutate();
    } catch (error) {
      cancelPageSearchContentMutation(previousRevision);
      throw error;
    }
    if (!changed) {
      cancelPageSearchContentMutation(previousRevision);
      return changed;
    }
    dispatchPageSearchContentMutationRefresh(previousRevision, options);
    return changed;
  }

  function beginPageSearchContentMutation() {
    const previousRevision = pageSearchContentRevision;
    bumpPageSearchContentRevision();
    return previousRevision;
  }

  function cancelPageSearchContentMutation(previousRevision) {
    pageSearchContentRevision = previousRevision;
  }

  function dispatchPageSearchContentMutationRefresh(previousRevision, options = {}) {
    const refreshOptions = options.refreshOptions || buildActivePageSearchRefreshOptions({ preserveIndex: true, reveal: false });
    if (typeof options.refreshDelayMs === "number" && Number.isFinite(options.refreshDelayMs)) {
      queueDelayedPageSearchContentMutationRefresh(previousRevision, refreshOptions, options.refreshDelayMs);
      return;
    }
    if (options.refreshImmediately === true) {
      pendingPageSearchRefreshOptions = null;
      refreshPageSearchAfterContentMutation(previousRevision, refreshOptions);
    } else {
      queuePageSearchContentMutationRefresh(previousRevision, refreshOptions);
    }
  }

  function queueDelayedPageSearchContentMutationRefresh(previousRevision, options = {}, delayMs = 0) {
    if (!isPageSearchOpen()) return;
    const refreshOptions = buildPageSearchContentMutationRefreshOptions(previousRevision, options);
    if (deferredPageSearchRefreshTimer) window.clearTimeout(deferredPageSearchRefreshTimer);
    deferredPageSearchRefreshTimer = window.setTimeout(() => {
      deferredPageSearchRefreshTimer = 0;
      if (!isPageSearchOpen()) return;
      refreshPageSearchResults(refreshOptions);
    }, Math.max(0, Math.floor(delayMs)));
  }

  function buildActivePageSearchRefreshOptions(base = {}) {
    const activeResult = Array.isArray(pageSearchResults) ? pageSearchResults[activePageSearchResultIndex] : null;
    const anchor = activeResult && activeResult.anchor ? activeResult.anchor : null;
    return {
      ...base,
      ...(anchor ? { anchor } : {}),
      ...(activeResult && typeof activeResult.messageIndex === "number"
        ? { preferredMessageIndex: activeResult.messageIndex }
        : {}),
    };
  }

  function getCurrentPageSearchQuery() {
    return pageSearchInputEl instanceof HTMLInputElement ? pageSearchInputEl.value.trim() : "";
  }

  function buildPageSearchContentMutationRefreshOptions(previousRevision, options = {}) {
    const refreshOptions = normalizePageSearchRefreshOptions({
      preserveIndex: true,
      reveal: false,
      fallbackToNearest: true,
      ...buildActivePageSearchRefreshOptions(),
      ...options,
    });
    return {
      ...withPageSearchRefreshSnapshot(refreshOptions, getCurrentPageSearchQuery()),
      contentRevision: previousRevision,
    };
  }

  function queuePageSearchContentMutationRefresh(previousRevision, options = {}) {
    if (!isPageSearchOpen()) return;
    pendingPageSearchRefreshOptions = buildPageSearchContentMutationRefreshOptions(previousRevision, options);
  }

  function refreshPageSearchAfterContentMutation(previousRevision, options = {}) {
    if (!isPageSearchOpen()) return;
    refreshPageSearchResults(buildPageSearchContentMutationRefreshOptions(previousRevision, options));
  }

  function getPageSearchRoleFilterKey() {
    return Array.from(pageSearchSelectedRoles).sort().join("|");
  }

  function consumePendingPageSearchRefreshOptions() {
    const options = pendingPageSearchRefreshOptions || { preserveIndex: true, reveal: false };
    pendingPageSearchRefreshOptions = null;
    return options;
  }

  function cancelPageSearchRefresh() {
    if (pageSearchRefreshTimer) {
      window.clearTimeout(pageSearchRefreshTimer);
      pageSearchRefreshTimer = 0;
    }
    // Keep teardown symmetric with resetDeferredRenderWork(), which also clears this timer,
    // so a pending deferred-render refresh never fires against a closed/reset page search.
    if (deferredPageSearchRefreshTimer) {
      window.clearTimeout(deferredPageSearchRefreshTimer);
      deferredPageSearchRefreshTimer = 0;
    }
  }

  function setPageSearchTemporaryTurnExpansion(active, options = {}) {
    if (!isTurnTimelineEnabled()) {
      if (!pageSearchTemporaryTurnExpansionActive) return false;
      pageSearchTemporaryTurnExpansionActive = false;
      if (options.render === true) render();
      return true;
    }
    const nextActive = !!active && collapsedTurnIds.size > 0;
    if (pageSearchTemporaryTurnExpansionActive === nextActive) return false;
    pageSearchTemporaryTurnExpansionActive = nextActive;
    if (options.render === true) render();
    return true;
  }

  function setPageSearchTemporaryPatchGroupExpansion(active, options = {}) {
    const nextActive = !!active && hasPatchGroupsForPageSearchExpansion();
    if (pageSearchTemporaryPatchGroupExpansionActive === nextActive) return false;
    pageSearchTemporaryPatchGroupExpansionActive = nextActive;
    if (options.render === true) render();
    return true;
  }

  function setPageSearchTemporaryAttachmentExpansion(active, options = {}) {
    const nextKeys = active ? collectAttachmentDetailKeysForPageSearchExpansion() : new Set();
    const nextActive = !!active && nextKeys.size > 0;
    const keysChanged = !areStringSetsEqual(pageSearchTemporaryAttachmentDetailKeys, nextKeys);
    if (pageSearchTemporaryAttachmentExpansionActive === nextActive && !keysChanged) return false;
    pageSearchTemporaryAttachmentExpansionActive = nextActive;
    pageSearchTemporaryAttachmentDetailKeys = nextActive ? nextKeys : new Set();
    if (options.render === true) render();
    return true;
  }

  function setPageSearchTemporaryExpansions(active, options = {}) {
    if (!active) {
      const changed = clearAllPageSearchTemporaryExpansions();
      if (changed && options.render === true) render();
      return changed;
    }
    const changedTurn = setPageSearchTemporaryTurnExpansion(active, { render: false });
    const changedPatch = setPageSearchTemporaryPatchGroupExpansion(active, { render: false });
    const changedAttachment = setPageSearchTemporaryAttachmentExpansion(active, { render: false });
    const changed = changedTurn || changedPatch || changedAttachment;
    if (changed && options.render === true) render();
    return changed;
  }

  function setPageSearchTemporaryExpansionsWithScrollAnchor(active, scrollAnchor, options = {}) {
    const changed = withPageSearchContentMutation(
      () => setPageSearchTemporaryExpansions(active, { render: false }),
      { refreshOptions: normalizePageSearchRefreshOptions(options.refreshOptions) },
    );
    if (!changed) return false;
    const restore = () => {
      if (options.restoreScroll !== false && scrollAnchor) {
        restorePageSearchCloseScrollAnchorAfterLayout(scrollAnchor);
      }
    };
    renderOrRequestAfterCurrent(restore);
    return true;
  }

  function resetPageSearchTemporaryExpansionsWithScrollAnchor(scrollAnchor) {
    return setPageSearchTemporaryExpansionsWithScrollAnchor(false, scrollAnchor, {
      refreshOptions: { preserveIndex: true, reveal: false },
      restoreScroll: true,
    });
  }

  function hasPatchGroupsForPageSearchExpansion() {
    const items = model && Array.isArray(model.items) ? model.items : [];
    return items.some(
      (item) => item && item.type === "patchGroup" && Array.isArray(item.entries) && item.entries.length > 0,
    );
  }

  function collectAttachmentDetailKeysForPageSearchExpansion() {
    const keys = new Set();
    const items = model && Array.isArray(model.items) ? model.items : [];
    for (const item of items) {
      if (!item || item.type !== "message" || !Array.isArray(item.attachments)) continue;
      if (!canRenderMessage(item)) continue;
      const attachments = getMessageAttachments(item);
      for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
        const attachment = attachments[attachmentIndex];
        if (!attachment || typeof attachment !== "object") continue;
        if (attachment.type === "notification" && typeof attachment.result === "string" && attachment.result.trim()) {
          const key = buildAttachmentDetailKey(attachment, "result", item, attachmentIndex);
          if (key && !pageSearchSuppressedTemporaryAttachmentDetailKeys.has(key)) keys.add(key);
        }
        if (attachment.type === "invoke" && Array.isArray(attachment.parameters) && attachment.parameters.length > 0) {
          const key = buildAttachmentDetailKey(attachment, "parameters", item, attachmentIndex);
          if (key && !pageSearchSuppressedTemporaryAttachmentDetailKeys.has(key)) keys.add(key);
        }
      }
    }
    return keys;
  }

  function areStringSetsEqual(left, right) {
    if (!(left instanceof Set) || !(right instanceof Set)) return false;
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  function syncPageSearchRoleFilters(options = {}) {
    const availableRoles = getAvailablePageSearchRoles();

    if (options.reset === true) {
      pageSearchSelectedRoles = new Set();
    }

    renderPageSearchRoleFilters(availableRoles);
  }

  function getAvailablePageSearchRoles() {
    const roles = new Set();
    const items = model && Array.isArray(model.items) ? model.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        const role = getMessageRole(item);
        if ((role === "user" || role === "assistant") && canRenderMessage(item)) roles.add(role);
        continue;
      }
      if (item.type === "tool") {
        if (shouldRenderToolCard()) roles.add("tool");
        continue;
      }
      if (item.type === "patchGroup") {
        roles.add("tool");
        continue;
      }
      if (showDetails && item.type === "note") {
        roles.add("tool");
      }
    }
    return PAGE_SEARCH_ROLE_ORDER.filter((role) => roles.has(role));
  }

  function renderPageSearchRoleFilters(availableRoles = getAvailablePageSearchRoles()) {
    if (!(pageSearchRoleFiltersEl instanceof HTMLElement)) return;
    prunePageSearchSelectedRoles(availableRoles);
    pageSearchRoleFiltersEl.textContent = "";
    if (availableRoles.length === 0) {
      pageSearchRoleFiltersEl.hidden = true;
      return;
    }

    pageSearchRoleFiltersEl.hidden = false;
    pageSearchRoleFiltersEl.setAttribute(
      "aria-label",
      getSafeUiText(i18n.pageSearchRoleFilters, "Filter target roles"),
    );
    const selectedCount = availableRoles.filter((role) => pageSearchSelectedRoles.has(role)).length;
    for (const role of availableRoles) {
      const label = getPageSearchRoleLabel(role);
      const shortLabel = PAGE_SEARCH_ROLE_SHORT_LABELS[role] || label.slice(0, 1).toUpperCase();
      const selected = pageSearchSelectedRoles.has(role);
      const button = el("button", { type: "button", className: "pageSearchRoleFilter" });
      button.dataset.role = role;
      const tooltip = getPageSearchRoleFilterTooltip(role, label, selected, selectedCount);
      button.title = tooltip;
      button.setAttribute("aria-label", tooltip);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      const full = el("span", { className: "pageSearchRoleFilterFull" });
      full.textContent = label;
      const short = el("span", { className: "pageSearchRoleFilterShort" });
      short.textContent = shortLabel;
      button.appendChild(full);
      button.appendChild(short);
      button.addEventListener("click", () => {
        togglePageSearchRoleFilter(role);
      });
      pageSearchRoleFiltersEl.appendChild(button);
    }
  }

  function getPageSearchRoleLabel(role) {
    if (role === "user") return getSafeUiText(i18n.roleUser, "User");
    if (role === "assistant") return getSafeUiText(i18n.roleAssistant, "Assistant");
    if (role === "tool") return getSafeUiText(i18n.tool, "Tool");
    return String(role || "");
  }

  function getPageSearchRoleFilterTooltip(role, label, selected, selectedCount) {
    if (selected && selectedCount <= 1) {
      return formatTemplate(
        getSafeUiText(i18n.pageSearchRoleFilterRemoveToAllTooltip, "Clear {0} filter and search all"),
        label,
      );
    }
    if (selected) {
      return formatTemplate(
        getSafeUiText(i18n.pageSearchRoleFilterRemoveTooltip, "Remove {0} from filter"),
        label,
      );
    }
    if (selectedCount > 0) {
      return formatTemplate(getSafeUiText(i18n.pageSearchRoleFilterAddTooltip, "Add {0} to filter"), label);
    }
    return formatTemplate(getSafeUiText(i18n.pageSearchRoleFilterOnlyTooltip, "Search only {0}"), label);
  }

  function togglePageSearchRoleFilter(role) {
    if (!PAGE_SEARCH_ROLE_SET.has(role)) return;
    const availableRoles = getAvailablePageSearchRoles();
    prunePageSearchSelectedRoles(availableRoles);
    if (!availableRoles.includes(role)) return;
    if (pageSearchSelectedRoles.has(role)) pageSearchSelectedRoles.delete(role);
    else pageSearchSelectedRoles.add(role);
    pageSearchSuppressedTemporaryAttachmentDetailKeys = new Set();
    renderPageSearchRoleFilters(availableRoles);
    if (isPageSearchOpen()) {
      const activeResult = pageSearchResults[activePageSearchResultIndex];
      refreshPageSearchResults({
        preserveIndex: false,
        reveal: false,
        fallbackToNearest: true,
        ...(activeResult && typeof activeResult.messageIndex === "number"
          ? { preferredMessageIndex: activeResult.messageIndex }
          : {}),
      });
    }
  }

  function prunePageSearchSelectedRoles(availableRoles = getAvailablePageSearchRoles()) {
    const availableRoleSet = new Set(availableRoles);
    for (const role of Array.from(pageSearchSelectedRoles)) {
      if (!availableRoleSet.has(role)) pageSearchSelectedRoles.delete(role);
    }
  }

  function refreshPageSearchResults(options = {}) {
    const refreshOptions = normalizePageSearchRefreshOptions(options);
    const preserveIndex = refreshOptions.preserveIndex;
    const reveal = refreshOptions.reveal;
    const query = getCurrentPageSearchQuery();
    const previousIndex = preserveIndex ? activePageSearchResultIndex : -1;
    if (!refreshOptions.keepSuggestions) hidePageSearchSuggestions();
    pageSearchErrorText = "";
    const expansionScrollAnchor = reveal ? null : captureTimelineScrollAnchor();
    const resetScrollAnchor = capturePageSearchCloseScrollAnchor();
    clearPageSearchHighlights();
    if (!query) {
      pendingPageSearchRefreshOptions = null;
      if (resetPageSearchTemporaryExpansionsWithScrollAnchor(resetScrollAnchor)) return;
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    const compiled = compilePageSearchQuery(query, pageSearchCaseSensitive);
    if (!compiled) {
      pageSearchErrorText = getPageSearchInvalidMessage(query);
      pendingPageSearchRefreshOptions = null;
      if (resetPageSearchTemporaryExpansionsWithScrollAnchor(resetScrollAnchor)) return;
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    if (
      setPageSearchTemporaryExpansionsWithScrollAnchor(true, expansionScrollAnchor, {
        refreshOptions: withPageSearchRefreshSnapshot(refreshOptions, query),
        restoreScroll: !reveal,
      })
    ) {
      return;
    }

    const roots = [annotationEl, metaEl, timelineEl].filter((node) => node instanceof HTMLElement);
    const textNodes = [];

    const roleFilterActive = isPageSearchRoleFilterActive();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return shouldAcceptPageSearchTextNode(node, { roleFilterActive })
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      const matches = compiled.findAll(text);
      if (matches.length === 0) continue;

      const fragment = document.createDocumentFragment();
      const pendingMarks = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
        }
        const mark = document.createElement("mark");
        mark.className = "pageSearchMatch";
        mark.textContent = text.slice(match.start, match.start + match.length);
        fragment.appendChild(mark);
        pendingMarks.push({ mark, start: match.start, length: match.length });
        pageSearchMatches.push(mark);
        cursor = match.start + match.length;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);

      for (const pending of pendingMarks) {
        pageSearchResults.push(buildPageSearchResult(pending.mark, text, pending.start, pending.length));
      }
    }

    renderPageSearchResults();

    if (pageSearchResults.length === 0) {
      updatePageSearchStatus();
      return;
    }

    const nextIndex = resolvePageSearchActivationIndex(refreshOptions, previousIndex, query);
    activatePageSearchResult(nextIndex, { reveal, focusResult: refreshOptions.focusResult });
  }

  function resolvePageSearchActivationIndex(refreshOptions, previousIndex, query) {
    if (!Array.isArray(pageSearchResults) || pageSearchResults.length === 0) return -1;
    const inputStale = isPageSearchRefreshInputStale(refreshOptions, query);
    const contentStale = isPageSearchRefreshContentStale(refreshOptions);
    if (inputStale) {
      const nearestIndex = findNearestPageSearchResultToScrollPosition();
      if (nearestIndex >= 0) return nearestIndex;
      if (previousIndex >= 0) return Math.min(previousIndex, pageSearchResults.length - 1);
      return 0;
    }

    const anchorIndex = findPageSearchResultIndexForAnchor(refreshOptions.anchor);
    if (anchorIndex >= 0) return anchorIndex;

    if (contentStale && typeof refreshOptions.preferredMessageIndex === "number") {
      const preferredIndex = findPageSearchResultIndexForMessageIndex(refreshOptions.preferredMessageIndex);
      if (preferredIndex >= 0) return preferredIndex;
      const nearestIndex = findNearestPageSearchResultToScrollPosition();
      if (nearestIndex >= 0) return nearestIndex;
      if (previousIndex >= 0) return Math.min(previousIndex, pageSearchResults.length - 1);
      return 0;
    }
    if (contentStale) {
      const nearestIndex = findNearestPageSearchResultToScrollPosition();
      if (nearestIndex >= 0) return nearestIndex;
      if (previousIndex >= 0) return Math.min(previousIndex, pageSearchResults.length - 1);
      return 0;
    }

    if (typeof refreshOptions.preferredMessageIndex === "number") {
      const preferredIndex = findPageSearchResultIndexForMessageIndex(refreshOptions.preferredMessageIndex);
      if (preferredIndex >= 0) return preferredIndex;
      const nearestIndex = findNearestPageSearchResultToScrollPosition();
      return nearestIndex >= 0 ? nearestIndex : 0;
    }
    if (typeof refreshOptions.preferredResultIndex === "number") {
      return Math.max(0, Math.min(pageSearchResults.length - 1, refreshOptions.preferredResultIndex));
    }
    if (refreshOptions.fallbackToNearest === true) {
      const nearestIndex = findNearestPageSearchResultToScrollPosition();
      if (nearestIndex >= 0) return nearestIndex;
    }
    if (typeof refreshOptions.navigationDelta === "number") {
      const currentIndex =
        previousIndex >= 0 ? previousIndex : activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
      return Math.max(0, Math.min(pageSearchResults.length - 1, currentIndex + refreshOptions.navigationDelta));
    }
    if (refreshOptions.preserveIndex === true && previousIndex >= 0) {
      return Math.min(previousIndex, pageSearchResults.length - 1);
    }
    return 0;
  }

  function isPageSearchRefreshInputStale(refreshOptions, query) {
    if (!refreshOptions || typeof refreshOptions !== "object") return false;
    if (typeof refreshOptions.queryInput === "string" && refreshOptions.queryInput !== String(query || "")) return true;
    if (typeof refreshOptions.caseSensitive === "boolean" && refreshOptions.caseSensitive !== (pageSearchCaseSensitive === true)) {
      return true;
    }
    if (typeof refreshOptions.roleFilterKey === "string" && refreshOptions.roleFilterKey !== getPageSearchRoleFilterKey()) {
      return true;
    }
    return false;
  }

  function isPageSearchRefreshContentStale(refreshOptions) {
    if (!refreshOptions || typeof refreshOptions !== "object") return false;
    if (
      typeof refreshOptions.contentRevision === "number" &&
      refreshOptions.contentRevision !== pageSearchContentRevision
    ) {
      return true;
    }
    return false;
  }

  function isPageSearchRefreshIntentStale(refreshOptions, query) {
    return isPageSearchRefreshInputStale(refreshOptions, query) || isPageSearchRefreshContentStale(refreshOptions);
  }

  function findPageSearchResultIndexForMessageIndex(messageIndex) {
    if (!Number.isFinite(messageIndex) || !Array.isArray(pageSearchResults)) return -1;
    const target = Math.max(0, Math.floor(messageIndex));
    return pageSearchResults.findIndex((result) => result && result.messageIndex === target);
  }

  function findPageSearchResultIndexForAnchor(anchor) {
    const normalized = normalizePageSearchResultAnchor(anchor);
    if (!normalized || !Array.isArray(pageSearchResults)) return -1;
    return pageSearchResults.findIndex((result) => pageSearchResultMatchesAnchor(result, normalized));
  }

  function pageSearchResultMatchesAnchor(result, anchor) {
    if (!result || !result.anchor || !anchor) return false;
    const candidate = normalizePageSearchResultAnchor(result.anchor);
    if (!candidate) return false;
    if (typeof anchor.messageIndex === "number" && candidate.messageIndex !== anchor.messageIndex) return false;
    for (const key of ["role", "turnId", "turnBoundary", "runKey"]) {
      if (anchor[key] && candidate[key] !== anchor[key]) return false;
    }
    if (typeof anchor.ordinalWithinAnchor === "number" && candidate.ordinalWithinAnchor !== anchor.ordinalWithinAnchor) {
      return false;
    }
    if (anchor.textDigest && candidate.textDigest && candidate.textDigest !== anchor.textDigest) return false;
    return true;
  }

  function isPageSearchRoleFilterActive() {
    const availableRoles = getAvailablePageSearchRoles();
    return availableRoles.some((role) => pageSearchSelectedRoles.has(role));
  }

  function shouldAcceptPageSearchTextNode(node, options = {}) {
    if (!(node instanceof Text)) return false;
    const text = node.textContent || "";
    if (!text.trim()) return false;

    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement)) return false;
    if (parent.closest("#pageSearchBar, .dateGuide")) return false;
    if (parent.closest("[data-page-search-ignore='true']")) return false;
    if (parent.closest(".turnMarker, .runningTurnAnchorRow, .runningTurnFallbackChip")) return false;
    if (parent.closest("script, style, textarea, input, select")) return false;
    if (parent.closest("button") && !parent.closest(".patchGroupFilePath")) return false;
    if (parent.closest("mark.pageSearchMatch")) return false;
    if (parent.closest("[hidden]")) return false;
    if (!showDetails && parent.closest(".row.developer, .row.usage, .row.environment")) return false;
    const role = resolvePageSearchTextRole(parent);
    if (options.roleFilterActive === true && (!role || !pageSearchSelectedRoles.has(role))) return false;

    const closedDetails = parent.closest("details:not([open])");
    if (closedDetails) {
      const summary = parent.closest("summary");
      if (!(summary instanceof HTMLElement) || summary.parentElement !== closedDetails) return false;
    }

    if (parent.getClientRects().length === 0 && !parent.closest("summary")) return false;
    return true;
  }

  function resolvePageSearchTextRole(element) {
    if (!(element instanceof HTMLElement)) return "";
    const bubble = element.closest(".bubble");
    if (bubble instanceof HTMLElement) {
      if (bubble.classList.contains("user")) return "user";
      if (bubble.classList.contains("assistant")) return "assistant";
      if (bubble.classList.contains("tool")) return "tool";
      return "";
    }
    if (element.closest(".toolCard, .patchGroupCard, .patchEntry, .patchDiffBlock")) return "tool";
    return "";
  }

  function clearPageSearchHighlights() {
    for (const match of Array.from(document.querySelectorAll("mark.pageSearchMatch"))) {
      const textNode = document.createTextNode(match.textContent || "");
      const parent = match.parentNode;
      if (!parent) continue;
      parent.replaceChild(textNode, match);
      if (parent instanceof HTMLElement) parent.normalize();
    }
    pageSearchMatches = [];
    pageSearchResults = [];
    activePageSearchResultIndex = -1;
  }

  function clearPageSearchForEmptyInput() {
    cancelPageSearchRefresh();
    pageSearchErrorText = "";
    pendingPageSearchRefreshOptions = null;
    const resetScrollAnchor = capturePageSearchCloseScrollAnchor();
    clearPageSearchHighlights();
    if (resetPageSearchTemporaryExpansionsWithScrollAnchor(resetScrollAnchor)) return;
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function navigatePageSearchResults(delta) {
    if (!isPageSearchOpen()) {
      openPageSearch();
      return;
    }
    commitCurrentPageSearchQuery();
    const refreshOptions = { preserveIndex: true, reveal: true, navigationDelta: delta };
    const flushed = flushPageSearchRefresh(refreshOptions);
    if (flushed) return;
    if (!flushed && pageSearchResults.length === 0) {
      refreshPageSearchResults(refreshOptions);
      return;
    }
    if (pageSearchResults.length === 0) return;
    const total = pageSearchResults.length;
    const currentIndex = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + delta));
    if (nextIndex === currentIndex) return;
    activatePageSearchResult(nextIndex, { reveal: true });
  }

  function requestPageSearchRevealRender(activeResult, safeIndex, options = {}) {
    if (!activeResult || !(activeResult.mark instanceof HTMLElement)) return false;
    const turnId = normalizeTurnId(getTurnIdForElement(activeResult.mark));
    if (!turnId || !collapsedTurnIds.has(turnId)) return false;
    const refreshOptions = {
      preserveIndex: false,
      reveal: true,
      focusResult: options.focusResult === true,
      fallbackToNearest: true,
      preferredResultIndex: safeIndex,
      ...(activeResult.anchor ? { anchor: activeResult.anchor } : {}),
      ...(typeof activeResult.messageIndex === "number" ? { preferredMessageIndex: activeResult.messageIndex } : {}),
    };
    const query = getCurrentPageSearchQuery();
    pendingPageSearchRefreshOptions = withPageSearchRefreshSnapshot(refreshOptions, query);
    if (ensureTurnExpandedForReveal(turnId, { render: true })) return true;
    pendingPageSearchRefreshOptions = null;
    return false;
  }

  function activatePageSearchResult(index, options = {}) {
    const reveal = options.reveal !== false;
    if (reveal) hidePageSearchSuggestions();
    if (pageSearchResults.length === 0) {
      activePageSearchResultIndex = -1;
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    for (const match of pageSearchMatches) {
      if (match instanceof HTMLElement) match.classList.remove("pageSearchMatch-active");
    }

    const safeIndex = Math.max(0, Math.min(index, pageSearchResults.length - 1));
    activePageSearchResultIndex = safeIndex;
    const activeResult = pageSearchResults[safeIndex];
    if (activeResult && activeResult.mark instanceof HTMLElement) {
      activeResult.mark.classList.add("pageSearchMatch-active");
      if (reveal) {
        if (requestPageSearchRevealRender(activeResult, safeIndex, options)) return;
        activeResult.mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }
    }
    renderPageSearchResults();
    scrollActivePageSearchResultIntoList();
    if (options.focusResult === true) focusPageSearchResultItem(safeIndex);
    updatePageSearchStatus();
  }

  function moveFocusedPageSearchResult(delta) {
    if (!Array.isArray(pageSearchResults) || pageSearchResults.length === 0) return;
    const focusedIndex = getFocusedPageSearchResultIndex();
    const currentIndex =
      focusedIndex >= 0 ? focusedIndex : activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    const nextIndex = Math.max(0, Math.min(pageSearchResults.length - 1, currentIndex + delta));
    if (nextIndex === currentIndex) return;
    activatePageSearchResult(nextIndex, { reveal: false, focusResult: true });
  }

  function getFocusedPageSearchResultIndex() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return -1;
    const item = active.closest("#pageSearchResults .pageSearchResult");
    if (!(item instanceof HTMLElement)) return -1;
    const index = Number(item.dataset.searchIndex);
    return Number.isFinite(index) ? Math.max(0, Math.floor(index)) : -1;
  }

  function focusPageSearchResultItem(index) {
    if (!(pageSearchResultsEl instanceof HTMLElement)) return;
    const item = pageSearchResultsEl.querySelector(`[data-search-index="${String(index)}"]`);
    if (item instanceof HTMLElement) item.focus({ preventScroll: true });
  }

  function scrollActivePageSearchResultIntoList() {
    if (!(pageSearchResultsEl instanceof HTMLElement)) return;
    const active = pageSearchResultsEl.querySelector(".pageSearchResult-active");
    if (!(active instanceof HTMLElement)) return;
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function buildPageSearchResult(mark, sourceText, startIndex, queryLength) {
    const snippet = buildPageSearchSnippet(sourceText, startIndex, queryLength);
    const context = describePageSearchContext(mark);
    const anchor = buildPageSearchResultAnchor(mark, context, sourceText, startIndex, queryLength);
    return {
      mark,
      title: context.title,
      meta: context.meta,
      lineNumber: context.lineNumber,
      snippet,
      messageIndex: context.messageIndex,
      anchor,
    };
  }

  function buildPageSearchResultAnchor(mark, context, sourceText, startIndex, queryLength) {
    const element = mark instanceof HTMLElement ? mark : null;
    const bubble = element ? element.closest(".bubble") : null;
    const role = bubble instanceof HTMLElement
      ? bubble.classList.contains("user")
        ? "user"
        : bubble.classList.contains("assistant")
          ? "assistant"
          : bubble.classList.contains("developer")
            ? "developer"
            : ""
      : "";
    const turnCarrier = element ? element.closest("[data-turn-id]") : null;
    const runCarrier = element ? element.closest("[data-turn-run-key]") : null;
    const boundaryCarrier = element ? element.closest("[data-turn-boundary]") : null;
    const base = {
      ...(typeof context.messageIndex === "number" ? { messageIndex: context.messageIndex } : {}),
      ...(role ? { role } : {}),
      ...(turnCarrier instanceof HTMLElement && turnCarrier.dataset.turnId ? { turnId: turnCarrier.dataset.turnId } : {}),
      ...(runCarrier instanceof HTMLElement && runCarrier.dataset.turnRunKey ? { runKey: runCarrier.dataset.turnRunKey } : {}),
      ...(boundaryCarrier instanceof HTMLElement && boundaryCarrier.dataset.turnBoundary
        ? { turnBoundary: boundaryCarrier.dataset.turnBoundary }
        : {}),
      textDigest: hashPageSearchAnchorText(sourceText, startIndex, queryLength),
    };
    const key = buildPageSearchAnchorScopeKey(base);
    const ordinalWithinAnchor = pageSearchResults.filter((result) => {
      const resultKey = buildPageSearchAnchorScopeKey(result && result.anchor);
      return resultKey && resultKey === key;
    }).length;
    return { ...base, ordinalWithinAnchor };
  }

  function buildPageSearchAnchorScopeKey(anchor) {
    if (!anchor || typeof anchor !== "object") return "";
    return [
      typeof anchor.messageIndex === "number" ? `m:${anchor.messageIndex}` : "",
      anchor.role ? `r:${anchor.role}` : "",
      anchor.turnId ? `t:${anchor.turnId}` : "",
      anchor.turnBoundary ? `b:${anchor.turnBoundary}` : "",
      anchor.runKey ? `k:${anchor.runKey}` : "",
    ].join("|");
  }

  function hashPageSearchAnchorText(sourceText, startIndex, queryLength) {
    const text = String(sourceText || "");
    const start = Math.max(0, Math.floor(Number(startIndex) || 0) - 24);
    const end = Math.min(text.length, Math.floor(Number(startIndex) || 0) + Math.max(0, Math.floor(Number(queryLength) || 0)) + 24);
    let hash = 2166136261;
    const slice = text.slice(start, end);
    for (let index = 0; index < slice.length; index += 1) {
      hash ^= slice.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function buildPageSearchSnippet(text, startIndex, queryLength) {
    const prefixStart = Math.max(0, startIndex - 42);
    const suffixEnd = Math.min(text.length, startIndex + queryLength + 66);
    const prefix = text.slice(prefixStart, startIndex).trimStart();
    const match = text.slice(startIndex, startIndex + queryLength);
    const suffix = text.slice(startIndex + queryLength, suffixEnd).trimEnd();
    return {
      prefix: `${prefixStart > 0 ? "..." : ""}${prefix}`,
      match,
      suffix: `${suffix}${suffixEnd < text.length ? "..." : ""}`,
    };
  }

  function describePageSearchContext(mark) {
    const patchCell = mark instanceof HTMLElement ? mark.closest(".patchDiffText") : null;
    if (patchCell instanceof HTMLElement) {
      return describePatchSearchContext(patchCell);
    }

    const patchSummary = mark instanceof HTMLElement ? mark.closest(".patchEntrySummary") : null;
    if (patchSummary instanceof HTMLElement) {
      const filePath = patchSummary.querySelector(".patchEntryPath");
      return {
        title: getElementText(filePath) || getSafeUiText(i18n.patchGroupTitle, "Changes"),
        meta: "",
        lineNumber: "",
      };
    }

    const toolCard = mark instanceof HTMLElement ? mark.closest(".toolCard") : null;
    if (toolCard instanceof HTMLElement) {
      return describeToolCardSearchContext(toolCard);
    }

    const bubble = mark instanceof HTMLElement ? mark.closest(".bubble") : null;
    if (bubble instanceof HTMLElement) {
      return describeBubbleSearchContext(bubble);
    }

    if (mark instanceof HTMLElement && mark.closest("#annotation")) {
      const inTags = !!mark.closest(".sessionTagList");
      return {
        title: inTags
          ? getSafeUiText(i18n.annotationTags, "Tags")
          : getSafeUiText(i18n.annotationNote, "Note"),
        meta: "",
        lineNumber: "",
      };
    }

    if (mark instanceof HTMLElement && mark.closest("#meta")) {
      return {
        title: getSafeUiText(i18n.sessionInfo, "Session info"),
        meta: "",
        lineNumber: "",
      };
    }

    return {
      title: getSafeUiText(i18n.pageSearch, "Find"),
      meta: "",
      lineNumber: "",
    };
  }

  function describePatchSearchContext(cell) {
    const patchEntry = cell.closest(".patchEntry");
    const patchHunk = cell.closest(".patchHunk");
    const filePath = getElementText(patchEntry && patchEntry.querySelector(".patchEntryPath"));
    const hunkHeader = getElementText(patchHunk && patchHunk.querySelector(".patchHunkHeaderText"));
    const sideLabel = cell.classList.contains("patchDiffText-right")
      ? getSafeUiText(i18n.patchAfter, "After")
      : getSafeUiText(i18n.patchBefore, "Before");
    const lineNumber = resolvePatchSearchLineNumber(cell);
    return {
      title: filePath || getSafeUiText(i18n.patchGroupTitle, "Changes"),
      meta: [sideLabel, hunkHeader].filter(Boolean).join(" · "),
      lineNumber,
    };
  }

  function describeToolCardSearchContext(card) {
    const title = getElementText(card.querySelector(".toolCardTitle"));
    const metaText = getElementText(card.querySelector(".toolCardMetaLine"));
    return {
      title: title || getSafeUiText(i18n.roleMessage, "Message"),
      meta: metaText,
      lineNumber: "",
    };
  }

  function describeBubbleSearchContext(bubble) {
    const roleLabel = bubble.classList.contains("user")
      ? getSafeUiText(i18n.roleUser, "User")
      : bubble.classList.contains("assistant")
        ? getSafeUiText(i18n.roleAssistant, "Assistant")
        : bubble.classList.contains("developer")
          ? getSafeUiText(i18n.roleDeveloper, "Developer")
          : getSafeUiText(i18n.roleMessage, "Message");
    const messageIndex = bubble.dataset.messageIndex ? `#${bubble.dataset.messageIndex}` : "";
    const metaText = describeMessageSearchMeta(bubble, roleLabel, messageIndex);
    return {
      title: [roleLabel, messageIndex].filter(Boolean).join(" "),
      meta: metaText,
      lineNumber: "",
      messageIndex: bubble.dataset.messageIndex ? Number(bubble.dataset.messageIndex) : undefined,
    };
  }

  function describeMessageSearchMeta(bubble, roleLabel, messageIndex) {
    const tags = Array.from(bubble.querySelectorAll(".metaTags .tag"))
      .map((tag) => getElementText(tag))
      .filter(Boolean);
    const excluded = new Set([String(roleLabel || "").toLowerCase(), String(messageIndex || "").toLowerCase()]);
    return tags.filter((tag) => !excluded.has(String(tag || "").toLowerCase())).join(" · ");
  }

  function resolvePatchSearchLineNumber(cell) {
    if (!(cell instanceof HTMLElement)) return "";
    const rowIndex = cell.dataset.rowIndex;
    if (!rowIndex) return "";
    const block = cell.closest(".patchDiffBlock");
    if (!(block instanceof HTMLElement)) return "";
    for (const lineEl of block.querySelectorAll(".patchDiffLineNo")) {
      if (!(lineEl instanceof HTMLElement)) continue;
      if (lineEl.dataset.rowIndex !== rowIndex) continue;
      const text = lineEl.textContent ? lineEl.textContent.trim() : "";
      if (text) return text;
    }
    return "";
  }

  function renderPageSearchResults() {
    if (!(pageSearchResultsEl instanceof HTMLElement)) return;
    pageSearchResultsEl.textContent = "";

    const query = getCurrentPageSearchQuery();
    if (!query && pageSearchResults.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = getSafeUiText(i18n.pageSearchTypeToSearch, "Type to search");
      pageSearchResultsEl.appendChild(empty);
      return;
    }

    if (pageSearchErrorText) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = pageSearchErrorText;
      pageSearchResultsEl.appendChild(empty);
      return;
    }

    if (pageSearchResults.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = getSafeUiText(i18n.pageSearchNoMatches, "No matches");
      pageSearchResultsEl.appendChild(empty);
      return;
    }

    pageSearchResults.forEach((result, index) => {
      const item = el("button", { type: "button", className: "pageSearchResult" });
      item.dataset.searchIndex = String(index);
      if (index === activePageSearchResultIndex) item.classList.add("pageSearchResult-active");
      item.addEventListener("click", () => {
        commitCurrentPageSearchQuery();
        activatePageSearchResult(index, { reveal: true });
      });
      item.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        moveFocusedPageSearchResult(event.key === "ArrowDown" ? 1 : -1);
      });

      const header = el("div", { className: "pageSearchResultHeader" });
      if (result.lineNumber) {
        const lineBadge = el("span", { className: "pageSearchResultLine" });
        lineBadge.textContent = result.lineNumber;
        header.appendChild(lineBadge);
      }

      const headerText = el("div", { className: "pageSearchResultHeaderText" });
      const title = el("div", { className: "pageSearchResultTitle" });
      title.textContent = result.title || getSafeUiText(i18n.pageSearch, "Find");
      headerText.appendChild(title);
      if (result.meta) {
        const meta = el("div", { className: "pageSearchResultMeta" });
        meta.textContent = result.meta;
        headerText.appendChild(meta);
      }
      header.appendChild(headerText);
      item.appendChild(header);

      const snippet = el("div", { className: "pageSearchResultSnippet" });
      if (result.snippet.prefix) snippet.appendChild(document.createTextNode(result.snippet.prefix));
      const match = el("span", { className: "pageSearchResultMatch" });
      match.textContent = result.snippet.match;
      snippet.appendChild(match);
      if (result.snippet.suffix) snippet.appendChild(document.createTextNode(result.snippet.suffix));
      item.appendChild(snippet);

      pageSearchResultsEl.appendChild(item);
    });
  }

  function renderPageSearchSuggestions() {
    if (!(pageSearchSuggestionsEl instanceof HTMLElement)) return;
    pageSearchSuggestionsEl.textContent = "";
    if (!pageSearchShowingSuggestions) {
      pageSearchSuggestionsEl.hidden = true;
      return;
    }

    const suggestions = getVisiblePageSearchSuggestions();
    pageSearchSuggestionsEl.hidden = false;
    if (suggestions.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = getSafeUiText(i18n.pageSearchNoHistory, "No recent searches");
      pageSearchSuggestionsEl.appendChild(empty);
      return;
    }

    suggestions.forEach((entry, index) => {
      const item = el("div", { className: "pageSearchResult pageSearchSuggestion" });
      if (index === activePageSearchSuggestionIndex) item.classList.add("pageSearchResult-active");
      item.addEventListener("click", () => {
        activatePageSearchSuggestion(index);
      });
      const main = el("button", { type: "button", className: "pageSearchSuggestionMain" });

      const header = el("div", { className: "pageSearchResultHeader" });
      const headerText = el("div", { className: "pageSearchResultHeaderText" });
      const title = el("div", { className: "pageSearchResultTitle" });
      title.textContent = entry.queryInput;
      headerText.appendChild(title);
      header.appendChild(headerText);
      main.appendChild(header);
      item.appendChild(main);

      const remove = el("button", { type: "button", className: "pageSearchSuggestionRemove" });
      const removeLabel = getSafeUiText(i18n.pageSearchRemoveHistory, "Remove from history");
      remove.title = removeLabel;
      remove.setAttribute("aria-label", removeLabel);
      remove.innerHTML = TRASH_ICON_SVG;
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePageSearchHistoryCandidate(entry);
      });
      item.appendChild(remove);
      pageSearchSuggestionsEl.appendChild(item);
    });
  }

  function hidePageSearchSuggestions() {
    pageSearchShowingSuggestions = false;
    activePageSearchSuggestionIndex = -1;
    renderPageSearchSuggestions();
  }

  function updatePageSearchSuggestionsAfterInput() {
    const suggestions = getVisiblePageSearchSuggestions();
    const query = getCurrentPageSearchQuery();
    if (query && suggestions.length === 0) {
      hidePageSearchSuggestions();
      return;
    }
    activePageSearchSuggestionIndex = suggestions.length > 0 ? 0 : -1;
    renderPageSearchSuggestions();
  }

  function getVisiblePageSearchSuggestions() {
    const query = getCurrentPageSearchQuery().toLowerCase();
    const entries = Array.isArray(pageSearchHistoryCandidates) ? pageSearchHistoryCandidates : [];
    const filtered = query
      ? entries.filter((entry) => String(entry.queryInput || "").toLowerCase().includes(query))
      : entries;
    return filtered.slice(0, MAX_PAGE_SEARCH_HISTORY_CANDIDATES);
  }

  function showPageSearchSuggestions() {
    if (!isPageSearchOpen()) return;
    const suggestions = getVisiblePageSearchSuggestions();
    const query = getCurrentPageSearchQuery();
    pageSearchShowingSuggestions = suggestions.length > 0 || !query;
    activePageSearchSuggestionIndex = pageSearchShowingSuggestions ? 0 : -1;
    renderPageSearchSuggestions();
  }

  function isPageSearchSuggestionInteractionTarget(target) {
    if (!(target instanceof Element)) return false;
    if (pageSearchInputEl instanceof HTMLElement && pageSearchInputEl.contains(target)) return true;
    if (pageSearchSuggestionsEl instanceof HTMLElement && pageSearchSuggestionsEl.contains(target)) return true;
    return false;
  }

  function movePageSearchSuggestion(delta) {
    const suggestions = getVisiblePageSearchSuggestions();
    if (suggestions.length === 0) return;
    const current = activePageSearchSuggestionIndex >= 0 ? activePageSearchSuggestionIndex : 0;
    activePageSearchSuggestionIndex = Math.max(0, Math.min(suggestions.length - 1, current + delta));
    renderPageSearchSuggestions();
  }

  function activatePageSearchSuggestion(index) {
    const suggestions = getVisiblePageSearchSuggestions();
    if (suggestions.length === 0) return false;
    const safeIndex = Math.max(0, Math.min(index, suggestions.length - 1));
    const entry = suggestions[safeIndex];
    if (!entry || !(pageSearchInputEl instanceof HTMLInputElement)) return false;
    pageSearchInputEl.value = String(entry.queryInput || "");
    hidePageSearchSuggestions();
    refreshPageSearchResults({ preserveIndex: false, reveal: false });
    commitCurrentPageSearchQuery();
    suppressNextPageSearchFocusSuggestions = true;
    pageSearchInputEl.focus();
    return true;
  }

  function removePageSearchHistoryCandidate(entry) {
    if (!entry || typeof entry.queryInput !== "string") return;
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!key) return;
    pageSearchHistoryCandidates = pageSearchHistoryCandidates.filter((candidate) => {
      const candidateKey = candidate && typeof candidate.key === "string" ? candidate.key : "";
      return candidateKey !== key;
    });
    reconcileCommittedPageSearchHistory();
    vscode.postMessage({ type: "removePageSearchHistory", queryInput: entry.queryInput });
    if (pageSearchShowingSuggestions) renderPageSearchSuggestions();
  }

  function reconcileCommittedPageSearchHistory() {
    const committed = lastCommittedPageSearchHistory;
    if (!committed) return;
    const candidates = Array.isArray(pageSearchHistoryCandidates) ? pageSearchHistoryCandidates : [];
    const stillPresent = candidates.some((entry) => {
      return entry && entry.queryInput === committed.queryInput;
    });
    if (!stillPresent) lastCommittedPageSearchHistory = null;
  }

  function commitCurrentPageSearchQuery() {
    const queryInput = getCurrentPageSearchQuery();
    if (!queryInput) return;
    if (!compilePageSearchQuery(queryInput, pageSearchCaseSensitive)) return;
    if (
      lastCommittedPageSearchHistory &&
      lastCommittedPageSearchHistory.queryInput === queryInput
    ) {
      return;
    }
    lastCommittedPageSearchHistory = { queryInput };
    vscode.postMessage({ type: "savePageSearchHistory", queryInput });
  }

  function compilePageSearchQuery(rawInput, caseSensitive) {
    const core = getPageSearchCore();
    return core ? core.compileQuery(rawInput, caseSensitive === true) : null;
  }

  function getPageSearchInvalidMessage(rawInput) {
    const core = getPageSearchCore();
    if (core && core.getInvalidKind(rawInput) === "regex") {
      return getSafeUiText(i18n.pageSearchInvalidRegex, "Invalid regular expression");
    }
    return getSafeUiText(i18n.pageSearchInvalidQuery, "Invalid search query");
  }

  function getPageSearchCore() {
    const core = window.CHV_PAGE_SEARCH;
    return core && typeof core.compileQuery === "function" && typeof core.getInvalidKind === "function" ? core : null;
  }

  function getElementText(node) {
    return node instanceof HTMLElement && typeof node.textContent === "string" ? node.textContent.trim() : "";
  }

  function updatePageSearchStatus() {
    if (!(pageSearchCountEl instanceof HTMLElement)) return;
    const total = pageSearchResults.length;
    const currentIndex = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    if (btnPageSearchPrev instanceof HTMLButtonElement) btnPageSearchPrev.disabled = total <= 1 || currentIndex <= 0;
    if (btnPageSearchNext instanceof HTMLButtonElement) {
      btnPageSearchNext.disabled = total <= 1 || currentIndex >= total - 1;
    }
    if (total === 0) {
      pageSearchCountEl.textContent = "0/0";
      return;
    }
    const current = currentIndex + 1;
    pageSearchCountEl.textContent = `${current}/${total}`;
  }

  function appendCwdMetaLines(metaLines, meta) {
    if (!meta) return;
    const cwd = typeof meta.cwd === "string" ? meta.cwd : "";
    const displayCwd = typeof meta.displayCwd === "string" ? meta.displayCwd : "";
    if (cwd && displayCwd && cwd !== displayCwd) {
      if (getEffectivePathMode() === "relocated") {
        metaLines.push(`CWD: ${displayCwd}`);
        metaLines.push(`${i18n.originalCwd || "Recorded CWD"}: ${cwd}`);
      } else {
        metaLines.push(`CWD: ${cwd}`);
        metaLines.push(`${i18n.relocatedCwd || "Target CWD"}: ${displayCwd}`);
      }
      return;
    }
    if (cwd) metaLines.push(`CWD: ${cwd}`);
  }

  function requestRenderAfterCurrent(callback) {
    if (typeof callback === "function") renderAfterCurrentCallbacks.push(callback);
    if (renderAfterCurrentFrame) return;
    renderAfterCurrentFrame = requestAnimationFrame(() => {
      renderAfterCurrentFrame = 0;
      render();
      flushRenderAfterCurrentCallbacks();
    });
  }

  function renderOrRequestAfterCurrent(callback) {
    if (renderDepth > 0) {
      requestRenderAfterCurrent(callback);
      return;
    }
    render();
    if (typeof callback === "function") callback();
  }

  function cancelRenderAfterCurrent() {
    if (renderAfterCurrentFrame) {
      cancelAnimationFrame(renderAfterCurrentFrame);
      renderAfterCurrentFrame = 0;
    }
    renderAfterCurrentCallbacks = [];
  }

  function flushRenderAfterCurrentCallbacks() {
    const callbacks = renderAfterCurrentCallbacks;
    renderAfterCurrentCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (_error) {
        // Ignore post-render restoration failures so a stale anchor cannot break the view.
      }
    }
  }

  function render() {
    if (renderDepth > 0) {
      requestRenderAfterCurrent();
      return;
    }
    renderDepth += 1;
    try {
    if (lazyImageObserver) lazyImageObserver.disconnect();
    resetDeferredRenderWork({ nextGeneration: true });
    prepareTimeGuideForTimelineRender();
    if (annotationEl) annotationEl.textContent = "";
    metaEl.textContent = "";
    timelineEl.textContent = "";
    stickyUserRows = [];
    activeStickyUserKey = null;
    hideStickyUserOverlay();
    pageSearchMatches = [];
    pageSearchResults = [];
    activePageSearchResultIndex = -1;
    patchEntrySummaryById.clear();
    document.body.classList.toggle("chatTimeGuideEnabled", timeGuideEnabled === true);
    if (!model) {
      currentTurnSummaryById = new Map();
      resetRunningTurnIndicators();
      scheduleStickyUserOverlayUpdate();
      return;
    }

    renderAnnotationHeader(model.annotation);

    // Render session metadata at the top.
    const metaLines = [];
    if (model.meta && model.meta.timestampIso) metaLines.push(`Start: ${formatIsoYmdHm(model.meta.timestampIso)}`);
    appendCwdMetaLines(metaLines, model.meta);
    if (model.meta && model.meta.originator) metaLines.push(`Originator: ${model.meta.originator}`);
    if (model.meta && model.meta.cliVersion) metaLines.push(`CLI: ${model.meta.cliVersion}`);
    if (model.meta && model.meta.modelProvider) metaLines.push(`Model Provider: ${model.meta.modelProvider}`);
    if (model.meta && model.meta.source) metaLines.push(`Source: ${model.meta.source}`);
    if (model.sessionLocation && model.sessionLocation.archiveState === "archived") {
      metaLines.push(i18n.sessionLocationArchived || "Archived");
    }
    if (metaLines.length > 0) metaEl.textContent = metaLines.join(" | ");

    const items = Array.isArray(model.items) ? model.items : [];
    // Build navigation metadata between messages before rendering.
    messageNavMap = buildMessageNavMap(items);
    patchGroupNavMap = buildPatchGroupNavMap(items);
    const turnTimelineEnabled = isTurnTimelineEnabled();
    const turnTimelineLive = isTurnTimelineLive();
    const turnSummaryById = turnTimelineEnabled ? buildTurnSummaryMap(model.turns) : new Map();
    const turnRunKeyByItemIndex = turnTimelineEnabled ? buildTurnRunKeyByItemIndex(items, turnSummaryById) : new Map();
    currentTurnSummaryById = turnSummaryById;
    resetRunningTurnIndicators({ keepFallback: turnTimelineLive });
    const useStickyUserPrompt = stickyUserPromptEnabled === true;
    const renderedEntries = [];
    for (const [itemIndex, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      const rendered = renderItem(item, itemIndex);
      if (!rendered) continue;
      const rawTurnId = getTimelineItemTurnId(item);
      const turn = rawTurnId ? turnSummaryById.get(rawTurnId) : null;
      const emptyActiveCandidate = isBasicModeEmptyActiveTurnCandidate(turn, rawTurnId);
      const turnId = turn && !emptyActiveCandidate ? rawTurnId : "";
      if (!turnId && rendered instanceof HTMLElement) delete rendered.dataset.turnId;
      const turnRunKey = turnId ? turnRunKeyByItemIndex.get(itemIndex) || `run-${itemIndex}` : "";
      renderedEntries.push({ item, itemIndex, rendered, turnId, turn, turnRunKey });
    }
    const liveRunningTurnId = turnTimelineLive ? normalizeTurnId(model && model.liveRunningTurnId) : "";
    const liveRunningTurn = liveRunningTurnId ? turnSummaryById.get(liveRunningTurnId) : null;
    const runningActivityState = buildRunningTurnActivityState(liveRunningTurn, liveRunningTurnId);
    const runningAnchorEntry = findRunningTurnAnchorEntry(renderedEntries, liveRunningTurnId);
    let runningAnchorInserted = false;
    let currentTurnBlock = null;
    let currentTurnBlockKey = "";
    let currentTurnSection = null;
    for (const [entryIndex, entry] of renderedEntries.entries()) {
      const { item, rendered, turnId, turn, turnRunKey } = entry;
      const turnBlockKey = turnId ? `${turnId}:${turnRunKey || "run"}` : "";
      const nextTurnId = getNextRenderedTurnId(renderedEntries, entryIndex);
      const isTurnStart = !!turnId && currentTurnBlockKey !== turnBlockKey;
      if (!turnId) {
        currentTurnBlock = null;
        currentTurnBlockKey = "";
        currentTurnSection = null;
        timelineEl.appendChild(rendered);
        continue;
      }

      if (isTurnStart) {
        currentTurnBlock = createTurnBlock(turn, turnId, turnRunKey);
        currentTurnBlock.appendChild(renderTurnStartMarker(turn, turnId, turnRunKey));
        timelineEl.appendChild(currentTurnBlock);
        currentTurnBlockKey = turnBlockKey;
        currentTurnSection = null;
      }

      const turnContainer = currentTurnBlock || timelineEl;
      if (!useStickyUserPrompt) {
        turnContainer.appendChild(rendered);
        runningAnchorInserted = appendRunningTurnAnchorAfterEntry(
          turnContainer,
          entry,
          runningAnchorEntry,
          runningAnchorInserted,
          runningActivityState,
        );
        runningAnchorInserted = appendIndependentRunningTurnAnchorIfNeeded(
          turnContainer,
          entry,
          liveRunningTurnId,
          runningAnchorEntry,
          runningAnchorInserted,
          nextTurnId,
          runningActivityState,
        );
        if (appendTurnEndMarkerIfNeeded(turnContainer, turn, turnId, nextTurnId, turnRunKey)) {
          currentTurnBlock = null;
          currentTurnBlockKey = "";
        }
        continue;
      }

      if (isStickyUserTurnStart(item)) {
        currentTurnSection = createChatTurnSection("user");
        currentTurnSection.appendChild(rendered);
        turnContainer.appendChild(currentTurnSection);
        const wasRunningAnchorInserted = runningAnchorInserted;
        runningAnchorInserted = appendRunningTurnAnchorAfterEntry(
          turnContainer,
          entry,
          runningAnchorEntry,
          runningAnchorInserted,
          runningActivityState,
        );
        if (!wasRunningAnchorInserted && runningAnchorInserted) currentTurnSection = null;
        const wasIndependentAnchorInserted = runningAnchorInserted;
        runningAnchorInserted = appendIndependentRunningTurnAnchorIfNeeded(
          turnContainer,
          entry,
          liveRunningTurnId,
          runningAnchorEntry,
          runningAnchorInserted,
          nextTurnId,
          runningActivityState,
        );
        if (!wasIndependentAnchorInserted && runningAnchorInserted) currentTurnSection = null;
        if (appendTurnEndMarkerIfNeeded(turnContainer, turn, turnId, nextTurnId, turnRunKey)) {
          currentTurnSection = null;
          currentTurnBlock = null;
          currentTurnBlockKey = "";
        }
        continue;
      }

      if (!currentTurnSection) {
        currentTurnSection = createChatTurnSection("prelude");
        turnContainer.appendChild(currentTurnSection);
      }
      currentTurnSection.appendChild(rendered);
      const wasRunningAnchorInserted = runningAnchorInserted;
      runningAnchorInserted = appendRunningTurnAnchorAfterEntry(
        turnContainer,
        entry,
        runningAnchorEntry,
        runningAnchorInserted,
        runningActivityState,
      );
      if (!wasRunningAnchorInserted && runningAnchorInserted) currentTurnSection = null;
      const wasIndependentAnchorInserted = runningAnchorInserted;
      runningAnchorInserted = appendIndependentRunningTurnAnchorIfNeeded(
        turnContainer,
        entry,
        liveRunningTurnId,
        runningAnchorEntry,
        runningAnchorInserted,
        nextTurnId,
        runningActivityState,
      );
      if (!wasIndependentAnchorInserted && runningAnchorInserted) currentTurnSection = null;
      if (appendTurnEndMarkerIfNeeded(turnContainer, turn, turnId, nextTurnId, turnRunKey)) {
        currentTurnSection = null;
        currentTurnBlock = null;
        currentTurnBlockKey = "";
      }
    }
    if (!runningAnchorInserted && turnTimelineLive && liveRunningTurnId && liveRunningTurn) {
      runningAnchorInserted = appendMinimalRunningTurnBlock(liveRunningTurn, liveRunningTurnId, runningActivityState);
    }
    if (turnTimelineLive) {
      syncRunningTurnFallbackChip(liveRunningTurn, liveRunningTurnId, runningActivityState);
      syncRunningTurnElapsedTimer();
    } else {
      resetRunningTurnIndicators({ keepFallback: false });
    }
    refreshStickyUserRows();
    schedulePatchLayoutSync();
    updateTimeGuide({ afterPaint: true, rebuildItems: true });
    scheduleStickyUserOverlayUpdate();
    syncPageSearchRoleFilters({ reset: false });
    if (isPageSearchOpen()) refreshPageSearchResults(consumePendingPageSearchRefreshOptions());
    else {
      renderPageSearchResults();
      updatePageSearchStatus();
    }
    } finally {
      renderDepth = Math.max(0, renderDepth - 1);
    }
  }

  function buildTurnSummaryMap(turns) {
    const out = new Map();
    if (!Array.isArray(turns)) return out;
    for (const turn of turns) {
      const id = normalizeTurnId(turn && turn.id);
      if (!id) continue;
      out.set(id, turn);
    }
    return out;
  }

  function isBasicModeEmptyActiveTurnCandidate(turn, fallbackTurnId) {
    if (isTurnTimelineLive()) return false;
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!turnId || !turn || typeof turn !== "object") return false;
    const itemCount = typeof turn.itemCount === "number" && Number.isFinite(turn.itemCount) ? Math.max(0, Math.floor(turn.itemCount)) : 0;
    return itemCount === 0;
  }

  function buildTurnRunKeyByItemIndex(items, turnSummaryById) {
    const out = new Map();
    if (!Array.isArray(items) || !(turnSummaryById instanceof Map)) return out;
    let currentTurnId = "";
    let currentRunKey = "";
    for (const [itemIndex, item] of items.entries()) {
      const rawTurnId = normalizeTurnId(item && item.turnId);
      const turnId = rawTurnId && turnSummaryById.has(rawTurnId) ? rawTurnId : "";
      if (!turnId) {
        currentTurnId = "";
        currentRunKey = "";
        continue;
      }
      if (turnId !== currentTurnId) {
        currentTurnId = turnId;
        currentRunKey = buildStableTurnRunKey(turnId, item, itemIndex);
      }
      out.set(itemIndex, currentRunKey);
    }
    return out;
  }

  function buildStableTurnRunKey(turnId, item, itemIndex) {
    const cardKey = buildTimelineCardKey(item, itemIndex);
    const signature = `${normalizeTurnId(turnId)}\n${cardKey || `item:${itemIndex}`}`;
    return `run-${stableStringHash(signature)}`;
  }

  function getTimelineItemTurnId(item) {
    if (!isTurnTimelineEnabled()) return "";
    return normalizeTurnId(item && item.turnId);
  }

  function normalizeTurnId(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256);
  }

  function normalizeTurnRunKey(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  }

  function getTurnSummaryById(turnId) {
    const normalizedTurnId = normalizeTurnId(turnId);
    return normalizedTurnId ? currentTurnSummaryById.get(normalizedTurnId) || null : null;
  }

  function canCollapseTurn(turn, fallbackTurnId) {
    if (!isTurnTimelineEnabled()) return false;
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!turnId || isLiveRunningTurn(turn, turnId)) return false;
    const status = normalizeTurnDisplayStatus((turn && turn.displayStatus) || (turn && turn.status));
    return status === "completed";
  }

  function isTurnManuallyCollapsed(turnId) {
    const normalizedTurnId = normalizeTurnId(turnId);
    return !!(normalizedTurnId && collapsedTurnIds.has(normalizedTurnId));
  }

  function isTurnTemporarilyExpandedForSearch(turnId) {
    return isTurnTimelineEnabled() && pageSearchTemporaryTurnExpansionActive && isTurnManuallyCollapsed(turnId);
  }

  function isTurnCollapsed(turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!canCollapseTurn(turn, turnId)) return false;
    if (isTurnTemporarilyExpandedForSearch(turnId)) return false;
    return isTurnManuallyCollapsed(turnId);
  }

  function setTurnCollapsed(turnId, collapsed, options = {}) {
    if (!isTurnTimelineEnabled()) return false;
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) return false;
    const turn = getTurnSummaryById(normalizedTurnId);
    if (!canCollapseTurn(turn, normalizedTurnId)) return false;
    const anchor = captureTurnToggleScrollAnchor(normalizedTurnId, options.runKey);
    const changed = withPageSearchContentMutation(
      () => {
        const before = collapsedTurnIds.has(normalizedTurnId);
        if (collapsed) collapsedTurnIds.add(normalizedTurnId);
        else collapsedTurnIds.delete(normalizedTurnId);
        return before !== collapsedTurnIds.has(normalizedTurnId);
      },
      { refreshOptions: buildActivePageSearchRefreshOptions({ preserveIndex: true, reveal: false }) },
    );
    if (!changed) return false;
    const restore = () => restoreCapturedTurnToggleScrollAnchor(anchor);
    renderOrRequestAfterCurrent(restore);
    return true;
  }

  function captureTurnToggleScrollAnchor(turnId, runKey) {
    const root = getScrollRoot();
    if (!(root instanceof HTMLElement)) return null;
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId || !(timelineEl instanceof HTMLElement)) return null;
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const runSelector = normalizedRunKey ? `[data-turn-run-key="${cssEscape(normalizedRunKey)}"]` : "";
    const marker = timelineEl.querySelector(
      `.turnStartMarker[data-turn-id="${cssEscape(normalizedTurnId)}"]${runSelector}, .turnCollapsedSummaryMarker[data-turn-id="${cssEscape(normalizedTurnId)}"]${runSelector}`,
    );
    if (!(marker instanceof HTMLElement)) return null;
    const rootRect = root.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    return {
      turnId: normalizedTurnId,
      runKey: normalizedRunKey,
      offsetTop: markerRect.top - rootRect.top,
    };
  }

  function restoreCapturedTurnToggleScrollAnchor(anchor) {
    if (!anchor || !anchor.turnId) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = getScrollRoot();
        if (!(root instanceof HTMLElement) || !(timelineEl instanceof HTMLElement)) return;
        const normalizedRunKey = normalizeTurnRunKey(anchor.runKey);
        const runSelector = normalizedRunKey ? `[data-turn-run-key="${cssEscape(normalizedRunKey)}"]` : "";
        const marker = timelineEl.querySelector(
          `.turnStartMarker[data-turn-id="${cssEscape(anchor.turnId)}"]${runSelector}, .turnCollapsedSummaryMarker[data-turn-id="${cssEscape(anchor.turnId)}"]${runSelector}`,
        );
        if (!(marker instanceof HTMLElement)) return;
        const rootRect = root.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        const nextOffsetTop = markerRect.top - rootRect.top;
        const delta = nextOffsetTop - anchor.offsetTop;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          root.scrollTop += delta;
        }
      });
    });
  }

  function ensureTurnExpandedForReveal(turnId, options = {}) {
    if (!isTurnTimelineEnabled()) return false;
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId || !collapsedTurnIds.has(normalizedTurnId)) return false;
    const turn = getTurnSummaryById(normalizedTurnId);
    if (!canCollapseTurn(turn, normalizedTurnId)) {
      collapsedTurnIds.delete(normalizedTurnId);
      return false;
    }
    collapsedTurnIds.delete(normalizedTurnId);
    if (options.render !== false) render();
    return true;
  }

  function getTurnIdForItemIndex(itemIndex) {
    const safeIndex = Number.isFinite(Number(itemIndex)) ? Math.max(0, Math.floor(Number(itemIndex))) : -1;
    const items = model && Array.isArray(model.items) ? model.items : [];
    return safeIndex >= 0 ? getTimelineItemTurnId(items[safeIndex]) : "";
  }

  function getTurnIdForMessageIndex(messageIndex) {
    const safeMessageIndex = Number.isFinite(Number(messageIndex)) ? Math.max(0, Math.floor(Number(messageIndex))) : -1;
    if (safeMessageIndex < 0 || !model || !Array.isArray(model.items)) return "";
    for (const item of model.items) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message" && item.messageIndex === safeMessageIndex) return getTimelineItemTurnId(item);
    }
    return "";
  }

  function getTurnIdForPatchEntryId(entryId) {
    const normalizedEntryId = typeof entryId === "string" ? entryId.trim() : "";
    if (!normalizedEntryId || !model || !Array.isArray(model.items)) return "";
    for (const item of model.items) {
      if (!item || item.type !== "patchGroup" || !Array.isArray(item.entries)) continue;
      const hasEntry = item.entries.some((entry) => entry && entry.id === normalizedEntryId);
      if (hasEntry) return getTimelineItemTurnId(item);
    }
    return "";
  }

  function getTurnIdForPatchRevealTarget(target) {
    if (!target || !model || !Array.isArray(model.items)) return "";
    const entryTurnId = getTurnIdForPatchEntryId(typeof target.entryId === "string" ? target.entryId : "");
    if (entryTurnId) return entryTurnId;
    if (typeof target.messageIndex === "number") {
      const turnId = getTurnIdForMessageIndex(target.messageIndex);
      if (turnId) return turnId;
    }
    const wantedPaths = [target.filePath, target.movePath].filter((value) => typeof value === "string" && value.trim());
    if (wantedPaths.length === 0) return "";
    for (const item of model.items) {
      if (!item || item.type !== "patchGroup" || !Array.isArray(item.entries)) continue;
      const hasPath = item.entries.some((entry) => {
        const paths = [entry && entry.path, entry && entry.movePath, entry && entry.displayPath, entry && entry.moveDisplayPath];
        return paths.some((pathValue) =>
          wantedPaths.some((wantedPath) => pathMatchesRevealTarget(pathValue || "", wantedPath)),
        );
      });
      if (hasPath) return getTimelineItemTurnId(item);
    }
    return "";
  }

  function getTurnIdForElement(element) {
    if (!(element instanceof Element)) return "";
    const carrier = element.closest("[data-turn-id]");
    return carrier instanceof HTMLElement ? normalizeTurnId(carrier.dataset.turnId) : "";
  }

  function resolveTurnIdForAnchor(anchor) {
    if (!anchor || typeof anchor !== "object" || !model || !Array.isArray(model.items)) return "";
    const directTurnId = normalizeTurnId(anchor.turnId);
    if (isTimelineMarkerScrollAnchor(anchor) && directTurnId) return directTurnId;
    const cardKey = typeof anchor.cardKey === "string" ? anchor.cardKey : "";
    if (cardKey) {
      for (const [itemIndex, item] of model.items.entries()) {
        if (buildTimelineCardKey(item, itemIndex) === cardKey) return getTimelineItemTurnId(item);
      }
    }
    return getTurnIdForItemIndex(anchor.itemIndex) || directTurnId;
  }

  function getNextRenderedTurnId(entries, entryIndex) {
    if (!Array.isArray(entries)) return "";
    for (let i = entryIndex + 1; i < entries.length; i += 1) {
      const next = entries[i];
      if (!next) continue;
      return normalizeTurnId(next.turnId);
    }
    return "";
  }

  function appendTurnEndMarkerIfNeeded(container, turn, fallbackTurnId, nextTurnId, runKey) {
    if (!(container instanceof HTMLElement)) return false;
    const turnEndMarker = renderTurnEndMarkerIfNeeded(turn, fallbackTurnId, nextTurnId, runKey);
    if (!(turnEndMarker instanceof HTMLElement)) return false;
    container.appendChild(turnEndMarker);
    return true;
  }

  function appendMinimalRunningTurnBlock(turn, fallbackTurnId, activityState) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!turnId || !(timelineEl instanceof HTMLElement)) return false;
    const minimalRunKey = "run-live";
    const minimalBlock = createTurnBlock(turn, turnId, minimalRunKey);
    minimalBlock.appendChild(renderTurnStartMarker(turn, turnId, minimalRunKey));
    const anchorRow = renderRunningTurnAnchorRow(turn, turnId, "independent", activityState, minimalRunKey);
    if (anchorRow instanceof HTMLElement) minimalBlock.appendChild(anchorRow);
    timelineEl.appendChild(minimalBlock);
    return true;
  }

  function createTurnBlock(turn, fallbackTurnId, runKey) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const status = normalizeTurnDisplayStatus(turn && (turn.displayStatus || turn.status));
    const collapsible = canCollapseTurn(turn, turnId);
    const collapsed = isTurnCollapsed(turn, turnId);
    const block = el("div", {
      className: `turnBlock turnBlock-${status}${collapsed ? " turnBlock-collapsed" : ""}`,
    });
    if (turnId) block.dataset.turnId = turnId;
    if (normalizedRunKey) block.dataset.turnRunKey = normalizedRunKey;
    if (turnId) block.id = buildTurnBodyRegionId(turnId, normalizedRunKey);
    block.dataset.turnStatus = status;
    if (collapsible) block.dataset.turnCollapsible = "true";
    if (collapsed) block.dataset.turnCollapsed = "true";
    return block;
  }

  function renderTurnStartMarker(turn, fallbackTurnId, runKey) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const status = normalizeTurnDisplayStatus(turn && (turn.displayStatus || turn.status));
    const collapsed = isTurnCollapsed(turn, turnId);
    const row = el("div", {
      className: `turnMarker turnStartMarker turnMarker-${status}${collapsed ? " turnCollapsedSummaryMarker" : ""}`,
    });
    if (turnId) row.dataset.turnId = turnId;
    if (normalizedRunKey) row.dataset.turnRunKey = normalizedRunKey;
    row.dataset.turnBoundary = "start";

    const line = el("div", { className: "turnMarkerLine" });
    const main = el("div", { className: `turnMarkerMain${collapsed ? " turnCollapsedSummaryMain" : ""}` });
    let collapsedCountsEl = null;
    main.appendChild(renderTurnControlSlot(turn, turnId, "start"));
    const title = el("span", { className: "turnMarkerTitle" });
    title.textContent = buildTurnNumberLabel(turn, turnId);
    main.appendChild(title);

    const badge = el("span", { className: "turnMarkerBadge turnMarkerBadge-start" });
    badge.textContent = getSafeUiText(i18n.turnStart, "Start");
    main.appendChild(badge);

    const startText = buildTurnStartTimestampText(turn);
    if (startText) main.appendChild(el("span", { className: "turnMarkerMeta", textContent: startText }));
    if (collapsed) {
      const endBadge = el("span", { className: "turnMarkerBadge turnMarkerBadge-end" });
      endBadge.textContent = getSafeUiText(i18n.turnEnd, "End");
      main.appendChild(endBadge);

      const endText = buildTurnEndTimestampText(turn);
      if (endText) main.appendChild(el("span", { className: "turnMarkerMeta", textContent: endText }));

      const durationText = buildTurnCompletedDurationText(turn);
      if (durationText) main.appendChild(el("span", { className: "turnMarkerMeta", textContent: durationText }));

      const counts = buildTurnEndCounts(turn);
      if (counts.text) {
        collapsedCountsEl = el("div", { className: "turnMarkerCounts turnCollapsedSummaryCounts", textContent: counts.text });
      }
    } else {
      appendTurnCollapseStateBadge(main, turn, turnId);
    }
    line.appendChild(main);
    if (collapsedCountsEl) line.appendChild(collapsedCountsEl);
    row.appendChild(line);
    configureTurnMarkerToggle(row, turn, turnId, normalizedRunKey);
    return row;
  }

  function renderTurnEndMarkerIfNeeded(turn, fallbackTurnId, nextTurnId, runKey) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!turnId || nextTurnId === turnId) return null;
    return renderTurnEndMarker(turn, turnId, runKey);
  }

  function renderTurnEndMarker(turn, fallbackTurnId, runKey) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const status = getTurnEndStatus(turn);
    if (!turnId || !status) return null;
    const row = el("div", { className: `turnMarker turnEndMarker turnMarker-${status}` });
    row.dataset.turnId = turnId;
    if (normalizedRunKey) row.dataset.turnRunKey = normalizedRunKey;
    row.dataset.turnBoundary = "end";

    const line = el("div", { className: "turnMarkerLine" });
    const main = el("div", { className: "turnMarkerMain" });
    main.appendChild(renderTurnControlSlot(turn, turnId, "end"));
    const title = el("span", { className: "turnMarkerTitle" });
    title.textContent = buildTurnNumberLabel(turn, turnId);
    main.appendChild(title);

    const badge = el("span", { className: `turnMarkerBadge turnMarkerBadge-${status}` });
    badge.textContent = getTurnStatusLabel(status);
    main.appendChild(badge);

    const meta = buildTurnEndText(turn);
    if (meta) main.appendChild(el("span", { className: "turnMarkerMeta", textContent: meta }));
    appendTurnCollapseStateBadge(main, turn, turnId);
    line.appendChild(main);

    const counts = buildTurnEndCounts(turn);
    if (counts.text) {
      const countsEl = el("div", { className: "turnMarkerCounts", textContent: counts.text });
      line.appendChild(countsEl);
    }
    row.appendChild(line);
    return row;
  }

  function renderTurnControlSlot(turn, fallbackTurnId, boundary) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const slot = el("span", { className: "turnMarkerControlSlot" });
    slot.setAttribute("aria-hidden", "true");
    if (boundary === "start" && canCollapseTurn(turn, turnId)) {
      slot.appendChild(renderTurnCollapseIcon(turn, turnId));
      return slot;
    }
    slot.appendChild(el("span", { className: "turnMarkerControlSpacer" }));
    return slot;
  }

  function renderTurnCollapseIcon(turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const visualCollapsed = isTurnCollapsed(turn, turnId);
    const icon = el("span", { className: "turnCollapseIcon" });
    icon.innerHTML = visualCollapsed ? NAV_RIGHT_ICON_SVG : NAV_DOWN_ICON_SVG;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function configureTurnMarkerToggle(row, turn, fallbackTurnId, runKey) {
    if (!(row instanceof HTMLElement)) return;
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    if (!canCollapseTurn(turn, turnId)) return;
    const label = buildTurnCollapseActionLabel(turn, turnId);
    row.classList.add("turnMarker-toggle");
    row.dataset.turnToggle = "true";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-label", label);
    row.setAttribute("aria-expanded", isTurnCollapsed(turn, turnId) ? "false" : "true");
    row.setAttribute("aria-controls", buildTurnBodyRegionId(turnId, normalizedRunKey));
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setTurnCollapsed(turnId, !isTurnManuallyCollapsed(turnId), { runKey: normalizedRunKey });
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      event.stopPropagation();
      setTurnCollapsed(turnId, !isTurnManuallyCollapsed(turnId), { runKey: normalizedRunKey });
    });
  }

  function buildTurnCollapseActionLabel(turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const manualCollapsed = isTurnManuallyCollapsed(turnId);
    const sequenceNumber = getTurnSequenceNumber(turn);
    const turnLabel = sequenceNumber > 0 ? String(sequenceNumber) : buildTurnNumberLabel(turn, turnId);
    return manualCollapsed
      ? formatTemplate(getSafeUiText(i18n.turnExpand, "Expand turn {0}"), turnLabel)
      : formatTemplate(getSafeUiText(i18n.turnCollapse, "Collapse turn {0}"), turnLabel);
  }

  function buildTurnBodyRegionId(turnId, runKey) {
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const safeTurnId = normalizedTurnId.replace(/[^A-Za-z0-9_-]/g, "-") || "unknown";
    const safeRunKey = normalizedRunKey.replace(/[^A-Za-z0-9_-]/g, "-");
    return `turn-body-${safeTurnId}${safeRunKey ? `-${safeRunKey}` : ""}`;
  }

  function appendTurnCollapseStateBadge(container, turn, fallbackTurnId) {
    if (!(container instanceof Element)) return;
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!canCollapseTurn(turn, turnId) || !isTurnManuallyCollapsed(turnId)) return;
    const temporary = isTurnTemporarilyExpandedForSearch(turnId);
    const text = temporary
      ? getSafeUiText(i18n.turnExpandedForSearch, "Expanded for search")
      : getSafeUiText(i18n.turnCollapsed, "Collapsed");
    container.appendChild(
      el("span", {
        className: `turnMarkerBadge turnCollapseStateBadge${temporary ? " turnCollapseStateBadge-search" : ""}`,
        textContent: text,
      }),
    );
  }

  function getTurnEndStatus(turn) {
    const displayStatus = normalizeTurnDisplayStatus(turn && turn.displayStatus);
    if (displayStatus === "running") return "";
    const status = normalizeTurnDisplayStatus((turn && turn.status) || displayStatus);
    return isTerminalTurnEndStatus(status) ? status : "";
  }

  function isTerminalTurnEndStatus(status) {
    return status === "completed" || status === "interrupted" || status === "rolledBack";
  }

  function normalizeTurnDisplayStatus(value) {
    if (value === "running" || value === "completed" || value === "interrupted" || value === "rolledBack") return value;
    if (value === "incomplete" || value === "unknown") return value;
    return "unknown";
  }

  function getTurnStatusLabel(status) {
    if (status === "running") return getSafeUiText(i18n.turnRunning, "Running");
    if (status === "completed") return getSafeUiText(i18n.turnCompleted, "Completed");
    if (status === "interrupted") return getSafeUiText(i18n.turnInterrupted, "Interrupted");
    if (status === "rolledBack") return getSafeUiText(i18n.turnRolledBack, "Rolled back");
    if (status === "incomplete") return getSafeUiText(i18n.turnIncomplete, "Incomplete");
    return getSafeUiText(i18n.turnUnknown, "Unknown");
  }

  function getTurnSequenceNumber(turn) {
    const value = turn && typeof turn.sequenceNumber === "number" && Number.isFinite(turn.sequenceNumber)
      ? Math.floor(turn.sequenceNumber)
      : 0;
    return value > 0 ? value : 0;
  }

  function buildTurnNumberLabel(turn, fallbackTurnId) {
    const sequenceNumber = getTurnSequenceNumber(turn);
    if (sequenceNumber > 0) {
      return formatTemplate(getSafeUiText(i18n.turnNumberLabel, "Turn {0}"), sequenceNumber);
    }
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    return turnId
      ? formatTemplate(getSafeUiText(i18n.turnNumberLabel || i18n.turnRangeLabel, "Turn {0}"), "?")
      : getSafeUiText(i18n.turnLabel, "Turn");
  }

  function buildTurnStartTimestampText(turn) {
    const startedAt = typeof (turn && turn.startedAtIso) === "string" ? turn.startedAtIso : "";
    return startedAt ? formatIsoYmdHms(startedAt) : "";
  }

  function buildTurnEndText(turn) {
    const timestamp = buildTurnEndTimestampText(turn);
    const parts = [];
    if (timestamp) parts.push(timestamp);
    const durationText = buildTurnCompletedDurationText(turn);
    if (durationText) parts.push(durationText);
    return parts.join("  ");
  }

  function buildTurnEndTimestampText(turn) {
    const completedAt = typeof (turn && turn.completedAtIso) === "string" ? turn.completedAtIso : "";
    const updatedAt = typeof (turn && turn.updatedAtIso) === "string" ? turn.updatedAtIso : "";
    const timestamp = completedAt || updatedAt;
    return timestamp ? formatIsoYmdHms(timestamp) : "";
  }

  function buildTurnRunningLastActivityText(turn) {
    const updatedAt = typeof (turn && turn.updatedAtIso) === "string" ? turn.updatedAtIso : "";
    const startedAt = typeof (turn && turn.startedAtIso) === "string" ? turn.startedAtIso : "";
    const timestamp = updatedAt || startedAt;
    return timestamp
      ? formatTemplate(getSafeUiText(i18n.turnLastActivity, "Last activity {0}"), formatIsoYmdHms(timestamp))
      : "";
  }

  function buildTurnCompletedDurationText(turn) {
    const status = normalizeTurnDisplayStatus(turn && turn.status);
    if (status !== "completed") return "";
    const durationText = buildDurationTextBetweenIso(turn && turn.startedAtIso, turn && turn.completedAtIso);
    return durationText ? formatTemplate(getSafeUiText(i18n.turnDuration, "Duration {0}"), durationText) : "";
  }

  function buildTurnElapsedText(turn, nowMs = Date.now()) {
    const durationText = buildDurationTextSinceIso(turn && turn.startedAtIso, nowMs);
    return durationText ? formatTemplate(getSafeUiText(i18n.turnElapsed, "Elapsed {0}"), durationText) : "";
  }

  function buildDurationTextBetweenIso(startIso, endIso) {
    const startMs = parseTurnTimestampMs(startIso);
    const endMs = parseTurnTimestampMs(endIso);
    if (startMs === null || endMs === null || endMs < startMs) return "";
    return formatTurnDuration(endMs - startMs);
  }

  function buildDurationTextSinceIso(startIso, nowMs = Date.now()) {
    const startMs = parseTurnTimestampMs(startIso);
    const endMs = Number(nowMs);
    if (startMs === null || !Number.isFinite(endMs)) return "";
    if (endMs < startMs) return "";
    return formatTurnDuration(endMs - startMs);
  }

  function parseTurnTimestampMs(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  function formatTurnDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return "";
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    if (totalSeconds < 60) {
      return formatTemplate(getSafeUiText(i18n.turnDurationSeconds, "{0}s"), totalSeconds);
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
      return formatTemplate(
        getSafeUiText(i18n.turnDurationMinutesSeconds, "{0}m {1}s"),
        totalMinutes,
        totalSeconds % 60,
      );
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    return formatTemplate(getSafeUiText(i18n.turnDurationHoursMinutes, "{0}h {1}m"), hours, minutes);
  }

  function isLiveRunningTurn(turn, fallbackTurnId) {
    if (!isTurnTimelineLive()) return false;
    const liveTurnId = normalizeTurnId(model && model.liveRunningTurnId);
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    return !!(
      liveTurnId &&
      turnId &&
      liveTurnId === turnId &&
      normalizeTurnDisplayStatus(turn && (turn.displayStatus || turn.status)) === "running"
    );
  }

  function findRunningTurnAnchorEntry(entries, liveRunningTurnId) {
    if (!isTurnTimelineLive()) return null;
    const turnId = normalizeTurnId(liveRunningTurnId);
    if (!turnId || !Array.isArray(entries)) return null;
    let meaningfulCandidate = null;
    let patchGroupCandidate = null;
    for (const entry of entries) {
      if (!entry || entry.turnId !== turnId) continue;
      if (!isRunningTurnAnchorCandidate(entry)) continue;
      if (isPatchGroupRunningTurnAnchorCandidate(entry)) {
        patchGroupCandidate = entry;
        continue;
      }
      meaningfulCandidate = entry;
    }
    return meaningfulCandidate || patchGroupCandidate;
  }

  function isRunningTurnAnchorCandidate(entry) {
    const item = entry && entry.item;
    if (!item || typeof item !== "object") return false;
    if (item.type === "environment") return false;
    return entry.rendered instanceof HTMLElement && entry.rendered.classList.contains("row");
  }

  function isPatchGroupRunningTurnAnchorCandidate(entry) {
    const item = entry && entry.item;
    if (item && item.type === "patchGroup") return true;
    const rendered = entry && entry.rendered;
    return rendered instanceof HTMLElement && rendered.dataset.itemType === "patchGroup";
  }

  function buildRunningTurnActivityState(turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!isTurnTimelineLive() || prefersReducedMotion() || !turnId || !isLiveRunningTurn(turn, turnId)) {
      return { flash: false, signature: "", key: "" };
    }
    const key = buildRunningTurnActivityKey(turnId);
    const signature = buildRunningTurnActivitySignature(turn, turnId);
    const previous = runningTurnActivitySignatures.get(key) || "";
    return {
      flash: !!(previous && signature && previous !== signature),
      signature,
      key,
    };
  }

  function buildRunningTurnActivityKey(turnId) {
    const fsPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
    return `${fsPath}\n${normalizeTurnId(turnId)}`;
  }

  function buildRunningTurnActivitySignature(turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const updatedAt = typeof (turn && turn.updatedAtIso) === "string" ? turn.updatedAtIso.trim() : "";
    const lastItemIndex = normalizeActivityNumber(turn && turn.lastItemIndex);
    const itemCount = normalizeActivityNumber(turn && turn.itemCount);
    return [turnId, updatedAt, lastItemIndex, itemCount].join("|");
  }

  function normalizeActivityNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(Math.max(0, Math.floor(numeric))) : "";
  }

  function trimRunningTurnActivitySignatures() {
    const maxEntries = 64;
    while (runningTurnActivitySignatures.size > maxEntries) {
      const firstKey = runningTurnActivitySignatures.keys().next().value;
      if (!firstKey) break;
      runningTurnActivitySignatures.delete(firstKey);
    }
  }

  function renderRunningTurnChip(turn, fallbackTurnId, placement, activityState) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!isTurnTimelineLive() || !isLiveRunningTurn(turn, turnId)) return null;
    const chip = el("span", { className: `runningTurnChip runningTurnChip-${placement || "anchored"}` });
    chip.dataset.turnId = turnId;
    appendRunningTurnChipContent(chip, turn, turnId);
    applyRunningTurnActivityState(chip, activityState);
    applyRunningTurnChipTooltip(chip, turn, turnId, { includeJumpLabel: false });
    return chip;
  }

  function appendRunningTurnChipContent(container, turn, fallbackTurnId) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    container.appendChild(el("span", { className: "runningTurnChipTitle", textContent: buildTurnNumberLabel(turn, turnId) }));
    container.appendChild(
      el("span", {
        className: "runningTurnChipBadge",
        textContent: getSafeUiText(i18n.turnRunning, "Running"),
      }),
    );
    const elapsedText = buildTurnElapsedText(turn);
    const startedAt = typeof (turn && turn.startedAtIso) === "string" ? turn.startedAtIso : "";
    if (startedAt) {
      const elapsed = el("span", {
        className: "runningTurnChipElapsed runningTurnChipTime",
        textContent: elapsedText,
      });
      elapsed.dataset.turnStartedAt = startedAt;
      elapsed.dataset.pageSearchIgnore = "true";
      elapsed.dataset.turnElapsedText = elapsedText || "";
      elapsed.dataset.turnElapsedHidden = elapsedText ? "false" : "true";
      if (!elapsedText) {
        elapsed.hidden = true;
        elapsed.setAttribute("aria-hidden", "true");
      }
      container.appendChild(elapsed);
    }
    const activityText = buildTurnRunningLastActivityText(turn);
    if (activityText) {
      container.appendChild(el("span", { className: "runningTurnChipLastActivity runningTurnChipTime", textContent: activityText }));
    }
  }

  function buildRunningTurnChipTooltip(turn, fallbackTurnId, options = {}) {
    return options.includeJumpLabel ? getSafeUiText(i18n.turnJumpToRunning, "Jump to running turn") : "";
  }

  function applyRunningTurnChipTooltip(element, turn, fallbackTurnId, options = {}) {
    if (!(element instanceof HTMLElement)) return;
    element.removeAttribute("title");
    const tooltip = buildRunningTurnChipTooltip(turn, fallbackTurnId, options);
    if (tooltip) element.setAttribute("aria-label", tooltip);
    else element.removeAttribute("aria-label");
  }

  function applyRunningTurnActivityState(element, activityState) {
    if (!(element instanceof HTMLElement)) return;
    if (activityState && activityState.signature) element.dataset.activitySignature = activityState.signature;
    else delete element.dataset.activitySignature;
    restartRunningTurnActivityFlash(element, !!(activityState && activityState.flash));
    if (activityState && activityState.key && activityState.signature) {
      runningTurnActivitySignatures.set(activityState.key, activityState.signature);
      trimRunningTurnActivitySignatures();
    }
  }

  function restartRunningTurnActivityFlash(element, shouldFlash) {
    if (!(element instanceof HTMLElement)) return;
    const hadFlashClass = element.classList.contains("runningTurnChip-flash");
    element.classList.remove("runningTurnChip-flash");
    if (!shouldFlash) return;
    if (hadFlashClass) void element.offsetWidth;
    element.classList.add("runningTurnChip-flash");
  }

  function renderRunningTurnAnchorRow(turn, fallbackTurnId, placement, activityState, runKey) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    const normalizedRunKey = normalizeTurnRunKey(runKey);
    const safePlacement = placement === "independent" ? "independent" : "anchored";
    const chip = renderRunningTurnChip(turn, turnId, safePlacement, activityState);
    if (!(chip instanceof HTMLElement)) return;
    const row = el("div", { className: `runningTurnAnchorRow runningTurnAnchorRow-${safePlacement}` });
    if (turnId) {
      row.dataset.turnId = turnId;
      row.dataset.runningTurnAnchor = "true";
    }
    if (normalizedRunKey) row.dataset.turnRunKey = normalizedRunKey;
    row.appendChild(chip);
    runningTurnAnchorEl = row;
    return row;
  }

  function appendRunningTurnAnchorAfterEntry(parent, entry, runningAnchorEntry, inserted, activityState) {
    if (!isTurnTimelineLive() || inserted || !runningAnchorEntry || entry !== runningAnchorEntry) return inserted;
    if (!(parent instanceof HTMLElement)) return inserted;
    const anchorRow = renderRunningTurnAnchorRow(entry.turn, entry.turnId, "anchored", activityState, entry.turnRunKey);
    if (!(anchorRow instanceof HTMLElement)) return inserted;
    parent.appendChild(anchorRow);
    return true;
  }

  function appendIndependentRunningTurnAnchorIfNeeded(
    parent,
    entry,
    liveRunningTurnId,
    runningAnchorEntry,
    inserted,
    nextTurnId,
    activityState,
  ) {
    if (!isTurnTimelineLive() || inserted || runningAnchorEntry || !(parent instanceof HTMLElement)) return inserted;
    const turnId = normalizeTurnId(entry && entry.turnId);
    if (!turnId || turnId !== normalizeTurnId(liveRunningTurnId) || nextTurnId === turnId) return inserted;
    const anchorRow = renderRunningTurnAnchorRow(entry.turn, turnId, "independent", activityState, entry.turnRunKey);
    if (!(anchorRow instanceof HTMLElement)) return inserted;
    parent.appendChild(anchorRow);
    return true;
  }

  function ensureRunningTurnFallbackChip() {
    if (runningTurnFallbackEl instanceof HTMLButtonElement) return runningTurnFallbackEl;
    const button = el("button", { type: "button", className: "runningTurnFallbackChip runningTurnChip" });
    button.dataset.pageSearchIgnore = "true";
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      scrollToRunningTurnAnchor();
    });
    document.body.appendChild(button);
    runningTurnFallbackEl = button;
    return button;
  }

  function syncRunningTurnFallbackChip(turn, fallbackTurnId, activityState) {
    const turnId = normalizeTurnId((turn && turn.id) || fallbackTurnId);
    if (!isTurnTimelineLive() || !turnId || !isLiveRunningTurn(turn, turnId) || !(runningTurnAnchorEl instanceof HTMLElement)) {
      hideRunningTurnFallbackChip();
      return;
    }
    const button = ensureRunningTurnFallbackChip();
    button.textContent = "";
    appendRunningTurnChipContent(button, turn, turnId);
    applyRunningTurnActivityState(button, activityState);
    button.dataset.turnId = turnId;
    applyRunningTurnChipTooltip(button, turn, turnId, { includeJumpLabel: true });
    scheduleRunningTurnFallbackUpdate();
  }

  function hideRunningTurnFallbackChip() {
    if (!(runningTurnFallbackEl instanceof HTMLElement)) return;
    runningTurnFallbackEl.classList.remove("runningTurnFallbackChip-visible");
    runningTurnFallbackEl.tabIndex = -1;
    runningTurnFallbackEl.setAttribute("aria-hidden", "true");
  }

  function resetRunningTurnIndicators(options = {}) {
    runningTurnAnchorEl = null;
    if (runningTurnFallbackFrame) {
      cancelAnimationFrame(runningTurnFallbackFrame);
      runningTurnFallbackFrame = 0;
    }
    if (options.keepFallback === true) {
      hideRunningTurnFallbackChip();
    } else if (runningTurnFallbackEl instanceof HTMLElement) {
      runningTurnFallbackEl.remove();
      runningTurnFallbackEl = null;
    }
    stopRunningTurnElapsedTimer();
  }

  function scheduleRunningTurnFallbackUpdate() {
    if (!isTurnTimelineLive()) {
      hideRunningTurnFallbackChip();
      return;
    }
    if (runningTurnFallbackFrame) cancelAnimationFrame(runningTurnFallbackFrame);
    runningTurnFallbackFrame = requestAnimationFrame(() => {
      runningTurnFallbackFrame = 0;
      updateRunningTurnFallbackVisibility();
    });
  }

  function updateRunningTurnFallbackVisibility() {
    if (!isTurnTimelineLive()) {
      hideRunningTurnFallbackChip();
      return;
    }
    const button = runningTurnFallbackEl;
    const anchor = runningTurnAnchorEl;
    if (!(button instanceof HTMLElement) || !(anchor instanceof HTMLElement) || !document.body.contains(anchor)) {
      hideRunningTurnFallbackChip();
      return;
    }
    const shouldShow =
      !isElementVisibleInScrollViewport(anchor) &&
      !isRunningTurnFallbackBlockedByPageSearch() &&
      !isRunningTurnFallbackBlockedByModal();
    button.classList.toggle("runningTurnFallbackChip-visible", shouldShow);
    button.tabIndex = shouldShow ? 0 : -1;
    button.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    if (shouldShow) updateRunningTurnElapsedTexts();
  }

  function isElementVisibleInScrollViewport(element) {
    if (!(element instanceof HTMLElement) || element.offsetParent === null) return false;
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.bottom > rootRect.top && rect.top < rootRect.bottom && rect.right > rootRect.left && rect.left < rootRect.right;
  }

  function isRunningTurnFallbackBlockedByPageSearch() {
    if (!isPageSearchOpen() || !(pageSearchBarEl instanceof HTMLElement)) return false;
    const rect = pageSearchBarEl.getBoundingClientRect();
    return rect.left <= 180 && rect.bottom >= window.innerHeight - 88;
  }

  function isRunningTurnFallbackBlockedByModal() {
    return !!(imagePreview || isImagePreviewOpen());
  }

  function syncRunningTurnElapsedTimer() {
    if (!isTurnTimelineLive()) {
      stopRunningTurnElapsedTimer();
      return;
    }
    updateRunningTurnElapsedTexts();
    if (document.visibilityState === "hidden" || !hasRunningTurnElapsedSource()) {
      stopRunningTurnElapsedTimer();
      return;
    }
    const intervalMs = 1000;
    if (runningTurnElapsedTimer && runningTurnElapsedTimerIntervalMs === intervalMs) return;
    stopRunningTurnElapsedTimer();
    runningTurnElapsedTimer = window.setInterval(() => {
      updateRunningTurnElapsedTexts();
      if (document.visibilityState === "hidden" || !hasRunningTurnElapsedSource()) {
        stopRunningTurnElapsedTimer();
      }
    }, intervalMs);
    runningTurnElapsedTimerIntervalMs = intervalMs;
  }

  function stopRunningTurnElapsedTimer() {
    if (!runningTurnElapsedTimer) return;
    window.clearInterval(runningTurnElapsedTimer);
    runningTurnElapsedTimer = 0;
    runningTurnElapsedTimerIntervalMs = 0;
  }

  function hasRunningTurnElapsedSource() {
    if (!isTurnTimelineLive()) return false;
    const liveTurnId = normalizeTurnId(model && model.liveRunningTurnId);
    const turn = getTurnSummaryById(liveTurnId);
    return !!(turn && typeof turn.startedAtIso === "string" && turn.startedAtIso.trim());
  }

  function updateRunningTurnElapsedTexts() {
    if (document.visibilityState === "hidden") return;
    const nowMs = Date.now();
    for (const target of getRunningTurnElapsedTargets()) {
      const startedAt = target.dataset.turnStartedAt || "";
      const durationText = buildDurationTextSinceIso(startedAt, nowMs);
      const nextText = durationText ? formatTemplate(getSafeUiText(i18n.turnElapsed, "Elapsed {0}"), durationText) : "";
      if (!durationText) {
        if (target.textContent !== "") target.textContent = "";
        if (!target.hidden) target.hidden = true;
        target.setAttribute("aria-hidden", "true");
        target.dataset.turnElapsedText = "";
        target.dataset.turnElapsedHidden = "true";
        continue;
      }
      if (target.hidden) target.hidden = false;
      target.removeAttribute("aria-hidden");
      if (target.textContent !== nextText) target.textContent = nextText;
      target.dataset.turnElapsedText = nextText;
      target.dataset.turnElapsedHidden = "false";
    }
  }

  function getRunningTurnElapsedTargets() {
    if (!isTurnTimelineLive()) return [];
    const liveTurnId = normalizeTurnId(model && model.liveRunningTurnId);
    if (!liveTurnId || !(document.body instanceof HTMLElement)) return [];
    const roots = [];
    if (timelineEl instanceof HTMLElement) roots.push(timelineEl);
    if (
      runningTurnFallbackEl instanceof HTMLElement &&
      runningTurnFallbackEl.classList.contains("runningTurnFallbackChip-visible")
    ) {
      roots.push(runningTurnFallbackEl);
    }
    const seen = new Set();
    const targets = [];
    for (const root of roots) {
      for (const element of Array.from(root.querySelectorAll(".runningTurnChipElapsed[data-turn-started-at]"))) {
        if (!(element instanceof HTMLElement) || seen.has(element) || !document.body.contains(element)) continue;
        const chip = element.closest(".runningTurnChip[data-turn-id]");
        if (!(chip instanceof HTMLElement) || normalizeTurnId(chip.dataset.turnId) !== liveTurnId) continue;
        if (chip.classList.contains("runningTurnFallbackChip") && !chip.classList.contains("runningTurnFallbackChip-visible")) {
          continue;
        }
        seen.add(element);
        targets.push(element);
      }
    }
    return targets;
  }

  function scrollToRunningTurnAnchor() {
    const anchor = runningTurnAnchorEl instanceof HTMLElement && document.body.contains(runningTurnAnchorEl)
      ? runningTurnAnchorEl
      : findRunningTurnFallbackScrollTarget();
    if (!(anchor instanceof HTMLElement)) return;
    scrollElementIntoRootView(anchor, { behavior: "smooth", block: "center" });
  }

  function findRunningTurnFallbackScrollTarget() {
    const turnId = normalizeTurnId(model && model.liveRunningTurnId);
    if (!turnId || !(timelineEl instanceof HTMLElement)) return null;
    const directAnchor = timelineEl.querySelector(`[data-running-turn-anchor="true"][data-turn-id="${cssEscape(turnId)}"]`);
    if (directAnchor instanceof HTMLElement) return directAnchor;
    const userCard = timelineEl.querySelector(`.row.user[data-turn-id="${cssEscape(turnId)}"]`);
    if (userCard instanceof HTMLElement) return userCard;
    const turnCards = getRenderedTimelineRows().filter((card) => card instanceof HTMLElement && card.dataset.turnId === turnId);
    return getLatestMeaningfulTimelineCard(turnCards);
  }

  function buildTurnEndCounts(turn) {
    if (!turn || typeof turn !== "object") return { text: "", tooltip: "" };
    const itemCount = normalizeCount(turn.itemCount);
    const toolCount = normalizeCount(turn.toolCount);
    const patchEntryCount = normalizeCount(turn.patchEntryCount);
    const usageRecordCount = normalizeCount(turn.usageRecordCount);
    const inputTokens = normalizeCount(turn.inputTokens);
    const outputTokens = normalizeCount(turn.outputTokens);
    const totalTokens = normalizeCount(turn.totalTokens);
    const parts = [];
    let hasTokenParts = false;
    if (itemCount > 0) parts.push(formatTemplate(getSafeUiText(i18n.turnItemCount, "{0} items"), itemCount));
    if (toolCount > 0) parts.push(formatTemplate(getSafeUiText(i18n.turnToolCount, "{0} tools"), toolCount));
    if (patchEntryCount > 0) {
      parts.push(formatTemplate(getSafeUiText(i18n.turnPatchCount, "{0} changes"), patchEntryCount));
    }
    if (inputTokens > 0) {
      parts.push(formatTemplate(getSafeUiText(i18n.turnTokenInput, "Input {0}"), getUsageNumber(inputTokens)));
      hasTokenParts = true;
    }
    if (outputTokens > 0) {
      parts.push(formatTemplate(getSafeUiText(i18n.turnTokenOutput, "Output {0}"), getUsageNumber(outputTokens)));
      hasTokenParts = true;
    }
    const totalAddsInformation = totalTokens > 0 && inputTokens + outputTokens !== totalTokens;
    if (totalAddsInformation) {
      parts.push(formatTemplate(getSafeUiText(i18n.turnTokenTotal, "Total {0}"), getUsageNumber(totalTokens)));
      hasTokenParts = true;
    }
    if (!hasTokenParts && usageRecordCount > 0) {
      parts.push(formatTemplate(getSafeUiText(i18n.turnUsageRecords, "Usage records {0}"), usageRecordCount));
    }
    return {
      text: parts.join(" / "),
      tooltip: "",
    };
  }

  function normalizeCount(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  function renderAnnotationHeader(annotation) {
    if (!annotationEl) return;
    const tags = Array.isArray(annotation && annotation.tags)
      ? annotation.tags.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
      : [];
    const note = typeof (annotation && annotation.note) === "string" ? annotation.note.trim() : "";

    const wrap = el("div", { className: "sessionHeader" });

    const tagsRow = el("div", { className: "sessionHeaderRow" });
    const tagsLabel = el("span", { className: "sessionHeaderLabel" });
    tagsLabel.textContent = `${i18n.annotationTags || "Tags"}:`;
    tagsRow.appendChild(tagsLabel);

    const tagsBody = el("div", { className: "sessionTagList" });
    if (tags.length === 0) {
      const none = el("span", { className: "sessionHeaderNone" });
      none.textContent = i18n.annotationNone || "None";
      tagsBody.appendChild(none);
    } else {
      for (const tag of tags) {
        const chip = el("span", { className: "sessionTagChipGroup" });

        const filterBtn = el("button", { type: "button", className: "sessionTagChip" });
        filterBtn.textContent = `#${tag}`;
        const filterLabel = i18n.annotationFilterTag || "Filter history by this tag";
        filterBtn.title = filterLabel;
        filterBtn.setAttribute("aria-label", `${filterLabel}: ${tag}`);
        filterBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: "filterByTag", tag });
        });
        chip.appendChild(filterBtn);

        const removeBtn = el("button", { type: "button", className: "sessionTagRemove" });
        removeBtn.textContent = "×";
        const removeLabel = i18n.annotationRemoveTag || "Remove this tag";
        removeBtn.title = removeLabel;
        removeBtn.setAttribute("aria-label", `${removeLabel}: ${tag}`);
        removeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: "removeTag", tag });
        });
        chip.appendChild(removeBtn);

        tagsBody.appendChild(chip);
      }
    }
    tagsRow.appendChild(tagsBody);

    const editBtn = el("button", { type: "button", className: "sessionHeaderEditBtn" });
    const editLabel = i18n.annotationEdit || "Edit";
    editBtn.textContent = editLabel;
    editBtn.title = editLabel;
    editBtn.setAttribute("aria-label", editLabel);
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "editAnnotation" });
    });
    tagsRow.appendChild(editBtn);
    wrap.appendChild(tagsRow);

    const noteRow = el("div", { className: "sessionHeaderRow" });
    const noteLabel = el("span", { className: "sessionHeaderLabel" });
    noteLabel.textContent = `${i18n.annotationNote || "Note"}:`;
    noteRow.appendChild(noteLabel);
    const noteBody = el("div", { className: "sessionNoteWrap" });
    const noteText = el("div", { className: "sessionNoteText" });
    noteText.textContent = note || i18n.annotationNone || "None";
    noteBody.appendChild(noteText);

    if (note.length > 220) {
      noteText.classList.toggle("clamped", !expandedNote);
      const toggleBtn = el("button", { type: "button", className: "sessionNoteToggleBtn" });
      const applyToggleLabel = () => {
        toggleBtn.textContent = expandedNote ? (i18n.annotationShowLess || "Show less") : (i18n.annotationShowMore || "Show more");
      };
      applyToggleLabel();
      toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        expandedNote = !expandedNote;
        noteText.classList.toggle("clamped", !expandedNote);
        applyToggleLabel();
      });
      noteBody.appendChild(toggleBtn);
    }

    noteRow.appendChild(noteBody);
    wrap.appendChild(noteRow);
    annotationEl.appendChild(wrap);
  }

  function createChatTurnSection(kind) {
    const section = el("section", { className: `chatTurn chatTurn-${kind}` });
    return section;
  }

  function isStickyUserTurnStart(item) {
    return item && item.type === "message" && getMessageRole(item) === "user";
  }

  function isUserMessageIndex(messageIndex) {
    if (!model || !Array.isArray(model.items) || typeof messageIndex !== "number") return false;
    const safeIndex = Math.max(0, Math.floor(messageIndex));
    return model.items.some(
      (item) => item && item.type === "message" && item.messageIndex === safeIndex && getMessageRole(item) === "user",
    );
  }

  function isUserTimelineElement(element) {
    if (!(element instanceof HTMLElement) || !model || !Array.isArray(model.items)) return false;
    const row = element.classList.contains("row") ? element : element.closest(".row[data-item-index]");
    if (!(row instanceof HTMLElement)) return false;
    if (row.classList.contains("user")) return true;
    const itemIndex = Number(row.dataset.itemIndex);
    const item = Number.isFinite(itemIndex) ? model.items[itemIndex] : null;
    return isStickyUserTurnStart(item);
  }

  function ensureStickyUserOverlay() {
    if (stickyUserOverlayEl instanceof HTMLElement) return stickyUserOverlayEl;
    const overlay = el("div", { className: "userStickyOverlay" });
    overlay.id = "userStickyOverlay";
    overlay.hidden = true;
    overlay.dataset.pageSearchIgnore = "true";
    document.body.appendChild(overlay);
    stickyUserOverlayEl = overlay;
    return overlay;
  }

  function hideStickyUserOverlay() {
    if (stickyUserUpdateFrame) {
      cancelAnimationFrame(stickyUserUpdateFrame);
      stickyUserUpdateFrame = 0;
    }
    activeStickyUserKey = null;
    if (stickyUserOverlayEl instanceof HTMLElement) {
      stickyUserOverlayEl.hidden = true;
      stickyUserOverlayEl.textContent = "";
    }
  }

  function refreshStickyUserRows() {
    if (!stickyUserPromptEnabled || !(timelineEl instanceof HTMLElement) || !model || !Array.isArray(model.items)) {
      stickyUserRows = [];
      return;
    }
    stickyUserRows = Array.from(timelineEl.querySelectorAll(".row.user[data-item-index]"))
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map((element) => {
        const itemIndex = Number(element.dataset.itemIndex);
        const item = Number.isFinite(itemIndex) ? model.items[itemIndex] : null;
        if (!isStickyUserTurnStart(item)) return null;
        const messageIndex = getStickyUserMessageIndex(item);
        const stickyKey = getStickyUserKey(item, itemIndex);
        return { element, item, itemIndex, messageIndex, stickyKey };
      })
      .filter(Boolean);
  }

  function getStickyUserMessageIndex(item) {
    if (!item || typeof item.messageIndex !== "number" || !Number.isFinite(item.messageIndex)) return null;
    return Math.max(0, Math.floor(item.messageIndex));
  }

  function getStickyUserKey(item, itemIndex) {
    const messageIndex = getStickyUserMessageIndex(item);
    if (typeof messageIndex === "number") return `message:${messageIndex}`;
    const safeItemIndex = Number.isFinite(itemIndex) ? Math.max(0, Math.floor(itemIndex)) : 0;
    return `item:${safeItemIndex}`;
  }

  function getStickyUserSafeDomKey(stickyKey) {
    return String(stickyKey || "unknown").replace(/[^A-Za-z0-9_-]+/g, "-");
  }

  function scheduleStickyUserOverlayUpdate(options = {}) {
    if (stickyUserUpdateFrame) cancelAnimationFrame(stickyUserUpdateFrame);
    stickyUserUpdateFrame = requestAnimationFrame(() => {
      stickyUserUpdateFrame = 0;
      if (options.rebuildRows) refreshStickyUserRows();
      updateStickyUserOverlay();
    });
  }

  function getStickyUserThreshold() {
    const toolbarBottom = toolbarEl instanceof HTMLElement ? toolbarEl.getBoundingClientRect().bottom : 0;
    return toolbarBottom;
  }

  function updateStickyUserOverlay() {
    if (!stickyUserPromptEnabled || !model || stickyUserRows.length === 0) {
      hideStickyUserOverlay();
      return;
    }
    if (stickyUserSuppressedUntilUserScroll) {
      hideStickyUserOverlay();
      return;
    }

    const threshold = getStickyUserThreshold();
    let active = null;
    for (const row of stickyUserRows) {
      if (!row || !(row.element instanceof HTMLElement) || row.element.offsetParent === null) continue;
      const rect = row.element.getBoundingClientRect();
      if (rect.top <= threshold + 1) {
        active = row;
        continue;
      }
      break;
    }

    if (!active) {
      hideStickyUserOverlay();
      return;
    }
    const overlay = ensureStickyUserOverlay();
    if (activeStickyUserKey !== active.stickyKey || overlay.childElementCount === 0) {
      overlay.textContent = "";
      overlay.appendChild(renderStickyUserHeader(active));
      activeStickyUserKey = active.stickyKey;
    }
    overlay.hidden = false;
  }

  function renderStickyUserHeader(rowInfo) {
    const item = rowInfo?.item;
    const messageIndex = rowInfo?.messageIndex ?? null;
    const stickyKey = rowInfo?.stickyKey || getStickyUserKey(item, rowInfo?.itemIndex);
    const fullText = String(getMessageTextToRender(item, "user") || "").trim();
    const oneLineText = fullText.replace(/\s+/g, " ").trim();
    const attachments = getMessageAttachments(item);
    const attachmentOnly = formatTemplate(
      i18n.stickyUserAttachmentOnly || "{0} attachment(s)",
      attachments.length,
    );
    const summarySource = oneLineText || (attachments.length > 0 ? attachmentOnly : getSafeUiText(i18n.roleUser, "User"));
    const summary = truncatePlainText(summarySource, STICKY_USER_SUMMARY_LIMIT);
    const previewText = truncatePlainText(fullText || summarySource, STICKY_USER_PREVIEW_LIMIT);
    const canExpand = !!fullText && (fullText.includes("\n") || fullText.length > STICKY_USER_SUMMARY_LIMIT);
    const expanded = canExpand && expandedStickyUserKeys.has(stickyKey);
    const previewId = `sticky-user-preview-${getStickyUserSafeDomKey(stickyKey)}`;

    const root = el("div", { className: "userStickyHeader" });
    root.dataset.pageSearchIgnore = "true";
    root.classList.toggle("userStickyHeader-expanded", expanded);

    const row = el("div", { className: "userStickyHeaderRow" });
    const main = el("button", { type: "button", className: "userStickyHeaderMain" });
    const ariaSummary = summarySource || getSafeUiText(i18n.roleUser, "User");
    main.setAttribute(
      "aria-label",
      formatTemplate(i18n.stickyUserAriaLabel || "Current user prompt: {0}", ariaSummary),
    );
    main.title = getSafeUiText(i18n.stickyUserOpenOriginal, "Jump to original user prompt");
    if (typeof messageIndex === "number" && document.getElementById(`msg-${messageIndex}`)) {
      main.setAttribute("aria-controls", `msg-${messageIndex}`);
    }
    main.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      scrollToOriginalUserPrompt(rowInfo);
    });

    const role = el("span", { className: "userStickyHeaderRole" });
    role.textContent = getSafeUiText(i18n.roleUser, "User");
    main.appendChild(role);
    if (typeof messageIndex === "number") {
      const index = el("span", { className: "userStickyHeaderIndex" });
      index.textContent = `#${messageIndex}`;
      main.appendChild(index);
    }
    const text = el("span", { className: "userStickyHeaderText" });
    text.textContent = summary;
    main.appendChild(text);
    row.appendChild(main);

    let toggle = null;
    let preview = null;
    if (canExpand) {
      toggle = el("button", { type: "button", className: "userStickyHeaderToggle" });
      toggle.setAttribute("aria-controls", previewId);
      syncStickyUserToggle(toggle, expanded);
      row.appendChild(toggle);
    }
    root.appendChild(row);

    if (canExpand) {
      preview = el("div", { className: "userStickyHeaderPreview", id: previewId });
      preview.textContent = previewText;
      preview.hidden = !expanded;
      root.appendChild(preview);
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextExpanded = !expandedStickyUserKeys.has(stickyKey);
        if (nextExpanded) expandedStickyUserKeys.add(stickyKey);
        else expandedStickyUserKeys.delete(stickyKey);
        root.classList.toggle("userStickyHeader-expanded", nextExpanded);
        preview.hidden = !nextExpanded;
        syncStickyUserToggle(toggle, nextExpanded);
      });
    }

    return root;
  }

  function syncStickyUserToggle(button, expanded) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.textContent = expanded ? i18n.showLess || "Show less" : i18n.showMore || "Show more";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function scrollToOriginalUserPrompt(rowInfo) {
    const safeIndex = rowInfo && typeof rowInfo.messageIndex === "number" ? rowInfo.messageIndex : null;
    const target =
      typeof safeIndex === "number" ? document.getElementById(`msg-${safeIndex}`) : rowInfo?.element ?? null;
    if (!(target instanceof HTMLElement)) return;
    suppressStickyUserUntilUserScroll();
    if (typeof safeIndex === "number") selectedMessageIndex = safeIndex;
    clearHighlights();
    target.classList.add("highlight");
    scrollElementIntoRootView(target, { behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      target.classList.remove("highlight");
    }, 1800);
  }

  function truncatePlainText(value, limit) {
    const text = String(value || "");
    const max = Math.max(1, Math.floor(Number(limit) || 1));
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
  }

  function renderItem(item, itemIndex) {
    const cardKey = buildTimelineCardKey(item, itemIndex);
    const itemType = item && typeof item.type === "string" ? item.type : "note";
    let rendered = null;
    if (item.type === "message") rendered = renderMessage(item, cardKey);
    else if (item.type === "patchGroup") rendered = renderPatchGroup(item, itemIndex, cardKey);
    else if (item.type === "tool") rendered = shouldRenderToolCard() ? renderTool(item, cardKey) : null;
    else if (item.type === "systemEvent") rendered = renderSystemEvent(item, cardKey);
    else if (item.type === "usage") rendered = showDetails ? renderUsage(item, cardKey) : null;
    else if (item.type === "environment") rendered = showDetails ? renderEnvironment(item, cardKey) : null;
    else rendered = showDetails ? renderNote(item, cardKey) : null;

    if (rendered instanceof HTMLElement) {
      rendered.dataset.cardKey = cardKey;
      rendered.dataset.itemIndex = String(itemIndex);
      rendered.dataset.itemType = itemType;
      const turnId = getTimelineItemTurnId(item);
      if (turnId) rendered.dataset.turnId = turnId;
      else delete rendered.dataset.turnId;
    }
    return rendered;
  }

  function getTimeGuideTargetElement(rendered) {
    if (!(rendered instanceof HTMLElement)) return null;
    const bubble = rendered.querySelector(".bubble, .systemEventCard, .usageCard, .environmentCard");
    return bubble instanceof HTMLElement ? bubble : rendered;
  }

  function getTimeGuideItems() {
    return timeGuideEnabled ? timeGuideItems : [];
  }

  function rebuildTimeGuideItems() {
    if (!timeGuideEnabled || !(timelineEl instanceof HTMLElement) || !model || !Array.isArray(model.items)) {
      timeGuideItems = [];
      return;
    }

    const startedAt = performance.now();
    timeGuideItems = Array.from(timelineEl.querySelectorAll("[data-item-index]"))
      .filter((element) => element instanceof HTMLElement)
      .map((element, index) => {
        const itemIndex = Number(element.dataset.itemIndex);
        const item = Number.isFinite(itemIndex) ? model.items[itemIndex] : null;
        const timestampIso = item && typeof item.timestampIso === "string" ? item.timestampIso.trim() : "";
        const target = getTimeGuideTargetElement(element);
        if (!timestampIso || !(target instanceof HTMLElement)) return null;
        return {
          key: element.dataset.cardKey || `timeline-${index}`,
          itemIndex: Number.isFinite(itemIndex) ? itemIndex : index,
          timestampIso,
          title: buildTimeGuideItemTitle(item, Number.isFinite(itemIndex) ? itemIndex : index),
          role: item && item.type === "message" ? getMessageRole(item) : "",
          attachmentKind: item && item.type === "message" ? getTimeGuideAttachmentKind(getMessageAttachments(item)) : "",
          bookmarked: isItemBookmarked(item),
          element: target,
        };
      })
      .filter((item) => item && item.element instanceof HTMLElement);
    debugWebview("timeGuide", "buildDone", {
      scope: "chat",
      items: timeGuideItems.length,
      totalMs: Math.round(performance.now() - startedAt),
    });
  }

  function ensureTimeGuide() {
    if (timeGuide) return timeGuide;
    if (!window.CodexHistoryTimeGuide || typeof window.CodexHistoryTimeGuide.create !== "function") return null;
    timeGuide = window.CodexHistoryTimeGuide.create({
      mode: "timeline",
      positionStrategy: "scroll",
      minItems: 2,
      requireScrollable: true,
      getHost: () => document.body,
      getScrollRoot,
      getContentElement: () => timelineEl,
      getTimeZone,
      getAriaLabel: () => getSafeUiText(i18n.timeGuideDates, "Dates"),
      getItems: getTimeGuideItems,
      onActivatePeriod: (period) => {
        if (period && period.role === "user") suppressStickyUserUntilUserScroll();
      },
    });
    return timeGuide;
  }

  function isRestoreCoverBlockingTimeGuide() {
    return restoreCoverActive || !!(restoreCoverEl instanceof HTMLElement && !restoreCoverEl.hidden);
  }

  function mergePendingTimeGuideOptions(current, next) {
    return {
      afterPaint: true,
      rebuildItems: !!(current && current.rebuildItems) || next.rebuildItems === true,
    };
  }

  function showRestoreCover() {
    if (!(restoreCoverEl instanceof HTMLElement)) return;
    cancelRestoreCoverRelease();
    cancelDeferredRenderSchedule();
    if (isSimplifiedPerformanceMode()) hibernateOpenPatchBodies();
    restoreCoverActive = true;
    restoreCoverShownAt = performance.now();
    restoreCoverEl.hidden = false;
    document.body.classList.add("restoreCoverActive");
  }

  function cancelRestoreCoverRelease() {
    if (restoreCoverFrame) {
      cancelAnimationFrame(restoreCoverFrame);
      restoreCoverFrame = 0;
    }
    if (restoreCoverTimer) {
      window.clearTimeout(restoreCoverTimer);
      restoreCoverTimer = 0;
    }
  }

  function scheduleRestoreCoverRelease() {
    if (!(restoreCoverEl instanceof HTMLElement) || restoreCoverEl.hidden) return;
    cancelRestoreCoverRelease();
    let lastSignature = "";
    let stableFrames = 0;
    const startedAt = performance.now();
    const waitForStableLayout = () => {
      restoreCoverFrame = 0;
      if (!(restoreCoverEl instanceof HTMLElement) || restoreCoverEl.hidden) return;

      const signature = getRestoreCoverLayoutSignature();
      if (signature && signature === lastSignature) stableFrames += 1;
      else {
        lastSignature = signature;
        stableFrames = 0;
      }

      const now = performance.now();
      const minElapsed = now - restoreCoverShownAt >= RESTORE_COVER_MIN_VISIBLE_MS;
      const timedOut = now - startedAt >= RESTORE_COVER_MAX_WAIT_MS;
      if ((minElapsed && stableFrames >= RESTORE_COVER_STABLE_FRAMES) || timedOut) {
        releaseRestoreCover({ waitMs: now - restoreCoverShownAt, timedOut });
        return;
      }

      restoreCoverFrame = requestAnimationFrame(waitForStableLayout);
    };
    restoreCoverFrame = requestAnimationFrame(waitForStableLayout);
  }

  function getRestoreCoverLayoutSignature() {
    const root = getScrollRoot();
    const toolbarHeight = toolbarEl instanceof HTMLElement ? toolbarEl.offsetHeight : 0;
    const rootWidth = root instanceof HTMLElement ? root.clientWidth : 0;
    const rootHeight = root instanceof HTMLElement ? root.clientHeight : 0;
    return [window.innerWidth, window.innerHeight, rootWidth, rootHeight, toolbarHeight].join("x");
  }

  function releaseRestoreCover(details = {}) {
    restoreCoverFrame = 0;
    restoreCoverActive = false;
    document.body.classList.remove("restoreCoverActive");
    debugWebview("restoreCover", "release", {
      scope: "chat",
      waitMs: Math.round(Number(details.waitMs || 0)),
      timedOut: details.timedOut === true,
    });
    restoreCoverTimer = window.setTimeout(() => {
      restoreCoverTimer = 0;
      if (!restoreCoverActive && restoreCoverEl instanceof HTMLElement) restoreCoverEl.hidden = true;
      flushTimeGuideAfterRestoreCover();
    }, RESTORE_COVER_HIDE_DELAY_MS);
  }

  function flushTimeGuideAfterRestoreCover() {
    const pending = pendingTimeGuideAfterRestoreCover;
    pendingTimeGuideAfterRestoreCover = null;
    if (pending) updateTimeGuide(pending);
    resumeDeferredRenderWork();
    if (isSimplifiedPerformanceMode()) restoreHibernatedPatchBodies();
  }

  function prepareTimeGuideForTimelineRender() {
    cancelPendingTimeGuideUpdate();
    timeGuideUpdateNeedsRebuild = false;
    timeGuideItems = [];
    if (timeGuide) {
      timeGuide.dispose();
      timeGuide = null;
    }
  }

  function cancelPendingTimeGuideUpdate() {
    timeGuideUpdateGeneration += 1;
    if (timeGuideUpdateFrame) {
      cancelAnimationFrame(timeGuideUpdateFrame);
      timeGuideUpdateFrame = 0;
    }
    if (timeGuideUpdateTimer) {
      window.clearTimeout(timeGuideUpdateTimer);
      timeGuideUpdateTimer = 0;
    }
    if (timeGuideUpdateIdle) {
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(timeGuideUpdateIdle);
      timeGuideUpdateIdle = 0;
    }
  }

  function updateTimeGuide(options = {}) {
    if (!timeGuideEnabled) {
      cancelPendingTimeGuideUpdate();
      timeGuideUpdateNeedsRebuild = false;
      pendingTimeGuideAfterRestoreCover = null;
      timeGuideItems = [];
      if (timeGuide) {
        timeGuide.dispose();
        timeGuide = null;
      }
      return;
    }

    if (isRestoreCoverBlockingTimeGuide()) {
      cancelPendingTimeGuideUpdate();
      pendingTimeGuideAfterRestoreCover = mergePendingTimeGuideOptions(pendingTimeGuideAfterRestoreCover, options);
      return;
    }

    timeGuideUpdateNeedsRebuild = timeGuideUpdateNeedsRebuild || options.rebuildItems === true;
    cancelPendingTimeGuideUpdate();
    const generation = timeGuideUpdateGeneration;
    const schedule = () => {
      if (generation !== timeGuideUpdateGeneration) return;
      const shouldRebuild = timeGuideUpdateNeedsRebuild;
      timeGuideUpdateNeedsRebuild = false;
      if (shouldRebuild) rebuildTimeGuideItems();
      if (!timeGuide && timeGuideItems.length === 0) return;
      const guide = ensureTimeGuide();
      if (guide) guide.scheduleUpdate();
    };

    if (options.afterPaint === true) {
      timeGuideUpdateFrame = requestAnimationFrame(() => {
        if (generation !== timeGuideUpdateGeneration) {
          timeGuideUpdateFrame = 0;
          return;
        }
        timeGuideUpdateFrame = requestAnimationFrame(() => {
          timeGuideUpdateFrame = 0;
          if (generation !== timeGuideUpdateGeneration) return;
          if (timeGuideUpdateNeedsRebuild && typeof window.requestIdleCallback === "function") {
            timeGuideUpdateIdle = window.requestIdleCallback(
              () => {
                timeGuideUpdateIdle = 0;
                schedule();
              },
              { timeout: TIME_GUIDE_REBUILD_IDLE_TIMEOUT_MS },
            );
            return;
          }
          timeGuideUpdateTimer = window.setTimeout(
            () => {
              timeGuideUpdateTimer = 0;
              schedule();
            },
            timeGuideUpdateNeedsRebuild ? TIME_GUIDE_REBUILD_FALLBACK_DELAY_MS : 0,
          );
        });
      });
      return;
    }

    schedule();
  }

  function buildTimeGuideItemTitle(item, itemIndex) {
    if (!item || typeof item !== "object") return "";
    if (item.type === "message") {
      const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "message";
      const messageIndex = typeof item.messageIndex === "number" ? `#${item.messageIndex}` : "";
      const attachmentSummary = buildTimeGuideAttachmentSummary(getMessageAttachments(item));
      const baseTitle = [role, messageIndex].filter(Boolean).join(" ");
      return attachmentSummary ? `${baseTitle} (${attachmentSummary})` : baseTitle;
    }
    if (item.type === "patchGroup") {
      return formatTemplate(i18n.patchGroupCount || "{0} changes", item.entryCount || 0);
    }
    if (item.type === "tool") {
      const presentation = resolveToolPresentation(item);
      const messageIndex = typeof item.messageIndex === "number" ? `#${item.messageIndex}` : "";
      return [presentation.title, messageIndex].filter(Boolean).join(" ");
    }
    if (item.type === "usage") return getSafeUiText(i18n.usage, "Usage");
    if (item.type === "environment") return getSafeUiText(i18n.environment, "Environment");
    if (item.type === "systemEvent") return getSystemEventBadgeText(item);
    if (item.type === "note" && typeof item.title === "string" && item.title.trim()) return item.title.trim();
    return `${getSafeUiText(i18n.roleMessage, "Message")} #${itemIndex + 1}`;
  }

  function renderSystemEvent(item, cardKey) {
    const row = el("div", { className: "row systemEvent" });
    const card = el("div", { className: `systemEventCard systemEventCard-${normalizeSystemEventKind(item)}` });
    applyTimelineCardWidthState(card, cardKey);

    const summary = el("div", { className: "systemEventSummary" });
    summary.appendChild(el("span", { className: "systemEventBadge", textContent: getSystemEventBadgeText(item) }));
    summary.appendChild(el("span", { className: "systemEventTitle", textContent: getSystemEventTitleText(item) }));
    if (item && item.rolledBack === true) {
      summary.appendChild(
        el("span", {
          className: "systemEventMeta systemEventMeta-rolledBack",
          textContent: getSafeUiText(i18n.systemEventInterruptedRolledBack, "Rolled back"),
        }),
      );
    }
    if (typeof item.timestampIso === "string" && item.timestampIso.trim()) {
      const timestamp = el("span", { className: "systemEventMeta", textContent: formatIsoYmdHms(item.timestampIso) });
      timestamp.title = item.timestampIso;
      summary.appendChild(timestamp);
    }
    card.appendChild(summary);

    const description = getSystemEventDescriptionText(item);
    if (description) card.appendChild(el("div", { className: "systemEventDescription", textContent: description }));

    if (showDetails) {
      const details = el("div", { className: "systemEventDetails" });
      appendUsageDetail(details, i18n.systemEventDetailReason || "Reason", normalizeUsageText(item && item.reason));
      appendUsageDetail(
        details,
        i18n.systemEventDetailDuration || "Duration",
        typeof item.durationMs === "number" && Number.isFinite(item.durationMs) ? formatDurationMs(item.durationMs) : "",
      );
      appendUsageDetail(details, i18n.systemEventDetailTurnId || "Turn ID", normalizeUsageText(item && item.turnId));
      appendUsageDetail(
        details,
        i18n.systemEventDetailRolledBackTurns || "Rolled back turns",
        typeof item.rolledBackTurns === "number" && Number.isFinite(item.rolledBackTurns)
          ? String(Math.max(0, Math.floor(item.rolledBackTurns)))
          : "",
      );
      if (details.childElementCount > 0) card.appendChild(details);
    }

    row.appendChild(card);
    return row;
  }

  function normalizeSystemEventKind(item) {
    return item && item.kind === "requestInterrupted" ? "interrupted" : "generic";
  }

  function getSystemEventBadgeText(item) {
    if (item && item.kind === "requestInterrupted") {
      return getSafeUiText(i18n.systemEventInterruptedBadge, "Request stopped");
    }
    return getSafeUiText(i18n.roleMessage, "Message");
  }

  function getSystemEventTitleText(item) {
    if (item && item.kind === "requestInterrupted" && item.scope === "toolUse") {
      return getSafeUiText(i18n.systemEventInterruptedToolUseTitle, "Tool use interrupted");
    }
    if (item && item.kind === "requestInterrupted") {
      return getSafeUiText(i18n.systemEventInterruptedTitle, "Request interrupted");
    }
    return getSystemEventBadgeText(item);
  }

  function getSystemEventDescriptionText(item) {
    if (item && item.kind === "requestInterrupted") {
      return getSafeUiText(i18n.systemEventInterruptedDescription, "The previous response was stopped by the user.");
    }
    return "";
  }

  function renderMessage(item, cardKey) {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "assistant";
    if (role !== "assistant" && !showDetails && item.isContext) return null;

    const textToRender = getMessageTextToRender(item, role);
    const attachments = getMessageAttachments(item);
    if (role === "user" && !showDetails && !textToRender.trim() && attachments.length === 0) return null;
    if (role === "developer" && !showDetails) return null;

    const row = el("div", { className: `row ${role}` });

    const bubble = el("div", { className: `bubble ${role}` });
    applyTimelineCardWidthState(bubble, cardKey);
    applyBookmarkMetadata(bubble, item);
    if (typeof item.messageIndex === "number") {
      bubble.id = `msg-${item.messageIndex}`;
      bubble.dataset.messageIndex = String(item.messageIndex);
      bubble.addEventListener("click", () => {
        selectedMessageIndex = item.messageIndex;
        clearHighlights();
        bubble.classList.add("highlight");
      });
    }

    const metaLine = el("div", { className: "metaLine" });
    const metaTags = el("div", { className: "metaTags" });
    const roleTag = el("span", { className: "tag" });
    roleTag.textContent = role;
    metaTags.appendChild(roleTag);
    if (typeof item.messageIndex === "number") {
      const indexTag = el("span", { className: "tag" });
      indexTag.textContent = `#${item.messageIndex}`;
      metaTags.appendChild(indexTag);
    }
    if (item.isContext) {
      const ctxTag = el("span", { className: "tag context" });
      ctxTag.textContent = "context";
      metaTags.appendChild(ctxTag);
    }
    if (typeof item.timestampIso === "string") {
      const ts = el("span", { className: "tag" });
      ts.textContent = formatIsoYmdHms(item.timestampIso);
      ts.title = item.timestampIso;
      metaTags.appendChild(ts);
    }
    metaLine.appendChild(metaTags);

    const headerActions = el("div", { className: "messageNav cardHeaderActions" });
    if ((role === "user" || role === "assistant") && typeof item.messageIndex === "number") {
      const nav = messageNavMap.get(item.messageIndex);
      if (nav && nav.showNav) {
        headerActions.appendChild(createMessageNavButton("prev", nav.role, nav.prevIndex));
        headerActions.appendChild(createMessageNavButton("next", nav.role, nav.nextIndex));
      }
    }
    appendBookmarkButton(headerActions, item);
    headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
    metaLine.appendChild(headerActions);
    bubble.appendChild(metaLine);

    const collapseState = resolveMessageCollapseState(item, role, textToRender);
    const body = el("div", { className: `messageBody messageBody-${role}` });
    if (collapseState.canCollapse && collapseState.collapsed) {
      body.classList.add("messageBody-collapsed", `messageBody-collapsed-${role}`);
    }

    if (attachments.length > 0) {
      body.appendChild(renderMessageAttachments(attachments, item));
    }

    const content = el("div", { className: role === "assistant" ? "messageBodyContent markdown" : "messageBodyContent" });
    if (textToRender.trim()) {
      if (role === "assistant") {
        renderAssistantMarkdownInto(content, textToRender);
      } else {
        const blocks = splitFencedCode(textToRender);
        for (const b of blocks) {
          if (b.type === "text") {
            const textBlock = el("div", { className: "textBlock" });
            textBlock.textContent = b.text;
            content.appendChild(textBlock);
          } else if (b.type === "code") {
            content.appendChild(renderCodeBlock(b.lang, b.code));
          }
        }
      }
      body.appendChild(content);
    }
    if (collapseState.canCollapse && collapseState.collapsed) {
      body.appendChild(el("div", { className: "messageBodyFade", "aria-hidden": "true" }));
    }
    bubble.appendChild(body);

    if (collapseState.canCollapse) {
      const expandRow = el("div", { className: "messageExpandRow" });
      const expandBtn = el("button", { type: "button", className: "messageExpandBtn" });
      expandBtn.textContent = collapseState.collapsed ? i18n.showMore || "Show more" : i18n.showLess || "Show less";
      expandBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMessageExpansion(item.messageIndex, collapseState.collapsed);
      });
      expandRow.appendChild(expandBtn);
      bubble.appendChild(expandRow);
    }

    const memoryCitation = role === "assistant" ? renderMemoryCitation(item.memoryCitation) : null;
    if (memoryCitation) bubble.appendChild(memoryCitation);

    if (role === "user" || role === "assistant") {
      const actions = el("div", { className: "bubbleActions" });
      const btn = el("button", { type: "button", className: "iconBtn" });
      const copyMessageLabel = i18n.copyMessageTooltip || i18n.copy || "Copy";
      btn.title = copyMessageLabel;
      btn.setAttribute("aria-label", copyMessageLabel);
      btn.innerHTML = COPY_ICON_SVG;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "copy", text: String(textToRender || "") });
      });
      actions.appendChild(btn);
      bubble.appendChild(actions);
    }

    row.appendChild(bubble);
    return row;
  }

  function renderMemoryCitation(citation) {
    if (!citation || typeof citation !== "object") return null;
    const entries = normalizeMemoryCitationEntries(citation.entries);
    const rolloutIds = normalizeMemoryCitationRolloutIds(citation.rolloutIds);
    if (entries.length === 0 && rolloutIds.length === 0) return null;

    const details = el("details", { className: "memoryCitation" });
    const summary = el("summary", { className: "memoryCitationSummary" });
    const count = entries.length > 0 ? entries.length : rolloutIds.length;
    summary.textContent = formatTemplate(i18n.memoryCitationSummary || "Referenced memory ({0})", count);
    details.appendChild(summary);

    const body = el("div", { className: "memoryCitationBody" });
    if (entries.length > 0) {
      const list = el("div", { className: "memoryCitationEntryList" });
      for (const entry of entries) {
        list.appendChild(renderMemoryCitationEntry(entry));
      }
      body.appendChild(list);
    }
    if (rolloutIds.length > 0) {
      body.appendChild(renderMemoryCitationRolloutIds(rolloutIds));
    }
    details.appendChild(body);
    return details;
  }

  function renderMemoryCitationEntry(entry) {
    const item = el("div", { className: "memoryCitationEntry" });
    const location = el("div", { className: "memoryCitationLocation" });
    location.textContent = formatMemoryCitationLocation(entry);
    item.appendChild(location);

    const note = typeof entry.note === "string" ? entry.note.trim() : "";
    if (note) {
      const noteEl = el("div", { className: "memoryCitationNote" });
      const label = el("span", { className: "memoryCitationNoteLabel" });
      label.textContent = `${i18n.memoryCitationNote || "Note"}:`;
      const text = el("span", { className: "memoryCitationNoteText" });
      text.textContent = note;
      noteEl.appendChild(label);
      noteEl.appendChild(text);
      item.appendChild(noteEl);
    }
    return item;
  }

  function renderMemoryCitationRolloutIds(rolloutIds) {
    const section = el("div", { className: "memoryCitationRollouts" });
    const title = el("div", { className: "memoryCitationRolloutsTitle" });
    title.textContent = i18n.memoryCitationRelatedSessions || "Related sessions";
    section.appendChild(title);
    const list = el("div", { className: "memoryCitationRolloutList" });
    for (const id of rolloutIds) {
      const code = el("code", { className: "memoryCitationRolloutId" });
      code.textContent = id;
      list.appendChild(code);
    }
    section.appendChild(list);
    return section;
  }

  function normalizeMemoryCitationEntries(value) {
    if (!Array.isArray(value)) return [];
    const entries = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const path = typeof raw.path === "string" ? raw.path.trim() : "";
      if (!path) continue;
      entries.push({
        path,
        lineStart: normalizeMemoryCitationLine(raw.lineStart),
        lineEnd: normalizeMemoryCitationLine(raw.lineEnd),
        note: typeof raw.note === "string" ? raw.note.trim() : "",
      });
    }
    return entries;
  }

  function normalizeMemoryCitationRolloutIds(value) {
    if (!Array.isArray(value)) return [];
    return value.map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id.length > 0);
  }

  function normalizeMemoryCitationLine(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const line = Math.floor(value);
    return line > 0 ? line : undefined;
  }

  function formatMemoryCitationLocation(entry) {
    const path = entry && typeof entry.path === "string" ? entry.path : "";
    const lineStart = normalizeMemoryCitationLine(entry && entry.lineStart);
    const lineEnd = normalizeMemoryCitationLine(entry && entry.lineEnd);
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd !== lineStart) {
      return formatTemplate(i18n.memoryCitationEntryRange || "{0}:{1}-{2}", path, lineStart, lineEnd);
    }
    if (lineStart !== undefined) {
      return formatTemplate(i18n.memoryCitationEntryLine || "{0}:{1}", path, lineStart);
    }
    return path;
  }

  function getMessageModelMetaText(item) {
    if (!item || typeof item !== "object") return "";
    const modelText = typeof item.model === "string" ? item.model.trim() : "";
    if (!modelText) return "";
    const effortText = typeof item.effort === "string" ? item.effort.trim() : "";
    return effortText ? `${modelText} : ${effortText}` : modelText;
  }

  function renderUsage(item, cardKey) {
    const key = typeof cardKey === "string" ? cardKey : "";
    const expanded = key.length > 0 && expandedUsageCardKeys.has(key);
    const row = el("div", { className: "row usage" });
    if (typeof item.messageIndex === "number") row.dataset.messageIndex = String(item.messageIndex);

    const card = el("button", {
      type: "button",
      className: `usageCard${expanded ? " usageCard-expanded" : ""}`,
    });
    card.setAttribute("aria-expanded", expanded ? "true" : "false");
    card.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!key) return;
      const changed = withPageSearchContentMutation(() => {
        const before = expandedUsageCardKeys.has(key);
        if (before) expandedUsageCardKeys.delete(key);
        else expandedUsageCardKeys.add(key);
        return before !== expandedUsageCardKeys.has(key);
      });
      if (changed) render();
    });

    const summary = el("div", { className: "usageSummary" });
    summary.appendChild(el("span", { className: "usageTitle", textContent: getSafeUiText(i18n.usage, "Usage") }));
    const modelText = getMessageModelMetaText(item);
    if (modelText) summary.appendChild(el("span", { className: "usageModel", textContent: modelText }));
    const tokenText = formatUsageTokenSummary(item && item.usage);
    if (tokenText) summary.appendChild(el("span", { className: "usageTokens", textContent: tokenText }));
    card.appendChild(summary);

    if (expanded) {
      const details = el("div", { className: "usageDetails" });
      appendUsageDetail(details, i18n.usageInput || "Input", getUsageNumber(item?.usage?.inputTokens));
      appendUsageDetail(details, i18n.usageOutput || "Output", getUsageNumber(item?.usage?.outputTokens));
      appendUsageDetail(details, i18n.usageCachedInput || "Cached input", getUsageNumber(item?.usage?.cachedInputTokens));
      appendUsageDetail(details, i18n.usageCacheRead || "Cache read", getUsageNumber(item?.usage?.cacheReadInputTokens));
      appendUsageDetail(details, i18n.usageCacheWrite || "Cache write", getUsageNumber(item?.usage?.cacheCreationInputTokens));
      appendUsageDetail(details, i18n.usageReasoning || "Reasoning", getUsageNumber(item?.usage?.reasoningOutputTokens));
      appendUsageDetail(details, i18n.usageTotal || "Total", getUsageNumber(item?.usage?.totalTokens));
      const contextUsed = formatUsageContextUsed(item);
      if (contextUsed) appendUsageDetail(details, i18n.usageContextUsed || "Context", contextUsed);
      else appendUsageDetail(details, i18n.usageContextWindow || "Context window", getUsageNumber(item?.modelContextWindow));
      appendUsageDetail(details, i18n.usageServiceTier || "Service tier", normalizeUsageText(item?.serviceTier));
      appendUsageDetail(details, i18n.usageSpeed || "Speed", normalizeUsageText(item?.speed));
      appendUsageDetail(details, i18n.usageStopReason || "Stop reason", normalizeUsageText(item?.stopReason));
      appendRateLimitDetails(details, item && item.rateLimits);
      appendTotalUsageDetails(details, item && item.totalUsage);
      if (details.childElementCount > 0) card.appendChild(details);
    }

    row.appendChild(card);
    return row;
  }

  function formatUsageTokenSummary(usage) {
    const input = getUsageNumber(usage && usage.inputTokens);
    const output = getUsageNumber(usage && usage.outputTokens);
    if (input && output) return formatTemplate(getSafeUiText(i18n.usageTokensInOut, "{0} in / {1} out"), input, output);
    if (input) return formatTemplate(getSafeUiText(i18n.usageTokensIn, "{0} in"), input);
    if (output) return formatTemplate(getSafeUiText(i18n.usageTokensOut, "{0} out"), output);
    return "";
  }

  function formatUsageContextUsed(item) {
    const inputTokens = item && item.usage && typeof item.usage.inputTokens === "number" ? item.usage.inputTokens : NaN;
    const contextWindow = item && typeof item.modelContextWindow === "number" ? item.modelContextWindow : NaN;
    if (!Number.isFinite(inputTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return "";
    const percent = (Math.max(0, inputTokens) / contextWindow) * 100;
    return formatTemplate(
      getSafeUiText(i18n.usageContextUsedValue, "input {0} / window {1} ({2})"),
      getUsageNumber(inputTokens),
      getUsageNumber(contextWindow),
      formatPercent(percent),
    );
  }

  function appendRateLimitDetails(container, rateLimits) {
    if (!rateLimits || typeof rateLimits !== "object") return;
    appendUsageDetail(container, i18n.usageRateLimitPrimary || "Short-term rate limit", formatRateLimit(rateLimits.primary, "hours"));
    appendUsageDetail(container, i18n.usageRateLimitSecondary || "Long-term rate limit", formatRateLimit(rateLimits.secondary, "days"));
    appendUsageDetail(container, i18n.usageRateLimitPlan || "Plan", normalizeUsageText(rateLimits.planType));
    appendUsageDetail(container, i18n.usageRateLimitReached || "Rate limit reached", normalizeUsageText(rateLimits.reachedType));
  }

  function formatRateLimit(limit, windowUnit) {
    if (!limit || typeof limit !== "object") return "";
    const parts = [];
    if (typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)) {
      parts.push(formatTemplate(getSafeUiText(i18n.usageRateLimitUsed, "usage {0}"), formatPercent(limit.usedPercent)));
    }
    if (typeof limit.windowMinutes === "number" && Number.isFinite(limit.windowMinutes)) {
      const windowText = formatRateLimitWindow(limit.windowMinutes, windowUnit);
      if (windowText) parts.push(windowText);
    }
    if (typeof limit.resetsAt === "number" && Number.isFinite(limit.resetsAt)) {
      const resetAt = formatUnixSeconds(limit.resetsAt);
      if (resetAt) parts.push(formatTemplate(getSafeUiText(i18n.usageRateLimitResetAt, "reset {0}"), resetAt));
    } else if (typeof limit.resetsInSeconds === "number" && Number.isFinite(limit.resetsInSeconds)) {
      parts.push(
        formatTemplate(
          getSafeUiText(i18n.usageRateLimitResetIn, "reset in {0}"),
          formatDurationSeconds(limit.resetsInSeconds),
        ),
      );
    }
    return parts.join(" / ");
  }

  function formatRateLimitWindow(windowMinutes, unit) {
    if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes)) return "";
    if (unit === "hours") {
      return formatTemplate(
        getSafeUiText(i18n.usageRateLimitWindowHours, "window {0} h"),
        formatUsageDecimalNumber(windowMinutes / 60),
      );
    }
    if (unit === "days") {
      return formatTemplate(
        getSafeUiText(i18n.usageRateLimitWindowDays, "window {0} d"),
        formatUsageDecimalNumber(windowMinutes / 1440),
      );
    }
    return formatTemplate(getSafeUiText(i18n.usageRateLimitWindow, "window {0} min"), getUsageNumber(windowMinutes));
  }

  function appendUsageDetail(container, label, value) {
    if (!(container instanceof HTMLElement)) return;
    const safeLabel = normalizeUsageText(label);
    const safeValue = normalizeUsageText(value);
    if (!safeLabel || !safeValue) return;
    const item = el("div", { className: "usageDetailItem" });
    item.appendChild(el("span", { className: "usageDetailLabel", textContent: safeLabel }));
    item.appendChild(el("span", { className: "usageDetailValue", textContent: safeValue }));
    container.appendChild(item);
  }

  function appendTotalUsageDetails(container, totalUsage) {
    if (!totalUsage || typeof totalUsage !== "object") return;
    const totalLabel = getSafeUiText(i18n.usageCumulative, "Cumulative tokens");
    const input = getUsageNumber(totalUsage.inputTokens);
    const output = getUsageNumber(totalUsage.outputTokens);
    const total = getUsageNumber(totalUsage.totalTokens);
    const parts = [];
    if (input) parts.push(`${getSafeUiText(i18n.usageInput, "Input")} ${input}`);
    if (output) parts.push(`${getSafeUiText(i18n.usageOutput, "Output")} ${output}`);
    if (total) parts.push(`${getSafeUiText(i18n.usageTotal, "Total")} ${total}`);
    if (parts.length > 0) appendUsageDetail(container, totalLabel, parts.join(" / "));
  }

  function getUsageNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    return Math.max(0, Math.floor(value)).toLocaleString();
  }

  function formatUsageDecimalNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    const safe = Math.max(0, value);
    if (Number.isInteger(safe)) return safe.toLocaleString();
    return safe.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function formatPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    const safe = Math.max(0, value);
    const digits = safe >= 10 || Number.isInteger(safe) ? 0 : 1;
    return `${safe.toFixed(digits)}%`;
  }

  function formatUnixSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    const ms = value * 1000;
    if (!Number.isFinite(ms)) return "";
    return formatIsoYmdHms(new Date(ms).toISOString());
  }

  function formatDurationSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    let seconds = Math.max(0, Math.floor(value));
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  function normalizeUsageText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function renderEnvironment(item, cardKey) {
    const row = el("div", { className: "row environment" });
    if (typeof item.messageIndex === "number") row.dataset.messageIndex = String(item.messageIndex);

    const card = el("div", { className: "environmentCard" });
    applyTimelineCardWidthState(card, cardKey);

    const summary = el("div", { className: "environmentSummary" });
    summary.appendChild(el("span", { className: "environmentTitle", textContent: getSafeUiText(i18n.environment, "Environment") }));
    const branch = normalizeUsageText(item && item.gitBranch);
    if (branch) summary.appendChild(el("span", { className: "environmentMeta", textContent: branch }));
    const commit = normalizeGitCommitDisplay(item && item.gitCommit);
    if (commit) summary.appendChild(el("span", { className: "environmentMeta mono", textContent: commit }));
    if (typeof item.gitDirty === "boolean") {
      summary.appendChild(
        el("span", {
          className: "environmentMeta",
          textContent: item.gitDirty ? getSafeUiText(i18n.environmentDirty, "dirty") : getSafeUiText(i18n.environmentClean, "clean"),
        }),
      );
    }
    if (typeof item.timestampIso === "string") {
      const timestamp = el("span", { className: "environmentMeta", textContent: formatIsoYmdHms(item.timestampIso) });
      timestamp.title = item.timestampIso;
      summary.appendChild(timestamp);
    }
    card.appendChild(summary);

    const details = el("div", { className: "environmentDetails" });
    appendUsageDetail(details, i18n.environmentCwd || "CWD", normalizeUsageText(item && item.cwd));
    appendUsageDetail(details, i18n.environmentBranch || "Branch", branch);
    appendUsageDetail(details, i18n.environmentCommit || "Commit", normalizeUsageText(item && item.gitCommit));
    if (details.childElementCount > 0) card.appendChild(details);

    row.appendChild(card);
    return row;
  }

  function normalizeGitCommitDisplay(value) {
    const text = normalizeUsageText(value);
    return text.length > 12 ? text.slice(0, 12) : text;
  }

  function getMessageAttachments(item) {
    if (!item || !Array.isArray(item.attachments)) return [];
    return item.attachments.filter((attachment) => attachment && typeof attachment.type === "string");
  }

  function getTimeGuideAttachmentKind(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const hasImage = attachments.some((attachment) => attachment && attachment.type === "image");
    const hasOther = attachments.some((attachment) => attachment && attachment.type !== "image");
    if (hasImage && hasOther) return "mixed";
    if (hasImage) return "image";
    return "attachment";
  }

  function buildTimeGuideAttachmentSummary(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const labels = [];
    const seen = new Set();
    let total = 0;
    for (const attachment of attachments) {
      const label = getTimeGuideAttachmentLabel(attachment);
      if (!label) continue;
      total += 1;
      if (seen.has(label)) continue;
      seen.add(label);
      if (labels.length < 3) labels.push(label);
    }
    if (total === 0 || labels.length === 0) return "";
    if (seen.size === 1 && total > 1) return `${labels[0]} \u00d7${total}`;
    const remaining = Math.max(0, seen.size - labels.length);
    const kindSummary = remaining > 0 ? `${labels.join(", ")} +${remaining}` : labels.join(", ");
    if (total > seen.size || remaining > 0) {
      const countLabel = formatTemplate(getSafeUiText(i18n.attachmentTotalCount, "{0} attachments"), total);
      return countLabel ? `${kindSummary} / ${countLabel}` : kindSummary;
    }
    return kindSummary;
  }

  function getTimeGuideAttachmentLabel(attachment) {
    if (!attachment || typeof attachment !== "object") return "";
    if (attachment.type === "image") return getSafeUiText(i18n.imageAttachmentLabel, "Image");
    return getAttachmentKindLabel(attachment);
  }

  function renderMessageAttachments(attachments, messageItem) {
    const wrap = el("div", { className: "messageAttachments" });
    const previewImages = attachments.filter((attachment) => attachment.type === "image" && canPreviewImage(attachment));
    let pendingImages = [];
    const flushImages = () => {
      if (pendingImages.length === 0) return;
      wrap.appendChild(renderMessageImages(pendingImages, previewImages));
      pendingImages = [];
    };
    for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
      const attachment = attachments[attachmentIndex];
      if (attachment.type === "image") {
        pendingImages.push(attachment);
        continue;
      }
      flushImages();
      const card = renderAttachmentCard(attachment, messageItem, attachmentIndex);
      if (card) wrap.appendChild(card);
    }
    flushImages();
    return wrap;
  }

  function renderAttachmentCard(attachment, messageItem, attachmentIndex) {
    if (!attachment || typeof attachment !== "object") return null;
    if (attachment.type === "document") return renderDocumentAttachment(attachment);
    if (attachment.type === "fileReference") return renderFileReferenceAttachment(attachment);
    if (attachment.type === "selectionReference") return renderSelectionReferenceAttachment(attachment);
    if (attachment.type === "notification") return renderTaskNotificationAttachment(attachment, messageItem, attachmentIndex);
    if (attachment.type === "invoke") return renderInvokeAttachment(attachment, messageItem, attachmentIndex);
    return null;
  }

  function renderDocumentAttachment(attachment) {
    const label = getAttachmentLabel(attachment);
    const tooltip = buildAttachmentTitle(attachment);
    const card = el("div", { className: `messageAttachmentCard messageAttachmentCard-document messageAttachmentCard-${getDocumentKind(attachment)}` });
    card.title = tooltip;
    appendAttachmentBadge(card, getAttachmentKindLabel(attachment), tooltip);

    const body = el("div", { className: "messageAttachmentBody" });
    const title = el("div", { className: "messageAttachmentTitle" });
    title.textContent = label;
    title.title = tooltip;
    body.appendChild(title);
    card.appendChild(body);

    const actions = el("div", { className: "messageAttachmentActions" });
    let previewPanel = null;
    if (attachment.previewText) {
      previewPanel = el("pre", { className: "messageAttachmentPreviewPanel", hidden: true });
      previewPanel.textContent = attachment.previewText;
      const previewButton = createAttachmentActionButton(i18n.attachmentPreview || "Preview", () => {
        const willOpen = previewPanel.hidden;
        previewPanel.hidden = !willOpen;
        previewButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
        card.classList.toggle("messageAttachmentCard-previewOpen", willOpen);
      }, DETAILS_ON_ICON_SVG);
      previewButton.setAttribute("aria-expanded", "false");
      actions.appendChild(previewButton);
    }
    if (attachment.status === "available" && attachment.dataOmitted === true && getAttachmentId(attachment)) {
      actions.appendChild(createAttachmentActionButton(i18n.attachmentSave || "Save", () => {
        vscode.postMessage({
          type: "saveAttachment",
          attachmentId: getAttachmentId(attachment),
          fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
        });
      }, SAVE_ICON_SVG));
    }
    if (actions.childElementCount > 0) card.appendChild(actions);
    if (previewPanel) card.appendChild(previewPanel);
    return card;
  }

  function renderFileReferenceAttachment(attachment) {
    const label = getAttachmentLabel(attachment);
    const tooltip = buildAttachmentTitle(attachment);
    const card = el("div", { className: `messageAttachmentCard messageAttachmentCard-file messageAttachmentCard-${getFileKind(attachment)}` });
    card.title = tooltip;
    appendAttachmentBadge(card, getAttachmentKindLabel(attachment), tooltip);

    const body = el("div", { className: "messageAttachmentBody" });
    const title = el("div", { className: "messageAttachmentTitle" });
    title.textContent = label;
    title.title = tooltip;
    body.appendChild(title);
    card.appendChild(body);

    if (attachment.path) {
      const actions = el("div", { className: "messageAttachmentActions" });
      actions.appendChild(createAttachmentActionButton(i18n.attachmentOpen || "Open", () => {
        vscode.postMessage({
          type: "openAttachment",
          fsPath: attachment.path,
          line: sanitizePositiveNumber(attachment.line),
        });
      }, PATCH_JUMP_ICON_SVG));
      card.appendChild(actions);
    }
    return card;
  }

  function renderSelectionReferenceAttachment(attachment) {
    const label = getAttachmentLabel(attachment);
    const tooltip = buildAttachmentTitle(attachment);
    const card = el("div", { className: "messageAttachmentCard messageAttachmentCard-selection" });
    card.title = tooltip;
    appendAttachmentBadge(card, getAttachmentKindLabel(attachment), tooltip);

    const body = el("div", { className: "messageAttachmentBody" });
    const title = el("div", { className: "messageAttachmentTitle" });
    const location = formatAttachmentLineRange(attachment);
    title.textContent = location ? `${label}${location}` : label;
    title.title = tooltip;
    body.appendChild(title);

    if (attachment.previewText) {
      const preview = el("pre", { className: "messageAttachmentSelectionPreview" });
      preview.textContent = attachment.previewText;
      body.appendChild(preview);
    }
    card.appendChild(body);

    if (attachment.path) {
      const actions = el("div", { className: "messageAttachmentActions" });
      actions.appendChild(createAttachmentActionButton(i18n.attachmentOpen || "Open", () => {
        vscode.postMessage({
          type: "openAttachment",
          fsPath: attachment.path,
          line: sanitizePositiveNumber(attachment.line),
        });
      }, PATCH_JUMP_ICON_SVG));
      card.appendChild(actions);
    }
    return card;
  }

  function renderTaskNotificationAttachment(attachment, messageItem, attachmentIndex) {
    const statusLabel = getTaskNotificationStatusLabel(attachment && attachment.status);
    const tooltip = [getSafeUiText(i18n.taskNotificationTitle, "Task notification"), statusLabel, attachment.summary]
      .filter(Boolean)
      .join("\n");
    const card = el("div", { className: "messageAttachmentCard messageAttachmentCard-notification" });
    card.title = tooltip;
    appendAttachmentBadge(card, statusLabel || getSafeUiText(i18n.taskNotificationTitle, "Task notification"), tooltip);

    const body = el("div", { className: "messageAttachmentBody" });
    const title = el("div", { className: "messageAttachmentTitle" });
    title.textContent = attachment.summary || getSafeUiText(i18n.taskNotificationTitle, "Task notification");
    title.title = tooltip;
    body.appendChild(title);

    const usageText = formatTaskNotificationUsage(attachment && attachment.usage);
    if (usageText) {
      const meta = el("div", { className: "messageAttachmentMeta" });
      meta.textContent = `${getSafeUiText(i18n.taskNotificationUsage, "Usage")}: ${usageText}`;
      body.appendChild(meta);
    }

    if (attachment.result) {
      body.appendChild(
        renderAttachmentDetails(
          getSafeUiText(i18n.taskNotificationResult, "Result"),
          attachment.result,
          "messageAttachmentStructuredPreview",
          buildAttachmentDetailKey(attachment, "result", messageItem, attachmentIndex),
        ),
      );
    }
    card.appendChild(body);
    return card;
  }

  function renderInvokeAttachment(attachment, messageItem, attachmentIndex) {
    const titleText = attachment.toolName || getSafeUiText(i18n.invokeTitle, "Tool invocation");
    const tooltip = [getSafeUiText(i18n.invokeTitle, "Tool invocation"), titleText, attachment.description]
      .filter(Boolean)
      .join("\n");
    const card = el("div", { className: "messageAttachmentCard messageAttachmentCard-invoke" });
    card.title = tooltip;
    appendAttachmentBadge(card, getSafeUiText(i18n.invokeTitle, "Tool invocation"), tooltip);

    const body = el("div", { className: "messageAttachmentBody" });
    const title = el("div", { className: "messageAttachmentTitle mono" });
    title.textContent = titleText;
    title.title = tooltip;
    body.appendChild(title);

    if (attachment.description) {
      const description = el("div", { className: "messageAttachmentMeta" });
      description.textContent = `${getSafeUiText(i18n.invokeDescription, "Description")}: ${attachment.description}`;
      body.appendChild(description);
    }

    if (Array.isArray(attachment.parameters) && attachment.parameters.length > 0) {
      const details = renderAttachmentDetails(
        getSafeUiText(i18n.invokeParameter, "Parameter"),
        "",
        "messageAttachmentStructuredPreview",
        buildAttachmentDetailKey(attachment, "parameters", messageItem, attachmentIndex),
      );
      const content = details.querySelector(".messageAttachmentStructuredPreview");
      if (content instanceof HTMLElement) {
        content.textContent = "";
        for (const parameter of attachment.parameters) {
          if (!parameter || typeof parameter !== "object") continue;
          const item = el("div", { className: "messageAttachmentParameter" });
          const name = typeof parameter.name === "string" ? parameter.name.trim() : "";
          const value = typeof parameter.value === "string" ? parameter.value : "";
          item.appendChild(el("div", { className: "messageAttachmentParameterName mono", textContent: name || "-" }));
          const valueEl = el("pre", { className: "messageAttachmentParameterValue" });
          valueEl.textContent = value;
          item.appendChild(valueEl);
          content.appendChild(item);
        }
      }
      body.appendChild(details);
    }

    card.appendChild(body);
    return card;
  }

  function buildAttachmentDetailKey(attachment, detailKind, messageItem, attachmentIndex) {
    if (!attachment || typeof attachment !== "object") return "";
    const kind = typeof detailKind === "string" ? detailKind.trim() : "";
    if (!kind) return "";
    const messageKey =
      messageItem && typeof messageItem.messageIndex === "number" && Number.isFinite(messageItem.messageIndex)
        ? `m:${Math.max(0, Math.floor(messageItem.messageIndex))}`
        : `item:${buildAttachmentDetailMessageFallbackKey(messageItem)}`;
    const identity = buildAttachmentDetailIdentity(attachment, kind);
    const ordinal = normalizeAttachmentDetailOrdinal(attachmentIndex);
    const ordinalKey = ordinal >= 0 ? `:${ordinal}` : "";
    return identity ? `attachment:${messageKey}:${kind}${ordinalKey}:${identity}` : "";
  }

  function normalizeAttachmentDetailOrdinal(value) {
    const ordinal = Number(value);
    return Number.isFinite(ordinal) ? Math.max(0, Math.floor(ordinal)) : -1;
  }

  function buildAttachmentDetailMessageFallbackKey(messageItem) {
    if (!messageItem || typeof messageItem !== "object") return "unknown";
    return stableStringHash(
      [
        messageItem.role || "",
        messageItem.timestampIso || "",
        messageItem.bookmarkKey || "",
        stableStringHash(messageItem.text || ""),
      ].join("\n"),
    );
  }

  function buildAttachmentDetailIdentity(attachment, detailKind) {
    if (attachment.type === "notification") {
      const signature = [
        "notification",
        attachment.source || "",
        attachment.status || "",
        attachment.summary || "",
        stableStringHash(attachment.result || ""),
        stableStringHash(JSON.stringify(attachment.usage || {})),
      ].join("\n");
      return stableStringHash(signature);
    }
    if (attachment.type === "invoke") {
      const parameterSignature = Array.isArray(attachment.parameters)
        ? attachment.parameters
            .map((parameter) => `${parameter && parameter.name ? parameter.name : ""}\u0000${parameter && parameter.value ? parameter.value : ""}`)
            .join("\u0001")
        : "";
      const signature = [
        "invoke",
        attachment.source || "",
        attachment.toolName || "",
        attachment.description || "",
        detailKind,
        stableStringHash(parameterSignature),
      ].join("\n");
      return stableStringHash(signature);
    }
    return "";
  }

  function normalizeAttachmentDetailKey(value) {
    return typeof value === "string" ? value.trim().slice(0, 512) : "";
  }

  function isAttachmentDetailOpen(detailKey) {
    const key = normalizeAttachmentDetailKey(detailKey);
    if (!key) return false;
    return expandedAttachmentDetails.has(key) || pageSearchTemporaryAttachmentDetailKeys.has(key);
  }

  function renderAttachmentDetails(summaryText, contentText, contentClassName, detailKey) {
    const details = el("details", { className: "messageAttachmentDetails" });
    const normalizedKey = normalizeAttachmentDetailKey(detailKey);
    if (normalizedKey) details.dataset.attachmentDetailKey = normalizedKey;
    details.open = isAttachmentDetailOpen(normalizedKey);
    const summary = el("summary", { className: "messageAttachmentDetailsSummary" });
    const label = el("span", { className: "messageAttachmentDetailsLabel" });
    label.textContent = summaryText;
    summary.appendChild(label);
    details.appendChild(summary);
    const content = el("pre", { className: contentClassName || "messageAttachmentStructuredPreview" });
    content.textContent = contentText;
    details.appendChild(content);
    attachControlledDetailsToggle(details, summary, normalizedKey);
    return details;
  }

  function attachControlledDetailsToggle(details, summary, detailKey) {
    if (!(details instanceof HTMLDetailsElement) || !(summary instanceof HTMLElement)) return;
    const normalizedKey = normalizeAttachmentDetailKey(detailKey);
    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const applyToggle = () => {
        const nextOpen = !details.open;
        details.open = nextOpen;
        if (!normalizedKey) return true;
        const beforePersistent = expandedAttachmentDetails.has(normalizedKey);
        const beforeTemporary = pageSearchTemporaryAttachmentDetailKeys.has(normalizedKey);
        const suppressTemporary = isPageSearchOpen();
        if (nextOpen) {
          pageSearchSuppressedTemporaryAttachmentDetailKeys.delete(normalizedKey);
          expandedAttachmentDetails.add(normalizedKey);
        } else {
          expandedAttachmentDetails.delete(normalizedKey);
          pageSearchTemporaryAttachmentDetailKeys.delete(normalizedKey);
          if (suppressTemporary) pageSearchSuppressedTemporaryAttachmentDetailKeys.add(normalizedKey);
          if (pageSearchTemporaryAttachmentDetailKeys.size === 0) {
            pageSearchTemporaryAttachmentExpansionActive = false;
          }
        }
        return beforePersistent !== expandedAttachmentDetails.has(normalizedKey)
          || beforeTemporary !== pageSearchTemporaryAttachmentDetailKeys.has(normalizedKey);
      };
      if (isPageSearchOpen()) {
        withPageSearchContentMutation(applyToggle, {
          refreshImmediately: true,
          refreshOptions: buildActivePageSearchRefreshOptions({ preserveIndex: true, reveal: false }),
        });
      } else {
        applyToggle();
      }
    };
    summary.addEventListener("click", toggle);
  }

  function getTaskNotificationStatusLabel(status) {
    if (status === "completed") return getSafeUiText(i18n.taskNotificationStatusCompleted, "completed");
    if (status === "failed") return getSafeUiText(i18n.taskNotificationStatusFailed, "failed");
    if (status === "running") return getSafeUiText(i18n.taskNotificationStatusRunning, "running");
    if (status === "cancelled") return getSafeUiText(i18n.taskNotificationStatusCancelled, "cancelled");
    return getSafeUiText(i18n.taskNotificationStatusUnknown, "unknown");
  }

  function formatTaskNotificationUsage(usage) {
    if (!usage || typeof usage !== "object") return "";
    const parts = [];
    if (typeof usage.subagentTokens === "number" && Number.isFinite(usage.subagentTokens)) {
      parts.push(
        formatTemplate(
          getSafeUiText(i18n.taskNotificationUsageTokens, "{0} tokens"),
          getUsageNumber(usage.subagentTokens),
        ),
      );
    }
    if (typeof usage.toolUses === "number" && Number.isFinite(usage.toolUses)) {
      parts.push(
        formatTemplate(
          getSafeUiText(i18n.taskNotificationUsageToolUses, "{0} tool uses"),
          getUsageNumber(usage.toolUses),
        ),
      );
    }
    if (typeof usage.durationMs === "number" && Number.isFinite(usage.durationMs)) {
      parts.push(formatDurationMs(usage.durationMs));
    }
    return parts.filter(Boolean).join(" / ");
  }

  function appendAttachmentBadge(card, label, tooltip) {
    const badge = el("div", { className: "messageAttachmentBadge" });
    if (tooltip) badge.title = tooltip;
    badge.appendChild(el("span", { className: "messageAttachmentBadgeIcon", "aria-hidden": "true" }));
    const text = el("span", { className: "messageAttachmentBadgeText" });
    text.textContent = label;
    badge.appendChild(text);
    card.appendChild(badge);
  }

  function createAttachmentActionButton(label, onClick, iconSvg) {
    const button = el("button", { type: "button", className: "messageAttachmentAction" });
    button.title = label;
    button.setAttribute("aria-label", label);
    if (iconSvg) {
      const icon = el("span", { className: "messageAttachmentActionIcon", "aria-hidden": "true" });
      icon.innerHTML = iconSvg;
      button.appendChild(icon);
    } else {
      button.textContent = label;
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function getAttachmentId(attachment) {
    return attachment && typeof attachment.id === "string" ? attachment.id.trim() : "";
  }

  function getAttachmentLabel(attachment) {
    const label = attachment && typeof attachment.label === "string" ? attachment.label.trim() : "";
    if (label) return label;
    if (attachment?.type === "document") return i18n.attachmentDocument || "Document";
    if (attachment?.type === "selectionReference") return i18n.attachmentSelection || "Selection";
    if (attachment?.type === "notification") return i18n.taskNotificationTitle || "Task notification";
    if (attachment?.type === "invoke") return attachment.toolName || i18n.invokeTitle || "Tool invocation";
    return i18n.attachmentFileReference || "File reference";
  }

  function getDocumentKind(attachment) {
    const kind = typeof attachment?.documentKind === "string" ? attachment.documentKind : "generic";
    if (kind === "pdf" || kind === "text") return kind;
    return "generic";
  }

  function getFileKind(attachment) {
    const kind = typeof attachment?.fileKind === "string" ? attachment.fileKind : "generic";
    if (kind === "pdf" || kind === "word" || kind === "excel" || kind === "powerpoint" || kind === "text" || kind === "code" || kind === "archive" || kind === "image") return kind;
    return "generic";
  }

  function getAttachmentKindLabel(attachment) {
    if (attachment?.type === "document") {
      const kind = getDocumentKind(attachment);
      if (kind === "pdf") return i18n.attachmentPdf || "PDF";
      if (kind === "text") return i18n.attachmentText || "Text";
      return i18n.attachmentDocument || "Document";
    }
    if (attachment?.type === "selectionReference") return i18n.attachmentSelection || "Selection";
    if (attachment?.type === "notification") return getTaskNotificationStatusLabel(attachment.status);
    if (attachment?.type === "invoke") return i18n.invokeTitle || "Tool invocation";
    if (attachment?.source === "claudeIdeOpenedFile") return i18n.attachmentOpenedFile || "Opened file";
    const kind = getFileKind(attachment);
    if (kind === "pdf") return i18n.attachmentPdf || "PDF";
    if (kind === "word") return i18n.attachmentWord || "Word";
    if (kind === "excel") return i18n.attachmentExcel || "Excel";
    if (kind === "powerpoint") return i18n.attachmentPowerPoint || "PowerPoint";
    if (kind === "archive") return i18n.attachmentArchive || "Archive";
    if (kind === "text") return i18n.attachmentText || "Text";
    if (kind === "code") return i18n.attachmentCode || "Code";
    if (kind === "image") return i18n.attachmentImageReference || "Image";
    return i18n.attachmentGenericFile || "File";
  }

  function buildAttachmentTitle(attachment) {
    const parts = [getAttachmentLabel(attachment)];
    if (attachment?.path) parts.push(attachment.path);
    if (attachment?.type === "document") {
      const meta = buildDocumentAttachmentMeta(attachment);
      if (meta) parts.push(meta);
    } else if (attachment?.mimeType) {
      parts.push(attachment.mimeType);
    }
    return parts.filter(Boolean).join("\n");
  }

  function buildDocumentAttachmentMeta(attachment) {
    const parts = [];
    if (attachment.mimeType) parts.push(attachment.mimeType);
    if (Number.isFinite(Number(attachment.byteLength))) parts.push(formatByteCount(Number(attachment.byteLength)));
    if (attachment.status === "unavailable") parts.push(formatAttachmentUnavailableReason(attachment.reason));
    return parts.filter(Boolean).join(" / ");
  }

  function formatAttachmentUnavailableReason(reason) {
    if (reason === "tooLarge") return i18n.attachmentTooLarge || "Too large";
    if (reason === "unsupported") return i18n.attachmentUnsupported || "Unsupported";
    if (reason === "missing") return i18n.attachmentMissing || "Missing";
    if (reason === "disabled") return i18n.imageDisabled || "Disabled";
    return i18n.attachmentUnavailable || "Unavailable";
  }

  function formatAttachmentLineRange(attachment) {
    const line = sanitizePositiveNumber(attachment?.line);
    const endLine = sanitizePositiveNumber(attachment?.endLine);
    if (!line) return "";
    if (endLine && endLine > line) return `:${line}-${endLine}`;
    return `:${line}`;
  }

  function sanitizePositiveNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 1 ? Math.floor(num) : undefined;
  }

  function formatByteCount(value) {
    const bytes = Math.max(0, Math.floor(Number(value) || 0));
    if (bytes < 1024) return `${bytes} B`;
    const kib = bytes / 1024;
    if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
    const mib = kib / 1024;
    return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
  }

  function renderMessageImages(images, allPreviewImages) {
    const thumbnailSize = imageSettings.thumbnailSize || "medium";
    const wrap = el("div", { className: `messageImages messageImages-${thumbnailSize}` });
    const previewImages = Array.isArray(allPreviewImages) ? allPreviewImages : images.filter(canPreviewImage);
    for (const image of images) {
      wrap.appendChild(renderMessageImage(image, previewImages, previewImages.indexOf(image)));
    }
    return wrap;
  }

  function getImageAttachmentLabel(value) {
    const label = typeof value === "string" ? value.trim() : "";
    if (label && label !== "Image attachment" && label !== "image-attachment") return label;
    return getSafeUiText(i18n.imageAttachmentLabel, "Image attachment");
  }

  function renderMessageImage(image, previewImages, previewIndex) {
    const label = getImageAttachmentLabel(image.label);
    const imageId = getImageId(image);
    const src = getImageSrc(image);

    if (isSafeDataImageSrc(src)) {
      const frame = el("button", {
        className: "messageImageFrame messageImageFrame-available",
        type: "button",
        title: i18n.imageOpenPreview || label,
      });
      frame.setAttribute("aria-label", i18n.imageOpenPreview || label);
      const img = el("img", { className: "messageImage", alt: label, loading: "lazy" });
      img.src = src;
      img.title = label;
      frame.appendChild(img);
      frame.addEventListener("click", () => {
        openImagePreview(previewImages, previewIndex);
      });
      return frame;
    }

    if (canRequestImageData(image)) {
      const frame = el("button", {
        className: "messageImageFrame messageImageFrame-available messageImageFrame-loading",
        type: "button",
        title: getImageLoadingText(),
      });
      frame.dataset.imageId = imageId;
      frame.dataset.imageLabel = label;
      frame.setAttribute("aria-label", label);
      frame.appendChild(renderImageLoadingContent());
      frame.addEventListener("click", () => {
        requestImageData(imageId);
        openImagePreview(previewImages, previewIndex);
      });
      observeLazyImageFrame(frame);
      return frame;
    }

    const frame = el("div", { className: "messageImageFrame" });
    frame.classList.add("messageImageFrame-unavailable");
    const title = el("div", { className: "messageImageUnavailableTitle" });
    title.textContent = i18n.imageUnavailable || "Image unavailable";
    frame.appendChild(title);

    const reason = el("div", { className: "messageImageUnavailableReason" });
    reason.textContent = formatImageUnavailableReason(image);
    frame.appendChild(reason);
    return frame;
  }

  function isSafeDataImageSrc(src) {
    return typeof src === "string" && /^data:image\/(?:png|jpeg|gif|webp)(?:;[^,]*)?,/i.test(src.trim());
  }

  function isPreviewableImage(image) {
    return !!(image && image.status === "available" && isSafeDataImageSrc(getImageSrc(image)));
  }

  function canPreviewImage(image) {
    return isPreviewableImage(image) || canRequestImageData(image);
  }

  function canRequestImageData(image) {
    return !!(
      image &&
      image.status === "available" &&
      image.dataOmitted === true &&
      getImageId(image) &&
      !failedImageIds.has(getImageId(image))
    );
  }

  function getImageId(image) {
    return image && typeof image.id === "string" ? image.id.trim() : "";
  }

  function getImageSrc(image) {
    const directSrc = image && typeof image.src === "string" ? image.src.trim() : "";
    if (isSafeDataImageSrc(directSrc)) return directSrc;
    const cached = imageDataById.get(getImageId(image));
    const cachedSrc = cached && typeof cached.src === "string" ? cached.src.trim() : "";
    return isSafeDataImageSrc(cachedSrc) ? cachedSrc : "";
  }

  function getImageLoadingText() {
    return getSafeUiText(i18n.imageLoading, "Loading image...");
  }

  function renderImageLoadingContent() {
    const text = el("div", { className: "messageImageLoadingText" });
    text.textContent = getImageLoadingText();
    return text;
  }

  function observeLazyImageFrame(frame) {
    if (!(frame instanceof HTMLElement)) return;
    const imageId = typeof frame.dataset.imageId === "string" ? frame.dataset.imageId : "";
    if (!imageId) return;
    if (imageDataById.has(imageId)) {
      applyImageDataToFrame(frame, imageId);
      return;
    }
    if (lazyImageObserver) {
      lazyImageObserver.observe(frame);
      return;
    }
    requestImageData(imageId);
  }

  function resetImageDataCache() {
    imageDataById.clear();
    pendingImageIds.clear();
    failedImageIds.clear();
    if (lazyImageObserver) lazyImageObserver.disconnect();
  }

  function requestImageData(imageId) {
    const safeImageId = typeof imageId === "string" ? imageId.trim() : "";
    if (!safeImageId || safeImageId.length > 160) return;
    if (imageDataById.has(safeImageId) || pendingImageIds.has(safeImageId) || failedImageIds.has(safeImageId)) return;
    pendingImageIds.add(safeImageId);
    vscode.postMessage({
      type: "requestImageData",
      fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
      imageId: safeImageId,
    });
  }

  function handleImageDataMessage(msg) {
    const imageId = typeof msg.imageId === "string" ? msg.imageId.trim() : "";
    if (!imageId) return;
    if (!isCurrentModelMessage(msg)) return;

    pendingImageIds.delete(imageId);
    const src = typeof msg.src === "string" ? msg.src.trim() : "";
    if (!isSafeDataImageSrc(src)) {
      failedImageIds.add(imageId);
      updateImageFailureElements(imageId);
      return;
    }

    failedImageIds.delete(imageId);
    imageDataById.set(imageId, {
      src,
      mimeType: typeof msg.mimeType === "string" ? msg.mimeType : "",
      label: typeof msg.label === "string" ? msg.label : "",
    });
    trimCachedImageData();
    updateLoadedImageElements(imageId);
    syncOpenImagePreviewAfterImageLoad(imageId);
  }

  function handleImageDataFailedMessage(msg) {
    const imageId = typeof msg.imageId === "string" ? msg.imageId.trim() : "";
    if (!imageId) return;
    if (!isCurrentModelMessage(msg)) return;
    pendingImageIds.delete(imageId);
    failedImageIds.add(imageId);
    updateImageFailureElements(imageId);
  }

  function handlePatchEntryDetailsMessage(msg) {
    if (!isCurrentModelMessage(msg)) return;
    const entryId = getPatchEntryId({ id: msg.entryId });
    const entry = msg.entry && typeof msg.entry === "object" ? msg.entry : null;
    if (!entryId || !entry) return;

    withPageSearchContentMutation(
      () => {
        const wasPending = patchEntryDetailsLoading.has(entryId) || patchEntryDetailsFailed.has(entryId);
        const hadLoaded = patchEntryDetailsById.has(entryId);
        patchEntryDetailsLoading.delete(entryId);
        patchEntryDetailsFailed.delete(entryId);
        patchEntryDetailsById.set(entryId, {
          ...entry,
          id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : entryId,
          detailsOmitted: false,
        });
        refreshPatchEntryDetails(entryId);
        return wasPending || !hadLoaded;
      },
      { refreshImmediately: true },
    );
  }

  function handlePatchEntryDetailsFailedMessage(msg) {
    if (!isCurrentModelMessage(msg)) return;
    const entryId = getPatchEntryId({ id: msg.entryId });
    if (!entryId) return;

    withPageSearchContentMutation(
      () => {
        const failedMessage = getSafeUiText(msg.message, i18n.patchDetailsLoadFailed || "Failed to load diff details.");
        const wasLoading = patchEntryDetailsLoading.has(entryId);
        const hadSameFailure = patchEntryDetailsFailed.get(entryId) === failedMessage;
        // True no-op re-delivery of an identical failure: don't re-render the error body
        // (which would destroy existing page-search marks) and don't advance the revision.
        if (!wasLoading && hadSameFailure) return false;
        patchEntryDetailsLoading.delete(entryId);
        patchEntryDetailsFailed.set(entryId, failedMessage);
        refreshPatchEntryDetails(entryId);
        return true;
      },
      { refreshImmediately: true },
    );
  }

  function isCurrentModelMessage(msg) {
    const messagePath = typeof msg.fsPath === "string" ? msg.fsPath : "";
    const modelPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
    return !messagePath || !modelPath || messagePath === modelPath;
  }

  function trimCachedImageData() {
    while (imageDataById.size > MAX_CACHED_IMAGE_DATA) {
      const firstKey = imageDataById.keys().next().value;
      if (typeof firstKey !== "string") return;
      imageDataById.delete(firstKey);
    }
  }

  function updateLoadedImageElements(imageId) {
    for (const frame of document.querySelectorAll(".messageImageFrame[data-image-id]")) {
      if (!(frame instanceof HTMLElement) || frame.dataset.imageId !== imageId) continue;
      applyImageDataToFrame(frame, imageId);
    }
  }

  function applyImageDataToFrame(frame, imageId) {
    const cached = imageDataById.get(imageId);
    if (!cached || !isSafeDataImageSrc(cached.src)) return;
    if (lazyImageObserver) lazyImageObserver.unobserve(frame);

    const label = getImageAttachmentLabel(frame.dataset.imageLabel || cached.label);
    const img = el("img", { className: "messageImage", alt: label, loading: "lazy" });
    img.src = cached.src;
    img.title = label;
    frame.classList.remove("messageImageFrame-loading");
    frame.classList.add("messageImageFrame-available");
    frame.title = i18n.imageOpenPreview || label;
    frame.setAttribute("aria-label", i18n.imageOpenPreview || label);
    frame.replaceChildren(img);
  }

  function updateImageFailureElements(imageId) {
    for (const frame of document.querySelectorAll(".messageImageFrame[data-image-id]")) {
      if (!(frame instanceof HTMLElement) || frame.dataset.imageId !== imageId) continue;
      if (lazyImageObserver) lazyImageObserver.unobserve(frame);
      frame.className = "messageImageFrame messageImageFrame-unavailable";
      frame.removeAttribute("data-image-id");
      frame.replaceChildren();
      const title = el("div", { className: "messageImageUnavailableTitle" });
      title.textContent = i18n.imageUnavailable || "Image unavailable";
      const reason = el("div", { className: "messageImageUnavailableReason" });
      reason.textContent = i18n.imageInvalid || "The image data could not be displayed.";
      frame.appendChild(title);
      frame.appendChild(reason);
      if (frame instanceof HTMLButtonElement) frame.disabled = true;
    }
  }

  function syncOpenImagePreviewAfterImageLoad(imageId) {
    if (!imagePreview || !Array.isArray(imagePreview.images)) return;
    const cached = imageDataById.get(imageId);
    if (!cached || !isSafeDataImageSrc(cached.src)) return;

    let changed = false;
    for (const image of imagePreview.images) {
      if (!image || image.imageId !== imageId) continue;
      image.src = cached.src;
      changed = true;
    }
    if (!changed) return;

    const preview = ensureImagePreview();
    const current = getCurrentPreviewImage();
    if (current && current.imageId === imageId) {
      applyImagePreviewCurrentImage();
    }
    renderImagePreviewThumbnails(preview);
  }

  function formatImageUnavailableReason(image) {
    const reason = image && typeof image.reason === "string" ? image.reason : "";
    if (reason === "tooLarge") return i18n.imageTooLarge || "The image is too large to display.";
    if (reason === "unsupported") return i18n.imageUnsupported || "This image format is not supported.";
    if (reason === "missing") return i18n.imageMissing || "The local image file could not be found.";
    if (reason === "remote") return i18n.imageRemote || "This image requires an external file reference.";
    if (reason === "disabled") return i18n.imageDisabled || "Image display is disabled in settings.";
    return i18n.imageInvalid || "The image data could not be displayed.";
  }

  function openImagePreview(images, index) {
    const previewImages = Array.isArray(images) ? images.filter(canPreviewImage).map(toPreviewImage) : [];
    if (previewImages.length === 0) return;
    const safeIndex = Number.isFinite(index)
      ? Math.min(previewImages.length - 1, Math.max(0, Math.floor(index)))
      : 0;
    const preview = ensureImagePreview();
    imagePreview = {
      images: previewImages,
      index: safeIndex,
      actualSize: false,
    };
    preview.overlay.hidden = false;
    document.body.classList.add("imagePreviewOpen");
    renderImagePreviewThumbnails(preview);
    applyImagePreviewCurrentImage();
    scheduleRunningTurnFallbackUpdate();
    preview.closeButton.focus();
  }

  function closeImagePreview() {
    const preview = ensureImagePreview();
    preview.overlay.hidden = true;
    preview.image.removeAttribute("src");
    preview.thumbnailStrip.replaceChildren();
    document.body.classList.remove("imagePreviewOpen");
    imagePreview = null;
    scheduleRunningTurnFallbackUpdate();
  }

  function isImagePreviewOpen() {
    return !!imagePreview && !!document.querySelector(".imagePreviewOverlay:not([hidden])");
  }

  function toggleImagePreviewSize() {
    if (!imagePreview) return;
    imagePreview.actualSize = !imagePreview.actualSize;
    syncImagePreviewControls();
  }

  function navigateImagePreview(delta) {
    if (!imagePreview || !Array.isArray(imagePreview.images) || imagePreview.images.length <= 1) return;
    const nextIndex = clampImagePreviewIndex(imagePreview.index + delta, imagePreview.images.length);
    if (nextIndex === imagePreview.index) return;
    imagePreview.index = nextIndex;
    imagePreview.actualSize = false;
    applyImagePreviewCurrentImage();
  }

  function applyImagePreviewCurrentImage() {
    const preview = ensureImagePreview();
    const image = getCurrentPreviewImage();
    if (!image) {
      closeImagePreview();
      return;
    }

    const src = getPreviewImageSrc(image);
    if (isSafeDataImageSrc(src)) {
      preview.image.src = src;
      preview.image.classList.remove("imagePreviewImage-loading");
    } else {
      preview.image.removeAttribute("src");
      preview.image.classList.add("imagePreviewImage-loading");
      requestImageData(image.imageId);
    }
    preview.image.alt = image.label;
    preview.image.title = image.label;
    preview.saveButton.disabled = !image.imageId || !isSafeDataImageSrc(src);
    updateImagePreviewActiveThumbnail(preview);
    syncImagePreviewControls();
  }

  function syncImagePreviewControls() {
    const preview = ensureImagePreview();
    const actualSize = !!(imagePreview && imagePreview.actualSize);
    const hasImages = !!(imagePreview && Array.isArray(imagePreview.images) && imagePreview.images.length > 0);
    preview.overlay.classList.toggle("imagePreviewOverlay-actual", actualSize);
    preview.gallery.hidden = !hasImages;
    const label = actualSize
      ? i18n.imageFitPreview || "Fit to window"
      : i18n.imageActualSize || "Actual size";
    preview.sizeButton.title = label;
    preview.sizeButton.setAttribute("aria-label", label);
    preview.sizeButton.innerHTML = actualSize ? CARD_RESTORE_ICON_SVG : CARD_EXPAND_ICON_SVG;
    preview.saveButton.title = i18n.imageSave || "Save image";
    preview.saveButton.setAttribute("aria-label", i18n.imageSave || "Save image");
    preview.closeButton.title = i18n.imageClosePreview || "Close image preview";
    preview.closeButton.setAttribute("aria-label", i18n.imageClosePreview || "Close image preview");
    preview.prevButton.title = i18n.imagePrevious || "Previous image";
    preview.prevButton.setAttribute("aria-label", i18n.imagePrevious || "Previous image");
    preview.nextButton.title = i18n.imageNext || "Next image";
    preview.nextButton.setAttribute("aria-label", i18n.imageNext || "Next image");
    updateImagePreviewGalleryScrollState(preview);
  }

  function saveImagePreview() {
    const image = getCurrentPreviewImage();
    if (!image || !image.imageId) return;
    vscode.postMessage({
      type: "saveImage",
      imageId: image.imageId,
      fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
    });
  }

  function getCurrentPreviewImage() {
    if (!imagePreview || !Array.isArray(imagePreview.images) || imagePreview.images.length === 0) return null;
    const index = clampImagePreviewIndex(imagePreview.index, imagePreview.images.length);
    imagePreview.index = index;
    return imagePreview.images[index] || null;
  }

  function toPreviewImage(image) {
    const label = getImageAttachmentLabel(image.label);
    const imageId = getImageId(image);
    return {
      imageId,
      src: getImageSrc(image),
      label,
    };
  }

  function getPreviewImageSrc(image) {
    if (!image) return "";
    const directSrc = typeof image.src === "string" ? image.src.trim() : "";
    if (isSafeDataImageSrc(directSrc)) return directSrc;
    const cached = imageDataById.get(typeof image.imageId === "string" ? image.imageId : "");
    const cachedSrc = cached && typeof cached.src === "string" ? cached.src.trim() : "";
    return isSafeDataImageSrc(cachedSrc) ? cachedSrc : "";
  }

  function clampImagePreviewIndex(index, length) {
    if (!Number.isFinite(index) || length <= 0) return 0;
    return Math.min(length - 1, Math.max(0, Math.floor(index)));
  }

  function renderImagePreviewThumbnails(preview) {
    preview.thumbnailStrip.replaceChildren();
    if (!imagePreview || !Array.isArray(imagePreview.images) || imagePreview.images.length === 0) {
      updateImagePreviewGalleryScrollState(preview);
      return;
    }

    imagePreview.images.forEach((image, index) => {
      const button = el("button", {
        className: "imagePreviewThumb",
        type: "button",
        title: image.label,
      });
      button.dataset.previewIndex = String(index);
      button.setAttribute("aria-label", image.label);
      const src = getPreviewImageSrc(image);
      if (isSafeDataImageSrc(src)) {
        const thumb = el("img", { className: "imagePreviewThumbImage", alt: "" });
        thumb.src = src;
        button.appendChild(thumb);
      } else {
        button.classList.add("imagePreviewThumb-loading");
      }
      button.addEventListener("click", () => {
        if (!imagePreview) return;
        imagePreview.index = index;
        imagePreview.actualSize = false;
        applyImagePreviewCurrentImage();
        button.blur();
        preview.overlay.focus({ preventScroll: true });
      });
      preview.thumbnailStrip.appendChild(button);
    });

    updateImagePreviewActiveThumbnail(preview);
    requestAnimationFrame(() => updateImagePreviewGalleryScrollState(preview));
  }

  function updateImagePreviewActiveThumbnail(preview) {
    const activeIndex = imagePreview ? imagePreview.index : -1;
    for (const thumb of preview.thumbnailStrip.querySelectorAll(".imagePreviewThumb")) {
      const index = Number(thumb.dataset.previewIndex);
      const active = index === activeIndex;
      thumb.classList.toggle("imagePreviewThumb-active", active);
      thumb.setAttribute("aria-current", active ? "true" : "false");
      if (active) {
        thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  }

  function updateImagePreviewGalleryScrollState(preview) {
    if (!preview || !preview.thumbnailStrip || !preview.prevButton || !preview.nextButton) return;
    const imageCount = imagePreview && Array.isArray(imagePreview.images) ? imagePreview.images.length : 0;
    const activeIndex = imagePreview ? imagePreview.index : 0;
    const canNavigate = imageCount > 1;
    preview.prevButton.hidden = !canNavigate;
    preview.nextButton.hidden = !canNavigate;
    preview.prevButton.disabled = !canNavigate || activeIndex <= 0;
    preview.nextButton.disabled = !canNavigate || activeIndex >= imageCount - 1;
  }

  function ensureImagePreview() {
    const existing = document.querySelector(".imagePreviewOverlay");
    if (existing) {
      return {
        overlay: existing,
        image: existing.querySelector(".imagePreviewImage"),
        gallery: existing.querySelector(".imagePreviewGallery"),
        thumbnailStrip: existing.querySelector(".imagePreviewThumbs"),
        prevButton: existing.querySelector(".imagePreviewThumbScrollPrev"),
        nextButton: existing.querySelector(".imagePreviewThumbScrollNext"),
        saveButton: existing.querySelector(".imagePreviewSave"),
        sizeButton: existing.querySelector(".imagePreviewSize"),
        closeButton: existing.querySelector(".imagePreviewClose"),
      };
    }

    const overlay = el("div", { className: "imagePreviewOverlay" });
    overlay.hidden = true;
    overlay.tabIndex = -1;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const surface = el("div", { className: "imagePreviewSurface" });
    const toolbar = el("div", { className: "imagePreviewToolbar" });
    const gallery = el("div", { className: "imagePreviewGallery" });
    const prevButton = el("button", { className: "imagePreviewButton imagePreviewThumbScrollPrev", type: "button" });
    const thumbnailStrip = el("div", { className: "imagePreviewThumbs" });
    const nextButton = el("button", { className: "imagePreviewButton imagePreviewThumbScrollNext", type: "button" });
    const actions = el("div", { className: "imagePreviewActions" });
    const saveButton = el("button", { className: "imagePreviewButton imagePreviewSave", type: "button" });
    const sizeButton = el("button", { className: "imagePreviewButton imagePreviewSize", type: "button" });
    const closeButton = el("button", { className: "imagePreviewButton imagePreviewClose", type: "button" });
    prevButton.innerHTML = NAV_LEFT_ICON_SVG;
    nextButton.innerHTML = NAV_RIGHT_ICON_SVG;
    saveButton.innerHTML = SAVE_ICON_SVG;
    sizeButton.innerHTML = CARD_EXPAND_ICON_SVG;
    closeButton.innerHTML = CLOSE_ICON_SVG;
    gallery.appendChild(prevButton);
    gallery.appendChild(thumbnailStrip);
    gallery.appendChild(nextButton);
    actions.appendChild(saveButton);
    actions.appendChild(sizeButton);
    actions.appendChild(closeButton);
    toolbar.appendChild(gallery);
    toolbar.appendChild(actions);

    const viewport = el("div", { className: "imagePreviewViewport" });
    const image = el("img", { className: "imagePreviewImage", alt: "" });
    viewport.appendChild(image);
    surface.appendChild(toolbar);
    surface.appendChild(viewport);
    overlay.appendChild(surface);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeImagePreview();
    });
    prevButton.addEventListener("click", () => navigateImagePreview(-1));
    nextButton.addEventListener("click", () => navigateImagePreview(1));
    thumbnailStrip.addEventListener("scroll", () => {
      updateImagePreviewGalleryScrollState({ thumbnailStrip, prevButton, nextButton });
    });
    saveButton.addEventListener("click", saveImagePreview);
    sizeButton.addEventListener("click", toggleImagePreviewSize);
    closeButton.addEventListener("click", closeImagePreview);

    syncImagePreviewControls();
    return { overlay, image, gallery, thumbnailStrip, prevButton, nextButton, saveButton, sizeButton, closeButton };
  }

  function resolveMessageCollapseState(item, role, text) {
    if (showDetails) return { canCollapse: false, collapsed: false };
    if (role !== "user" && role !== "assistant") return { canCollapse: false, collapsed: false };
    if (!item || typeof item.messageIndex !== "number") return { canCollapse: false, collapsed: false };
    const foldingMode = role === "user" ? userLongMessageFolding : assistantLongMessageFolding;
    if (foldingMode === "off") {
      return { canCollapse: false, collapsed: false };
    }
    if (!canCollapseMessage(role, text, foldingMode)) return { canCollapse: false, collapsed: false };
    return {
      canCollapse: true,
      collapsed: !expandedMessageIndexes.has(item.messageIndex),
    };
  }

  function canCollapseMessage(role, text, foldingMode) {
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) return false;

    const lineCount = countMessageLines(normalizedText);
    const charCount = normalizedText.length;
    const hasCodeFence = normalizedText.includes("```");
    const useCompactThreshold = foldingMode === "always";
    if (role === "user") {
      return useCompactThreshold
        ? charCount > 240 || lineCount > 5 || (hasCodeFence && lineCount > 4)
        : charCount > 900 || lineCount > 14 || (hasCodeFence && lineCount > 10);
    }
    return useCompactThreshold
      ? charCount > 320 || lineCount > 7 || (hasCodeFence && lineCount > 5)
      : charCount > 1400 || lineCount > 20 || (hasCodeFence && lineCount > 12);
  }

  function countMessageLines(text) {
    return String(text || "").replace(/\r\n/g, "\n").split("\n").length;
  }

  function toggleMessageExpansion(messageIndex, expand) {
    if (typeof messageIndex !== "number") return;
    const changed = withPageSearchContentMutation(() => {
      const before = expandedMessageIndexes.has(messageIndex);
      if (expand) expandedMessageIndexes.add(messageIndex);
      else expandedMessageIndexes.delete(messageIndex);
      return before !== expandedMessageIndexes.has(messageIndex);
    });
    if (!changed) return;
    render();
    if (typeof selectedMessageIndex === "number") restoreHighlight(selectedMessageIndex);
    const target = document.getElementById(`msg-${messageIndex}`);
    if (target) target.scrollIntoView({ block: "nearest" });
  }

  function renderPatchGroup(item, itemIndex, cardKey) {
    const row = el("div", { className: "row tool" });
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const allDiffActive = entries.length > 0 && isPatchGroupAllDiffActive(cardKey);
    const bubble = el("div", { className: "bubble tool toolCard patchGroupCard toolCard-kind-edit" });
    applyTimelineCardWidthState(bubble, cardKey);
    bubble.classList.toggle("patchGroupCard-allDiff", allDiffActive);
    applyBookmarkMetadata(bubble, item);
    bubble.id = `patch-group-${itemIndex}`;
    bubble.dataset.patchGroupIndex = String(itemIndex);

    const header = el("div", { className: "toolCardHeader" });
    const titleWrap = el("div", { className: "toolCardTitleWrap" });
    const icon = el("span", { className: "toolCardIcon", "aria-hidden": "true" });
    icon.innerHTML = getToolIconSvg("edit");
    titleWrap.appendChild(icon);

    const title = el("div", { className: "toolCardTitle" });
    title.textContent = formatTemplate(
      getSafeUiText(i18n.patchFilesEdited || i18n.patchGroupCount, "Edited {0} files"),
      item.entryCount || (Array.isArray(item.entries) ? item.entries.length : 0),
    );
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    const headerActions = el("div", { className: "toolCardHeaderActions patchGroupHeaderActions" });
    const badge = el("div", { className: "patchGroupSummary" });
    badge.appendChild(renderSignedCountBadge(item.totalAdded, "add"));
    badge.appendChild(renderSignedCountBadge(item.totalRemoved, "remove"));
    headerActions.appendChild(badge);

    if (entries.length > 0 && normalizePatchGroupCardKey(cardKey)) {
      headerActions.appendChild(createPatchGroupAllDiffButton(cardKey, entries, allDiffActive));
    }

    const nav = patchGroupNavMap.get(itemIndex) || { prevIndex: null, nextIndex: null };
    const navActions = el("div", { className: "messageNav patchGroupNav" });
    navActions.appendChild(createPatchGroupNavButton("prev", nav.prevIndex));
    navActions.appendChild(createPatchGroupNavButton("next", nav.nextIndex));
    headerActions.appendChild(navActions);
    appendBookmarkButton(headerActions, item);
    if (!allDiffActive) headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
    header.appendChild(headerActions);
    bubble.appendChild(header);

    if (typeof item.timestampIso === "string" || typeof item.turnId === "string") {
      const metaLine = el("div", { className: "toolCardMetaLine" });
      const metaTags = el("div", { className: "toolCardMetaTags" });
      if (typeof item.turnId === "string" && item.turnId.trim()) {
        appendToolMetaTag(metaTags, item.turnId.trim(), item.turnId.trim());
      }
      if (typeof item.timestampIso === "string" && item.timestampIso.trim()) {
        appendToolMetaTag(metaTags, formatIsoYmdHms(item.timestampIso), item.timestampIso);
      }
      if (metaTags.childElementCount > 0) {
        metaLine.appendChild(metaTags);
        bubble.appendChild(metaLine);
      }
    }

    if (entries.length === 0) {
      const empty = el("div", { className: "toolCardSecondary" });
      empty.textContent = i18n.patchNoDiff || "No diff available";
      bubble.appendChild(empty);
    } else {
      bubble.appendChild(renderPatchGroupCompactSummary(cardKey, item, entries, { allDiffActive }));
    }

    row.appendChild(bubble);
    return row;
  }

  function renderPatchGroupCompactSummary(cardKey, item, entries, options = {}) {
    const wrap = el("div", { className: "patchGroupCompactSummary" });
    if (!Array.isArray(entries) || entries.length === 0) return wrap;

    const searchExpanded = pageSearchTemporaryPatchGroupExpansionActive;
    const allDiffActive = options.allDiffActive === true;
    const fileListExpanded = allDiffActive || searchExpanded || expandedPatchGroupFileLists.has(cardKey);
    const visibleEntries = selectVisiblePatchGroupEntries(entries, fileListExpanded);
    const list = el("div", { className: "patchGroupFileList" });
    for (const entry of visibleEntries) {
      list.appendChild(renderPatchGroupVisibleEntry(cardKey, item, entry, { allDiffActive }));
    }
    wrap.appendChild(list);

    if (entries.length > 3 && !searchExpanded && !allDiffActive) {
      const remaining = countHiddenPatchGroupEntries(entries, visibleEntries);
      const toggle = el("button", { type: "button", className: "patchGroupFileToggle" });
      toggle.textContent = fileListExpanded
        ? getSafeUiText(i18n.patchShowFewerFiles, "Show fewer files")
        : formatTemplate(getSafeUiText(i18n.patchShowMoreFiles, "Show {0} more files"), remaining);
      toggle.title = toggle.textContent;
      toggle.setAttribute("aria-expanded", fileListExpanded ? "true" : "false");
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const changed = withPageSearchContentMutation(() => {
          const before = expandedPatchGroupFileLists.has(cardKey);
          if (fileListExpanded) expandedPatchGroupFileLists.delete(cardKey);
          else expandedPatchGroupFileLists.add(cardKey);
          return before !== expandedPatchGroupFileLists.has(cardKey);
        });
        if (changed) render();
      });
      if (fileListExpanded || remaining > 0) wrap.appendChild(toggle);
    }
    return wrap;
  }

  function selectVisiblePatchGroupEntries(entries, fileListExpanded) {
    if (!Array.isArray(entries)) return [];
    if (fileListExpanded) return entries;
    return entries.filter((entry, index) => index < 3 || isPatchGroupEntryExpanded(entry));
  }

  function countHiddenPatchGroupEntries(entries, visibleEntries) {
    const visibleIds = new Set(
      (Array.isArray(visibleEntries) ? visibleEntries : [])
        .map((entry) => getPatchEntryId(entry))
        .filter(Boolean),
    );
    let count = 0;
    for (const [index, entry] of entries.entries()) {
      const entryId = getPatchEntryId(entry);
      const visible = index < 3 || (entryId && visibleIds.has(entryId));
      if (!visible) count += 1;
    }
    return count;
  }

  function normalizePatchGroupCardKey(cardKey) {
    return typeof cardKey === "string" ? cardKey : "";
  }

  function collectPatchGroupEntryIds(entries) {
    return Array.from(
      new Set(
        (Array.isArray(entries) ? entries : [])
          .map((entry) => getPatchEntryId(entry))
          .filter(Boolean),
      ),
    );
  }

  function isPatchGroupAllDiffActive(cardKey) {
    const key = normalizePatchGroupCardKey(cardKey);
    return !!(key && allDiffPatchGroupKeys.has(key));
  }

  function createPatchGroupAllDiffButton(cardKey, entries, allDiffActive) {
    const button = el("button", { type: "button", className: "patchGroupAllDiffToggle" });
    syncPatchGroupAllDiffButton(button, allDiffActive);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePatchGroupAllDiff(cardKey, entries);
    });
    return button;
  }

  function syncPatchGroupAllDiffButton(button, allDiffActive) {
    if (!(button instanceof HTMLButtonElement)) return;
    const label = allDiffActive
      ? getSafeUiText(i18n.patchCloseAllDiffs, "Close all diffs")
      : getSafeUiText(i18n.patchOpenAllDiffs, "Open all diffs");
    const tooltip = allDiffActive
      ? getSafeUiText(i18n.patchCloseAllDiffsTooltip, "Close all file diffs and return to the compact summary")
      : getSafeUiText(i18n.patchOpenAllDiffsTooltip, "Expand this card to full width and open diffs for all files");
    button.textContent = label;
    button.title = tooltip;
    button.setAttribute("aria-label", tooltip);
    button.setAttribute("aria-pressed", allDiffActive ? "true" : "false");
  }

  function togglePatchGroupAllDiff(cardKey, entries) {
    setPatchGroupAllDiff(cardKey, entries, !isPatchGroupAllDiffActive(cardKey));
  }

  function setPatchGroupAllDiff(cardKey, entries, active) {
    const key = normalizePatchGroupCardKey(cardKey);
    const entryIds = collectPatchGroupEntryIds(entries);
    if (!key || entryIds.length === 0) return;

    const scrollAnchor = captureTimelineScrollAnchor();
    const changed = withPageSearchContentMutation(() => {
      let didChange = false;
      if (active) {
        const wasWide = wideTimelineCardKeys.has(key);
        didChange = setStringSetPresence(allDiffPatchGroupKeys, key, true) || didChange;
        didChange = setStringSetPresence(allDiffPatchGroupPreviouslyWideKeys, key, wasWide) || didChange;
        didChange = setStringSetPresence(wideTimelineCardKeys, key, true) || didChange;
        didChange = setStringSetPresence(expandedPatchGroupFileLists, key, true) || didChange;
        for (const entryId of entryIds) {
          didChange = setStringSetPresence(expandedPatchEntries, entryId, true) || didChange;
        }
        return didChange;
      }

      const wasPreviouslyWide = allDiffPatchGroupPreviouslyWideKeys.has(key);
      didChange = setStringSetPresence(allDiffPatchGroupKeys, key, false) || didChange;
      didChange = setStringSetPresence(expandedPatchGroupFileLists, key, false) || didChange;
      for (const entryId of entryIds) {
        didChange = setStringSetPresence(expandedPatchEntries, entryId, false) || didChange;
      }
      didChange = setStringSetPresence(wideTimelineCardKeys, key, wasPreviouslyWide) || didChange;
      didChange = setStringSetPresence(allDiffPatchGroupPreviouslyWideKeys, key, false) || didChange;
      return didChange;
    });
    if (!changed) return;

    render();
    restoreTimelineScrollAnchorAfterLayout(scrollAnchor, schedulePatchLayoutSync);
  }

  function setStringSetPresence(targetSet, value, present) {
    if (!(targetSet instanceof Set) || !value) return false;
    const hadValue = targetSet.has(value);
    if (present) targetSet.add(value);
    else targetSet.delete(value);
    return hadValue !== present;
  }

  function renderPatchGroupVisibleEntry(cardKey, item, entry, options = {}) {
    return isPatchGroupEntryExpanded(entry)
      ? renderPatchEntry(entry, { deferOmittedDetails: options.allDiffActive === true })
      : renderPatchGroupFileRow(cardKey, item, entry);
  }

  function isPatchGroupEntryExpanded(entry) {
    const entryId = getPatchEntryId(entry);
    return !!(entryId && expandedPatchEntries.has(entryId));
  }

  function renderPatchGroupFileRow(cardKey, item, entry) {
    const button = el("button", { type: "button", className: "patchGroupFileRow" });
    const title = buildPatchEntryTitle(entry);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.appendChild(el("span", { className: "patchGroupFilePath", textContent: title }));
    const counts = el("span", { className: "patchGroupFileCounts" });
    counts.appendChild(renderSignedCountBadge(entry.added, "add"));
    counts.appendChild(renderSignedCountBadge(entry.removed, "remove"));
    button.appendChild(counts);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPatchGroupEntry(cardKey, entry);
    });
    return button;
  }

  function openPatchGroupEntry(cardKey, entry) {
    openPatchGroupEntryTarget(cardKey, entry);
  }

  function openPatchGroupEntryTarget(cardKey, entry, options = {}) {
    const entryId = getPatchEntryId(entry);
    const changed = withPageSearchContentMutation(() => {
      const beforeFileList = expandedPatchGroupFileLists.has(cardKey);
      const beforeEntry = entryId ? expandedPatchEntries.has(entryId) : false;
      if (options.expandFileList === true) expandedPatchGroupFileLists.add(cardKey);
      if (entryId) expandedPatchEntries.add(entryId);
      return beforeFileList !== expandedPatchGroupFileLists.has(cardKey)
        || beforeEntry !== (entryId ? expandedPatchEntries.has(entryId) : false);
    });
    if (!changed) {
      if (entryId) revealPatchEntryDetails(entryId);
      return;
    }
    render();
    if (entryId) revealPatchEntryDetails(entryId);
  }

  function revealPatchEntryDetails(entryId) {
    if (!entryId) return;
    if (ensureTurnExpandedForReveal(getTurnIdForPatchEntryId(entryId), { render: true })) {
      requestAnimationFrame(() => revealPatchEntryDetails(entryId));
      return;
    }
    requestAnimationFrame(() => {
      const target = document.querySelector(`.patchEntry[data-patch-entry-id="${cssEscape(entryId)}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: "nearest" });
        target.focus?.();
      }
    });
  }

  function renderPatchEntry(entry, options = {}) {
    const details = el("details", { className: "patchEntry" });
    const entryId = getPatchEntryId(entry);
    const deferOmittedDetails = options.deferOmittedDetails === true;
    if (entryId) {
      details.dataset.patchEntryId = entryId;
      patchEntrySummaryById.set(entryId, entry);
    }
    details.open = entryId ? expandedPatchEntries.has(entryId) : false;
    let body;
    const ensurePatchBody = () => {
      if (!(body instanceof HTMLElement)) return;
      const renderEntry = resolvePatchEntryForDisplay(entry);
      if (!deferOmittedDetails && entry && entry.detailsOmitted && !hasLoadedPatchEntryDetails(entry)) {
        if (patchEntryDetailsFailed.has(entryId)) {
          renderPatchEntryDetailsError(body, entry);
          return;
        }
        renderPatchEntryDetailsLoading(body, entry);
        requestPatchEntryDetails(entry);
        return;
      }
      scheduleDeferredPatchEntryBody(body, details, renderEntry, inferPatchLanguage(renderEntry));
    };
    const clearPatchBody = () => {
      if (!(body instanceof HTMLElement)) return;
      if (deferredPatchObserver) deferredPatchObserver.unobserve(body);
      deferredPatchBodyRequests.delete(body);
      removeDeferredRenderItemsForPrefix(buildDeferredPatchBodyKey(entry));
      rememberPatchBodyHeight(body, resolvePatchEntryForDisplay(entry));
      body.textContent = "";
      body.classList.remove(
        "patchEntryBody-deferred",
        "patchEntryBody-rendering",
        "patchEntryBody-status",
        "patchEntryBody-hibernated",
      );
      body.removeAttribute("aria-busy");
      body.removeAttribute("data-deferred-state");
      body.style.removeProperty("min-height");
    };
    let summary;
    const applyPatchToggleLabel = () => {
      if (!(summary instanceof HTMLElement)) return;
      const label = details.open
        ? i18n.patchCollapse || "Collapse diff"
        : i18n.patchExpand || "Expand diff";
      summary.title = label;
      summary.setAttribute("aria-label", label);
    };
    details.addEventListener("toggle", () => {
      const opened = details.open;
      const shouldRebuildCompactRow = !!(entryId && !opened);
      const scrollAnchor = shouldRebuildCompactRow ? captureTimelineScrollAnchor() : null;
      const changed = withPageSearchContentMutation(
        () => {
          if (entryId) {
            if (opened) expandedPatchEntries.add(entryId);
            else expandedPatchEntries.delete(entryId);
          }
          if (opened) ensurePatchBody();
          else clearPatchBody();
          applyPatchToggleLabel();
          return true;
        },
        { refreshImmediately: !shouldRebuildCompactRow },
      );
      if (!changed) return;
      if (shouldRebuildCompactRow) {
        render();
        restoreTimelineScrollAnchorAfterLayout(scrollAnchor);
        return;
      }
    });

    summary = el("summary", { className: "patchEntrySummary" });
    applyPatchToggleLabel();

    const pathWrap = el("div", { className: "patchEntryPathWrap" });
    const pathEl = el("div", { className: "patchEntryPath" });
    pathEl.textContent = buildPatchEntryTitle(entry);
    pathEl.title = pathEl.textContent;
    pathWrap.appendChild(pathEl);
    summary.appendChild(pathWrap);

    const counts = el("div", { className: "patchEntryCounts" });
    counts.appendChild(renderSignedCountBadge(entry.added, "add"));
    counts.appendChild(renderSignedCountBadge(entry.removed, "remove"));
    summary.appendChild(counts);
    details.appendChild(summary);

    body = el("div", { className: "patchEntryBody" });
    if (entryId) body.dataset.patchEntryId = entryId;
    details.appendChild(body);
    if (details.open) ensurePatchBody();
    return details;
  }

  function resolvePatchEntryForDisplay(entry) {
    const entryId = getPatchEntryId(entry);
    return entryId && patchEntryDetailsById.has(entryId) ? patchEntryDetailsById.get(entryId) : entry;
  }

  function hasLoadedPatchEntryDetails(entry) {
    const entryId = getPatchEntryId(entry);
    return !!(entryId && patchEntryDetailsById.has(entryId));
  }

  function requestPatchEntryDetails(entry, options = {}) {
    const entryId = getPatchEntryId(entry);
    if (!entryId) return;
    if (!options.force && (patchEntryDetailsById.has(entryId) || patchEntryDetailsLoading.has(entryId))) return;
    patchEntryDetailsFailed.delete(entryId);
    patchEntryDetailsLoading.add(entryId);
    vscode.postMessage({
      type: "loadPatchEntryDetails",
      entry: buildPatchEntryDetailRequest(entry, entryId),
    });
  }

  function buildPatchEntryDetailRequest(entry, entryId) {
    return {
      entryId,
      callId: typeof entry.callId === "string" ? entry.callId : undefined,
      path: typeof entry.path === "string" ? entry.path : undefined,
      displayPath: typeof entry.displayPath === "string" ? entry.displayPath : undefined,
      movePath: typeof entry.movePath === "string" ? entry.movePath : undefined,
      moveDisplayPath: typeof entry.moveDisplayPath === "string" ? entry.moveDisplayPath : undefined,
      changeType: typeof entry.changeType === "string" ? entry.changeType : undefined,
    };
  }

  function renderPatchEntryDetailsLoading(body, entry) {
    resetPatchEntryBodyStatus(body, entry);
    body.setAttribute("aria-busy", "true");
    body.appendChild(renderLazyDetailsPlaceholder());
  }

  function renderPatchEntryDetailsError(body, entry) {
    resetPatchEntryBodyStatus(body, entry);
    const entryId = getPatchEntryId(entry);
    const wrap = el("div", { className: "patchEntryDetailsStatus" });
    const message = el("span", {});
    message.textContent =
      (entryId && patchEntryDetailsFailed.get(entryId)) ||
      getSafeUiText(i18n.patchDetailsLoadFailed, "Failed to load diff details.");
    wrap.appendChild(message);
    const retry = el("button", { type: "button", className: "patchEntryDetailsRetry" });
    retry.textContent = getSafeUiText(i18n.patchDetailsRetry, "Retry");
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (entryId) patchEntryDetailsFailed.delete(entryId);
      renderPatchEntryDetailsLoading(body, entry);
      requestPatchEntryDetails(entry, { force: true });
    });
    wrap.appendChild(retry);
    body.appendChild(wrap);
  }

  function resetPatchEntryBodyStatus(body, entry) {
    if (!(body instanceof HTMLElement)) return;
    if (deferredPatchObserver) deferredPatchObserver.unobserve(body);
    deferredPatchBodyRequests.delete(body);
    removeDeferredRenderItemsForPrefix(buildDeferredPatchBodyKey(entry));
    body.textContent = "";
    body.classList.remove("patchEntryBody-deferred", "patchEntryBody-rendering", "patchEntryBody-hibernated");
    body.classList.add("patchEntryBody-status");
    body.removeAttribute("aria-busy");
    body.removeAttribute("data-deferred-state");
    body.style.removeProperty("min-height");
  }

  function refreshPatchEntryDetails(entryId) {
    if (!entryId) return;
    const summaryEntry = patchEntrySummaryById.get(entryId);
    const loadedEntry = patchEntryDetailsById.get(entryId);
    for (const body of document.querySelectorAll(".patchEntryBody[data-patch-entry-id]")) {
      if (!(body instanceof HTMLElement) || body.dataset.patchEntryId !== entryId) continue;
      const details = body.closest(".patchEntry");
      if (!(details instanceof HTMLDetailsElement) || !details.open) continue;

      if (loadedEntry) {
        resetPatchEntryBodyStatus(body, loadedEntry);
        body.classList.remove("patchEntryBody-status");
        scheduleDeferredPatchEntryBody(body, details, loadedEntry, inferPatchLanguage(loadedEntry));
        continue;
      }
      if (summaryEntry && patchEntryDetailsFailed.has(entryId)) renderPatchEntryDetailsError(body, summaryEntry);
    }
  }

  function getPatchEntryId(entry) {
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    return id.length > 0 && id.length <= 512 ? id : "";
  }

  function hibernateOpenPatchBodies() {
    for (const body of document.querySelectorAll(".patchEntryBody[data-patch-entry-id]")) {
      if (!(body instanceof HTMLElement)) continue;
      if (body.dataset.deferredState === "hibernated") continue;
      const details = body.closest("details.patchEntry");
      if (!(details instanceof HTMLDetailsElement) || !details.open) continue;
      if (body.classList.contains("patchEntryBody-status")) continue;
      const entry = getPatchEntryForBody(body);
      if (!entry || (entry.detailsOmitted && !hasLoadedPatchEntryDetails(entry))) continue;

      const height = Math.ceil(body.getBoundingClientRect().height) || getEstimatedPatchBodyHeight(entry);
      if (height > 0) {
        patchBodyHeightByEntryId.set(getPatchEntryId(entry), height);
        body.style.setProperty("min-height", `${height}px`);
      }
      if (deferredPatchObserver) deferredPatchObserver.unobserve(body);
      deferredPatchBodyRequests.delete(body);
      removeDeferredRenderItemsForPrefix(buildDeferredPatchBodyKey(entry));
      body.textContent = "";
      body.classList.remove("patchEntryBody-deferred", "patchEntryBody-rendering");
      body.classList.add("patchEntryBody-hibernated");
      body.removeAttribute("aria-busy");
      body.dataset.deferredState = "hibernated";
    }
  }

  function restoreHibernatedPatchBodies(options = {}) {
    const force = options.force === true;
    for (const body of document.querySelectorAll('.patchEntryBody[data-deferred-state="hibernated"]')) {
      if (!(body instanceof HTMLElement)) continue;
      if (!force && !isSimplifiedPerformanceMode()) continue;
      const details = body.closest("details.patchEntry");
      if (!(details instanceof HTMLDetailsElement) || !details.open) continue;
      const entry = getPatchEntryForBody(body);
      if (!entry) continue;
      scheduleDeferredPatchEntryBody(body, details, entry, inferPatchLanguage(entry));
    }
  }

  function getPatchEntryForBody(body) {
    if (!(body instanceof HTMLElement)) return null;
    const entryId = typeof body.dataset.patchEntryId === "string" ? body.dataset.patchEntryId : "";
    if (!entryId) return null;
    const summaryEntry = patchEntrySummaryById.get(entryId);
    return summaryEntry ? resolvePatchEntryForDisplay(summaryEntry) : patchEntryDetailsById.get(entryId) || null;
  }

  function scheduleDeferredPatchEntryBody(body, details, entry, entryLanguage) {
    if (!(body instanceof HTMLElement) || !(details instanceof HTMLElement) || !entry) return;
    const key = buildDeferredPatchBodyKey(entry);
    if (body.dataset.deferredState === "rendered" || body.dataset.deferredState === "queued") return;

    body.dataset.deferredState = "queued";
    body.dataset.deferredKey = key;
    body.classList.remove("patchEntryBody-hibernated", "patchEntryBody-status");
    body.classList.add("patchEntryBody-deferred");
    body.setAttribute("aria-busy", "true");
    const estimatedHeight = getEstimatedPatchBodyHeight(entry);
    body.style.setProperty("min-height", `${estimatedHeight}px`);
    deferredPatchBodyRequests.set(body, {
      key,
      generation: deferredRenderGeneration,
      details,
      entry,
      entryLanguage,
    });

    const observer = getDeferredPatchObserver();
    if (observer) {
      observer.observe(body);
      return;
    }

    enqueueDeferredRender({
      key,
      generation: deferredRenderGeneration,
      element: body,
      render: () => beginDeferredPatchEntryBody(body, details, entry, entryLanguage),
    });
  }

  function beginDeferredPatchEntryBody(body, details, entry, entryLanguage) {
    if (!isPatchBodyRenderable(body, details)) return;
    body.textContent = "";
    body.classList.remove("patchEntryBody-deferred", "patchEntryBody-hibernated");
    body.classList.add("patchEntryBody-rendering");
    body.dataset.deferredState = "rendering";

    if (entry && entry.detailsOmitted && !hasLoadedPatchEntryDetails(entry)) {
      renderPatchEntryDetailsLoading(body, entry);
      requestPatchEntryDetails(entry);
      return;
    }

    if (entry.moveDisplayPath && entry.moveDisplayPath !== entry.displayPath) {
      const movedTo = el("div", { className: "patchEntryMove" });
      movedTo.textContent = formatTemplate(i18n.patchMovedTo || "Moved to: {0}", entry.moveDisplayPath);
      body.appendChild(movedTo);
    }

    const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
    if (hunks.length === 0) {
      const empty = el("div", { className: "toolCardSecondary" });
      empty.textContent = i18n.patchNoDiff || "No diff available";
      body.appendChild(empty);
      finalizeDeferredPatchEntryBody(body, entry);
      return;
    }

    let pendingHunks = hunks.length;
    const finalizeIfDone = () => {
      pendingHunks -= 1;
      if (pendingHunks <= 0) finalizeDeferredPatchEntryBody(body, entry);
    };

    hunks.forEach((hunk, hunkIndex) => {
      enqueueDeferredRender({
        key: `${buildDeferredPatchBodyKey(entry)}:hunk:${hunkIndex}`,
        generation: deferredRenderGeneration,
        element: body,
        render: () => {
          if (!isPatchBodyRenderable(body, details)) return;
          const hunkEl = renderPatchHunk(entry, hunk, entryLanguage, hunkIndex);
          body.appendChild(hunkEl);
          syncPatchHunkLayout(hunkEl);
          finalizeIfDone();
        },
      });
    });
  }

  function finalizeDeferredPatchEntryBody(body, entry) {
    if (!(body instanceof HTMLElement)) return;
    if (deferredPatchObserver) deferredPatchObserver.unobserve(body);
    deferredPatchBodyRequests.delete(body);
    body.classList.remove("patchEntryBody-deferred", "patchEntryBody-rendering");
    body.classList.remove("patchEntryBody-hibernated", "patchEntryBody-status");
    body.dataset.deferredState = "rendered";
    body.removeAttribute("aria-busy");
    body.style.removeProperty("min-height");
    rememberPatchBodyHeight(body, entry);
    // Page-search re-indexing after the diff paints is handled by runDeferredRenderItem,
    // which wraps every deferred hunk render in beginPageSearchContentMutation +
    // dispatchPageSearchContentMutationRefresh; no separate refresh is scheduled here.
  }

  function isPatchBodyRenderable(body, details) {
    return body instanceof HTMLElement && body.isConnected && details instanceof HTMLDetailsElement && details.open;
  }

  function buildDeferredPatchBodyKey(entry) {
    return `patch-body:${entry && entry.id ? entry.id : ""}`;
  }

  function getEstimatedPatchBodyHeight(entry) {
    const key = entry && entry.id ? entry.id : "";
    const cached = key ? patchBodyHeightByEntryId.get(key) : undefined;
    const numeric = Number(cached);
    return Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : DEFERRED_PATCH_PLACEHOLDER_MIN_HEIGHT;
  }

  function rememberPatchBodyHeight(body, entry) {
    if (!(body instanceof HTMLElement) || !entry || !entry.id) return;
    const height = Math.ceil(body.getBoundingClientRect().height);
    if (height > 0) patchBodyHeightByEntryId.set(entry.id, height);
  }

  function getDeferredPatchObserver() {
    if (typeof IntersectionObserver !== "function") return null;
    if (!(scrollRootEl instanceof HTMLElement)) return null;
    if (deferredPatchObserver) return deferredPatchObserver;
    deferredPatchObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          deferredPatchObserver?.unobserve(entry.target);
          const request = deferredPatchBodyRequests.get(entry.target);
          if (!request) continue;
          enqueueDeferredRender({
            key: request.key,
            generation: request.generation,
            element: entry.target,
            render: () => beginDeferredPatchEntryBody(entry.target, request.details, request.entry, request.entryLanguage),
          });
        }
      },
      {
        root: scrollRootEl,
        rootMargin: DEFERRED_PATCH_ROOT_MARGIN,
        threshold: 0,
      },
    );
    return deferredPatchObserver;
  }

  function enqueueDeferredRender(item) {
    if (!item || typeof item.key !== "string" || !item.key) return;
    if (item.generation !== deferredRenderGeneration) return;
    if (deferredRenderKeys.has(item.key)) return;
    deferredRenderKeys.add(item.key);
    deferredRenderQueue.push(item);
    scheduleDeferredRenderWork();
  }

  function resetDeferredRenderWork(options = {}) {
    if (options.nextGeneration === true) deferredRenderGeneration += 1;
    deferredRenderQueue = [];
    deferredRenderKeys.clear();
    cancelDeferredRenderSchedule();
    if (deferredPatchObserver) {
      deferredPatchObserver.disconnect();
      deferredPatchObserver = null;
    }
    if (deferredPageSearchRefreshTimer) {
      window.clearTimeout(deferredPageSearchRefreshTimer);
      deferredPageSearchRefreshTimer = 0;
    }
  }

  function removeDeferredRenderItemsForPrefix(prefix) {
    if (!prefix) return;
    deferredRenderQueue = deferredRenderQueue.filter((item) => !String(item.key || "").startsWith(prefix));
    for (const key of Array.from(deferredRenderKeys)) {
      if (key.startsWith(prefix)) deferredRenderKeys.delete(key);
    }
  }

  function cancelDeferredRenderSchedule() {
    if (deferredRenderFrame) {
      cancelAnimationFrame(deferredRenderFrame);
      deferredRenderFrame = 0;
    }
    if (deferredRenderTimer) {
      window.clearTimeout(deferredRenderTimer);
      deferredRenderTimer = 0;
    }
  }

  function scheduleDeferredRenderWork() {
    if (deferredRenderQueue.length === 0 || deferredRenderFrame || deferredRenderTimer) return;
    if (isDeferredRenderPaused()) return;
    deferredRenderFrame = requestAnimationFrame(() => {
      deferredRenderFrame = 0;
      processDeferredRenderQueue();
    });
  }

  function resumeDeferredRenderWork() {
    if (deferredRenderQueue.length > 0) scheduleDeferredRenderWork();
  }

  function isDeferredRenderPaused() {
    return document.visibilityState === "hidden" || isRestoreCoverBlockingTimeGuide();
  }

  function processDeferredRenderQueue() {
    if (isDeferredRenderPaused()) return;
    const deadline = performance.now() + DEFERRED_RENDER_FRAME_BUDGET_MS;
    sortDeferredRenderQueue();

    while (deferredRenderQueue.length > 0 && performance.now() <= deadline) {
      const item = deferredRenderQueue.shift();
      if (!item) continue;
      deferredRenderKeys.delete(item.key);
      if (item.generation !== deferredRenderGeneration) continue;
      if (!(item.element instanceof HTMLElement) || !item.element.isConnected) continue;

      const measurement = measureDeferredRenderHeight(item.element);
      try {
        runDeferredRenderItem(item);
      } catch (error) {
        console.error("Deferred render failed.", error);
      }
      compensateDeferredRenderHeight(measurement, item.element);
    }

    if (deferredRenderQueue.length === 0) return;
    deferredRenderTimer = window.setTimeout(() => {
      deferredRenderTimer = 0;
      scheduleDeferredRenderWork();
    }, 0);
  }

  function sortDeferredRenderQueue() {
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const viewportCenter = rootRect.top + rootRect.height / 2;
    deferredRenderQueue.sort((a, b) => {
      return getDeferredRenderDistance(a.element, viewportCenter) - getDeferredRenderDistance(b.element, viewportCenter);
    });
  }

  function getDeferredRenderDistance(element, viewportCenter) {
    if (!(element instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    const rect = element.getBoundingClientRect();
    if (rect.bottom >= viewportCenter && rect.top <= viewportCenter) return 0;
    return Math.min(Math.abs(rect.top - viewportCenter), Math.abs(rect.bottom - viewportCenter));
  }

  function measureDeferredRenderHeight(element) {
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      root,
      height: rect.height,
      aboveViewport: rect.bottom <= rootRect.top,
    };
  }

  function compensateDeferredRenderHeight(measurement, element) {
    if (!measurement || !measurement.aboveViewport || !(element instanceof HTMLElement)) return;
    const nextHeight = element.getBoundingClientRect().height;
    const delta = Math.round(nextHeight - measurement.height);
    if (delta !== 0) measurement.root.scrollTop += delta;
  }

  function runDeferredRenderItem(item) {
    if (!isPageSearchOpen()) {
      item.render();
      return;
    }
    const previousRevision = beginPageSearchContentMutation();
    try {
      item.render();
    } catch (error) {
      cancelPageSearchContentMutation(previousRevision);
      throw error;
    }
    dispatchPageSearchContentMutationRefresh(previousRevision, { refreshDelayMs: DEFERRED_SEARCH_REFRESH_DELAY_MS });
  }

  function populatePatchEntryBody(body, entry, entryLanguage) {
    if (!(body instanceof HTMLElement)) return;

    if (entry && entry.detailsOmitted) {
      body.appendChild(renderLazyDetailsPlaceholder());
      return;
    }

    if (entry.moveDisplayPath && entry.moveDisplayPath !== entry.displayPath) {
      const movedTo = el("div", { className: "patchEntryMove" });
      movedTo.textContent = formatTemplate(i18n.patchMovedTo || "Moved to: {0}", entry.moveDisplayPath);
      body.appendChild(movedTo);
    }

    const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
    if (hunks.length === 0) {
      const empty = el("div", { className: "toolCardSecondary" });
      empty.textContent = i18n.patchNoDiff || "No diff available";
      body.appendChild(empty);
      return;
    }

    for (const [hunkIndex, hunk] of hunks.entries()) {
      body.appendChild(renderPatchHunk(entry, hunk, entryLanguage, hunkIndex));
    }
    schedulePatchLayoutSync();
  }

  function renderPatchHunk(entry, hunk, entryLanguage, hunkIndex) {
    const wrap = el("section", { className: "patchHunk" });
    const hunkKey = buildPatchHunkKey(entry, hunkIndex);
    if (wrappedPatchHunkKeys.has(hunkKey)) wrap.classList.add("patchHunk-wrapEnabled");
    const header = el("div", { className: "patchHunkHeader" });
    const headerText = el("div", { className: "patchHunkHeaderText" });
    headerText.textContent = hunk.header || "@@";
    header.appendChild(headerText);

    const actions = el("div", { className: "patchHunkActions" });
    const wrapBtn = buildPatchWrapToggleButton(wrap, hunkKey);
    actions.appendChild(wrapBtn);

    const jumpTarget = getPatchJumpTarget(entry, hunk);
    if (jumpTarget) {
      const jumpBtn = el("button", { type: "button", className: "patchHunkActionBtn iconBtn" });
      jumpBtn.innerHTML = PATCH_JUMP_ICON_SVG;
      const jumpTooltip = formatTemplate(i18n.patchJumpTooltip || "Jump to line {0}", jumpTarget.line);
      jumpBtn.title = jumpTooltip;
      jumpBtn.setAttribute("aria-label", jumpTooltip);
      jumpBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: "openLocalFile",
          fsPath: jumpTarget.fsPath,
          line: jumpTarget.line,
        });
      });
      actions.appendChild(jumpBtn);
    }

    header.appendChild(actions);
    wrap.appendChild(header);

    const labels = el("div", { className: "patchDiffColumnLabels" });
    const before = el("div", { className: "patchDiffColumnLabel patchDiffColumnLabel-before" });
    before.textContent = i18n.patchBefore || "Before";
    const after = el("div", { className: "patchDiffColumnLabel patchDiffColumnLabel-after" });
    after.textContent = i18n.patchAfter || "After";
    labels.appendChild(before);
    labels.appendChild(after);
    wrap.appendChild(labels);

    const rows = Array.isArray(hunk.rows) ? hunk.rows : [];
    const blocks = el("div", { className: "patchDiffBlocks" });
    blocks.appendChild(renderPatchBlock(rows, "left", entryLanguage));
    blocks.appendChild(renderPatchBlock(rows, "right", entryLanguage));
    wrap.appendChild(blocks);
    return wrap;
  }

  function buildPatchHunkKey(entry, hunkIndex) {
    const entryId = entry && typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "patch";
    const safeIndex = Number.isInteger(hunkIndex) && hunkIndex >= 0 ? hunkIndex : 0;
    return `${entryId}:hunk:${safeIndex}`;
  }

  function buildPatchWrapToggleButton(hunkEl, hunkKey) {
    const button = el("button", { type: "button", className: "patchHunkActionBtn patchHunkActionBtn-wrap iconBtn" });
    syncPatchWrapButton(button, hunkEl instanceof HTMLElement && hunkEl.classList.contains("patchHunk-wrapEnabled"));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!(hunkEl instanceof HTMLElement)) return;
      const enabled = !hunkEl.classList.contains("patchHunk-wrapEnabled");
      hunkEl.classList.toggle("patchHunk-wrapEnabled", enabled);
      if (enabled) wrappedPatchHunkKeys.add(hunkKey);
      else wrappedPatchHunkKeys.delete(hunkKey);
      syncPatchWrapButton(button, enabled);
      schedulePatchLayoutSync();
    });
    return button;
  }

  function syncPatchWrapButton(button, enabled) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.innerHTML = enabled ? PATCH_WRAP_OFF_ICON_SVG : PATCH_WRAP_ON_ICON_SVG;
    const label = enabled
      ? i18n.patchWrapOffTooltip || i18n.patchWrapOff || "Keep diff lines on one row with horizontal scroll"
      : i18n.patchWrapOnTooltip || i18n.patchWrapOn || "Wrap long diff lines";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function getPatchJumpTarget(entry, hunk) {
    const rows = Array.isArray(hunk && hunk.rows) ? hunk.rows : [];
    const targetAfterLine = rows.find((row) => row && typeof row.rightLine === "number")?.rightLine;
    if (typeof targetAfterLine === "number") {
      const afterPath =
        entry && typeof entry.movePath === "string" && entry.movePath.trim()
          ? entry.movePath.trim()
          : entry && typeof entry.path === "string"
            ? entry.path
            : "";
      if (afterPath) return { fsPath: afterPath, line: targetAfterLine };
    }

    const targetBeforeLine = rows.find((row) => row && typeof row.leftLine === "number")?.leftLine;
    if (typeof targetBeforeLine === "number") {
      const beforePath = entry && typeof entry.path === "string" ? entry.path : "";
      if (beforePath) return { fsPath: beforePath, line: targetBeforeLine };
    }
    return null;
  }

  function renderPatchBlock(rows, side, entryLanguage) {
    const block = el("section", { className: `patchDiffBlock patchDiffBlock-${side}` });
    const lineColumn = el("div", { className: `patchDiffLineColumn patchDiffLineColumn-${side}` });
    const viewport = el("div", { className: `patchDiffViewport patchDiffViewport-${side}` });
    const textColumn = el("div", { className: `patchDiffTextColumn patchDiffTextColumn-${side}` });

    rows.forEach((row, index) => {
      const kind = row && typeof row.kind === "string" ? row.kind : "context";
      const lineValue =
        side === "left"
          ? row && typeof row.leftLine === "number"
            ? row.leftLine
            : null
          : row && typeof row.rightLine === "number"
            ? row.rightLine
            : null;
      const textValue =
        side === "left"
          ? row && typeof row.leftText === "string"
            ? row.leftText
            : ""
          : row && typeof row.rightText === "string"
            ? row.rightText
            : "";

      lineColumn.appendChild(renderPatchLineNumber(lineValue, side, kind, index));
      textColumn.appendChild(renderPatchTextCell(textValue, side, entryLanguage, kind, index));
    });

    viewport.appendChild(textColumn);
    block.appendChild(lineColumn);
    block.appendChild(viewport);
    return block;
  }

  function renderPatchLineNumber(value, side, kind, rowIndex) {
    const cell = el("div", {
      className: `patchDiffLineNo patchDiffLineNo-${side} patchDiffLineNo-${kind}`,
    });
    cell.dataset.rowIndex = String(rowIndex);
    cell.textContent = typeof value === "number" ? String(value) : "";
    return cell;
  }

  function renderPatchTextCell(text, side, entryLanguage, kind, rowIndex) {
    const cell = el("div", {
      className: `patchDiffText patchDiffText-${side} patchDiffText-${kind}`,
    });
    cell.dataset.rowIndex = String(rowIndex);
    const safeText = typeof text === "string" ? text : "";
    if (!safeText) {
      cell.textContent = " ";
      return cell;
    }

    const highlighted = createHighlightedInlineCodeElement(safeText, entryLanguage);
    if (highlighted) {
      cell.appendChild(highlighted);
      return cell;
    }

    cell.textContent = safeText;
    return cell;
  }

  function renderSignedCountBadge(value, kind) {
    const badge = el("span", { className: `patchCountBadge patchCountBadge-${kind}` });
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    badge.textContent = `${kind === "add" ? "+" : "-"}${safeValue}`;
    return badge;
  }

  function buildPatchEntryTitle(entry) {
    const basePath = entry && typeof entry.displayPath === "string" ? entry.displayPath : "";
    const movePath = entry && typeof entry.moveDisplayPath === "string" ? entry.moveDisplayPath : "";
    if (movePath && movePath !== basePath) return `${basePath} -> ${movePath}`;
    return basePath;
  }

  function inferPatchLanguage(entry) {
    const candidates = [
      entry && typeof entry.path === "string" ? entry.path : "",
      entry && typeof entry.movePath === "string" ? entry.movePath : "",
      entry && typeof entry.displayPath === "string" ? entry.displayPath : "",
      entry && typeof entry.moveDisplayPath === "string" ? entry.moveDisplayPath : "",
    ];

    for (const candidate of candidates) {
      const language = inferPatchLanguageFromPath(candidate);
      if (language) return language;
    }
    return "";
  }

  function schedulePatchLayoutSync() {
    if (patchLayoutFrame) cancelAnimationFrame(patchLayoutFrame);
    patchLayoutFrame = requestAnimationFrame(() => {
      patchLayoutFrame = 0;
      syncAllPatchHunkLayouts();
    });
  }

  function syncAllPatchHunkLayouts() {
    for (const hunkEl of document.querySelectorAll(".patchHunk")) {
      if (!(hunkEl instanceof HTMLElement)) continue;
      syncPatchHunkLayout(hunkEl);
    }
  }

  function syncPatchHunkLayout(hunkEl) {
    const leftLines = Array.from(hunkEl.querySelectorAll(".patchDiffLineColumn-left .patchDiffLineNo"));
    const rightLines = Array.from(hunkEl.querySelectorAll(".patchDiffLineColumn-right .patchDiffLineNo"));
    const leftTexts = Array.from(hunkEl.querySelectorAll(".patchDiffTextColumn-left .patchDiffText"));
    const rightTexts = Array.from(hunkEl.querySelectorAll(".patchDiffTextColumn-right .patchDiffText"));
    const rowCount = Math.max(leftLines.length, rightLines.length, leftTexts.length, rightTexts.length);

    for (const cell of [...leftLines, ...rightLines, ...leftTexts, ...rightTexts]) {
      if (cell instanceof HTMLElement) cell.style.minHeight = "";
    }

    for (let index = 0; index < rowCount; index += 1) {
      const cells = [leftLines[index], rightLines[index], leftTexts[index], rightTexts[index]].filter(
        (cell) => cell instanceof HTMLElement,
      );
      if (cells.length === 0) continue;
      const maxHeight = Math.max(...cells.map((cell) => cell.getBoundingClientRect().height));
      for (const cell of cells) {
        cell.style.minHeight = `${Math.ceil(maxHeight)}px`;
      }
    }
  }

  function inferPatchLanguageFromPath(rawPath) {
    const normalized = String(rawPath || "").trim().replace(/\\/g, "/");
    if (!normalized) return "";

    const segments = normalized.split("/");
    const fileName = String(segments[segments.length - 1] || "").toLowerCase();
    if (!fileName) return "";

    if (PATCH_LANGUAGE_BY_FILENAME[fileName]) return PATCH_LANGUAGE_BY_FILENAME[fileName];

    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex < 0) return "";
    const ext = fileName.slice(dotIndex).toLowerCase();
    return PATCH_LANGUAGE_BY_EXTENSION[ext] || "";
  }

  function renderTool(item, cardKey) {
    const row = el("div", { className: "row tool" });
    const presentation = resolveToolPresentation(item);
    const bubble = el("div", { className: "bubble tool toolCard" });
    applyTimelineCardWidthState(bubble, cardKey);
    applyBookmarkMetadata(bubble, item);
    bubble.classList.add(`toolCard-kind-${presentation.toolKind}`);
    if (presentation.severity) bubble.classList.add(`toolCard-severity-${presentation.severity}`);
    if (showDetails) bubble.classList.add("toolCard-expanded");

    const header = el("div", { className: "toolCardHeader" });
    const titleWrap = el("div", { className: "toolCardTitleWrap" });
    const icon = el("span", { className: "toolCardIcon", "aria-hidden": "true" });
    icon.innerHTML = getToolIconSvg(presentation.toolKind);
    titleWrap.appendChild(icon);
    const title = el("div", { className: "toolCardTitle" });
    title.textContent = presentation.title;
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);
    const headerActions = el("div", { className: "toolCardHeaderActions" });
    if (presentation.badgeText) {
      const badge = el("span", { className: "toolCardBadge" });
      badge.textContent = presentation.badgeText;
      headerActions.appendChild(badge);
    }
    appendBookmarkButton(headerActions, item);
    headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
    header.appendChild(headerActions);
    bubble.appendChild(header);

    const primary = el("div", { className: "toolCardPrimary" });
    if (!showDetails) {
      primary.classList.add("toolCardPrimary-clamped");
      primary.title = presentation.primaryText;
    }
    primary.textContent = presentation.primaryText;
    bubble.appendChild(primary);

    if (presentation.secondaryText) {
      const secondary = el("div", { className: "toolCardSecondary" });
      secondary.textContent = presentation.secondaryText;
      bubble.appendChild(secondary);
    }

    if (presentation.relatedFilePath && presentation.relatedFilePath !== presentation.primaryText) {
      const pathRow = el("div", { className: "toolCardPath" });
      pathRow.title = presentation.relatedFilePath;
      pathRow.textContent = presentation.relatedFilePath;
      bubble.appendChild(pathRow);
    }

    const metaLine = el("div", { className: "toolCardMetaLine" });
    const metaTags = el("div", { className: "toolCardMetaTags" });
    appendToolMetaTag(metaTags, item.name || "function_call");
    if (typeof item.messageIndex === "number") {
      appendToolMetaTag(metaTags, `#${item.messageIndex}`);
    }
    if (typeof item.callId === "string") {
      appendToolMetaTag(metaTags, item.callId, item.callId);
    }
    if (typeof item.timestampIso === "string") {
      appendToolMetaTag(metaTags, formatIsoYmdHms(item.timestampIso), item.timestampIso);
    }
    if (showDetails) appendToolExecutionMetaTags(metaTags, item && item.execution);
    if (metaTags.childElementCount > 0) {
      metaLine.appendChild(metaTags);
      bubble.appendChild(metaLine);
    }

    if (showDetails) {
      if (item.detailsOmitted) {
        bubble.appendChild(renderLazyDetailsPlaceholder());
        requestFullDetailsIfNeeded();
      } else {
        appendToolDetailsBlock(bubble, i18n.arguments || "Arguments", "json", item.argumentsText);
        appendToolDetailsBlock(bubble, i18n.output || "Output", "", item.outputText);
      }
    }

    row.appendChild(bubble);
    return row;
  }

  function shouldRenderToolCard() {
    return toolDisplayMode === "compactCards" || showDetails;
  }

  function appendToolExecutionMetaTags(container, execution) {
    if (!execution || typeof execution !== "object") return;
    const status = normalizeToolStatus(execution.status);
    if (status) appendToolMetaTag(container, formatTemplate(getSafeUiText(i18n.toolStatus, "Status: {0}"), status));
    if (typeof execution.exitCode === "number" && Number.isFinite(execution.exitCode)) {
      appendToolMetaTag(container, formatTemplate(getSafeUiText(i18n.toolExitCode, "Exit: {0}"), String(Math.trunc(execution.exitCode))));
    }
    if (typeof execution.durationMs === "number" && Number.isFinite(execution.durationMs)) {
      appendToolMetaTag(container, formatTemplate(getSafeUiText(i18n.toolDuration, "Duration: {0}"), formatDurationMs(execution.durationMs)));
    }
    const errorText = typeof execution.error === "string" ? execution.error.trim() : "";
    if (errorText) appendToolMetaTag(container, errorText, errorText);
  }

  function normalizeToolStatus(value) {
    const status = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!status) return "";
    if (status === "success") return getSafeUiText(i18n.toolStatusSuccess, "success");
    if (status === "completed") return getSafeUiText(i18n.toolStatusCompleted, "completed");
    if (status === "error" || status === "failed") return getSafeUiText(i18n.toolStatusError, "error");
    if (status === "timeout" || status === "timed_out") return getSafeUiText(i18n.toolStatusTimeout, "timeout");
    if (status === "interrupted") return getSafeUiText(i18n.toolStatusInterrupted, "interrupted");
    if (status === "cancelled" || status === "canceled") return getSafeUiText(i18n.toolStatusCancelled, "cancelled");
    return status;
  }

  function formatDurationMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
    const ms = Math.round(value);
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.?0+$/u, "")}s`;
    const totalSeconds = Math.round(seconds);
    if (totalSeconds >= 3600) {
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  function normalizeLongMessageFoldingMode(value) {
    return value === "always" ? "always" : value === "auto" ? "auto" : "off";
  }

  function normalizeImageSettings(value) {
    const rawSize = value && typeof value.thumbnailSize === "string" ? value.thumbnailSize : "";
    const thumbnailSize = rawSize === "small" || rawSize === "large" ? rawSize : "medium";
    return { thumbnailSize };
  }

  function normalizeChatOpenPosition(value) {
    if (value === "latest") return "latest";
    return value === "lastMessage" ? "lastMessage" : "top";
  }

  function normalizePanelKind(value, legacyIsPreview) {
    if (value === "reusable" || value === "session") return value;
    return legacyIsPreview === true ? "reusable" : "session";
  }

  function debugChatOpenPosition(eventName, details) {
    debugWebview("chatOpenPosition", eventName, details);
  }

  function debugWebview(scope, eventName, details) {
    if (!debugLoggingEnabled) return;
    vscode.postMessage({
      type: "debug",
      scope,
      event: eventName,
      details: sanitizeDebugDetails(details),
    });
  }

  function sanitizeDebugDetails(details) {
    const out = {};
    if (!details || typeof details !== "object") return out;
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === "number") {
        out[key] = Number.isFinite(value) ? value : null;
      } else if (typeof value === "boolean" || value == null) {
        out[key] = value;
      } else {
        out[key] = String(value).slice(0, 96);
      }
    }
    return out;
  }

  function getDebugSessionName(fsPath) {
    const text = String(fsPath || "").replace(/\\/g, "/");
    return text.split("/").filter(Boolean).pop() || "unknown";
  }

  function getToolIconSvg(toolKind) {
    return TOOL_ICON_SVGS[toolKind] || TOOL_ICON_SVGS.unknown;
  }

  function resolveToolPresentation(item) {
    const raw = item && item.presentation && typeof item.presentation === "object" ? item.presentation : null;
    const toolKind =
      raw && typeof raw.toolKind === "string" && raw.toolKind.trim().length > 0 ? raw.toolKind.trim() : "unknown";
    const title =
      raw && typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : i18n.tool || "Tool";
    const primaryText =
      raw && typeof raw.primaryText === "string" && raw.primaryText.trim().length > 0
        ? raw.primaryText.trim()
        : item.name || "function_call";
    const secondaryText =
      raw && typeof raw.secondaryText === "string" && raw.secondaryText.trim().length > 0
        ? raw.secondaryText.trim()
        : "";
    const badgeText =
      raw && typeof raw.badgeText === "string" && raw.badgeText.trim().length > 0 ? raw.badgeText.trim() : "";
    const severity =
      raw && (raw.severity === "info" || raw.severity === "warning" || raw.severity === "error")
        ? raw.severity
        : "";
    const relatedFilePath =
      raw && typeof raw.relatedFilePath === "string" && raw.relatedFilePath.trim().length > 0
        ? raw.relatedFilePath.trim()
        : "";
    return { toolKind, title, primaryText, secondaryText, badgeText, severity, relatedFilePath };
  }

  function appendToolMetaTag(container, text, title) {
    if (!(container instanceof Element)) return;
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) return;
    const tag = el("span", { className: "toolCardMetaTag" });
    tag.textContent = normalizedText;
    if (typeof title === "string" && title.trim().length > 0) tag.title = title.trim();
    container.appendChild(tag);
  }

  function formatTemplate(template, ...values) {
    const base = typeof template === "string" ? template : "";
    return base.replace(/\{(\d+)\}/g, (_match, indexText) => {
      const index = Number(indexText);
      const value = Number.isInteger(index) ? values[index] : "";
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function appendToolDetailsBlock(container, label, lang, text) {
    if (typeof text !== "string" || text.length === 0) return;
    const details = el("details", {});
    details.open = text.length < 2000;
    const summary = el("summary", {});
    summary.textContent = label;
    details.appendChild(summary);
    details.appendChild(renderCodeBlock(lang, text, { copyIcon: true }));
    container.appendChild(details);
  }

  function renderLazyDetailsPlaceholder() {
    const placeholder = el("div", { className: "toolCardSecondary" });
    placeholder.textContent = getSafeUiText(i18n.detailsLoading, "Loading details...");
    return placeholder;
  }

  function renderNote(item, cardKey) {
    const row = el("div", { className: "row tool" });
    const bubble = el("div", { className: "bubble tool" });
    applyTimelineCardWidthState(bubble, cardKey);
    applyBookmarkMetadata(bubble, item);
    const title = el("div", { className: "metaLine" });
    const titleText = el("span", {});
    titleText.textContent = item && item.title ? String(item.title) : "note";
    title.appendChild(titleText);
    const headerActions = el("div", { className: "messageNav cardHeaderActions" });
    appendBookmarkButton(headerActions, item);
    headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
    title.appendChild(headerActions);
    bubble.appendChild(title);
    if (item && item.text) {
      const textBlock = el("div", { className: "textBlock" });
      textBlock.textContent = String(item.text);
      bubble.appendChild(textBlock);
    }
    row.appendChild(bubble);
    return row;
  }

  function formatIsoYmdHm(iso) {
    return formatIsoWithKind(iso, "ymdhm");
  }

  function formatIsoYmdHms(iso) {
    return formatIsoWithKind(iso, "ymdhms");
  }

  const dtfCache = new Map();

  function getTimeZone() {
    const tz = dateTime && typeof dateTime.timeZone === "string" ? dateTime.timeZone.trim() : "";
    return tz.length > 0 ? tz : null;
  }

  function getDtf(kind, timeZone) {
    const key = `${kind}|${timeZone}`;
    if (dtfCache.has(key)) return dtfCache.get(key);
    try {
      const opts =
        kind === "ymdhms"
          ? {
              timeZone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
            }
          : {
              timeZone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            };
      // Force Latin digits so parsed numbers stay stable across locale numeral systems.
      const dtf = new Intl.DateTimeFormat("en-US-u-nu-latn", opts);
      dtfCache.set(key, dtf);
      return dtf;
    } catch {
      return null;
    }
  }

  function formatIsoWithKind(iso, kind) {
    if (typeof iso !== "string") return "";
    const s = iso.trim();
    if (!s) return "";
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return s;
    const tz = getTimeZone();
    if (!tz) return s;

    const dtf = getDtf(kind, tz);
    if (!dtf) return s;
    let parts;
    try {
      parts = dtf.formatToParts(new Date(ms));
    } catch {
      return s;
    }

    const out = {};
    for (const p of parts) {
      if (
        p.type === "year" ||
        p.type === "month" ||
        p.type === "day" ||
        p.type === "hour" ||
        p.type === "minute" ||
        p.type === "second"
      ) {
        out[p.type] = p.value;
      }
    }

    const year = out.year;
    const month = out.month;
    const day = out.day;
    const hour = out.hour;
    const minute = out.minute;
    const second = out.second;

    if (typeof year !== "string" || typeof month !== "string" || typeof day !== "string") return s;
    if (typeof hour !== "string" || typeof minute !== "string") return s;
    if (kind === "ymdhms" && typeof second !== "string") return s;

    return kind === "ymdhms"
      ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
      : `${year}-${month}-${day} ${hour}:${minute}`;
  }

  function renderCodeBlock(lang, code, options) {
    const wrap = el("div", { className: "codeBlock" });
    const header = el("div", { className: "codeHeader" });
    const label = el("span", {});
    label.textContent = lang ? String(lang) : "";
    header.appendChild(label);
    const btn = el("button", { type: "button", className: "codeCopyBtn iconBtn" });
    const copyLabel = i18n.copy || "Copy";
    const copyCodeLabel = i18n.copyCodeTooltip || copyLabel;
    btn.innerHTML = COPY_ICON_SVG;
    btn.title = copyCodeLabel;
    btn.setAttribute("aria-label", copyCodeLabel);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "copy", text: String(code || "") });
    });
    header.appendChild(btn);
    wrap.appendChild(header);

    const pre = el("pre", {});
    pre.textContent = String(code || "");
    wrap.appendChild(pre);
    return wrap;
  }

  function splitFencedCode(text) {
    // Split only fenced code blocks. No HTML is generated here.
    const out = [];
    const s = String(text || "");
    let i = 0;
    while (i < s.length) {
      const start = s.indexOf("```", i);
      if (start < 0) {
        out.push({ type: "text", text: s.slice(i) });
        break;
      }
      if (start > i) out.push({ type: "text", text: s.slice(i, start) });
      const langLineEnd = s.indexOf("\n", start + 3);
      if (langLineEnd < 0) {
        out.push({ type: "text", text: s.slice(start) });
        break;
      }
      const lang = s.slice(start + 3, langLineEnd).trim();
      const end = s.indexOf("```", langLineEnd + 1);
      if (end < 0) {
        out.push({ type: "text", text: s.slice(start) });
        break;
      }
      const code = s.slice(langLineEnd + 1, end);
      out.push({ type: "code", lang, code });
      i = end + 3;
    }
    return out;
  }

  function getMessageTextToRender(item, role) {
    if (role === "user" && !showDetails) {
      if (typeof item.requestText === "string" && item.requestText.trim()) return item.requestText;
      return item.text || "";
    }
    return item.text || "";
  }

  function getMessageRole(item) {
    const role = item && typeof item.role === "string" ? item.role : "";
    if (role === "user" || role === "assistant" || role === "developer") return role;
    return "assistant";
  }

  function canRenderMessage(item) {
    if (!item || item.type !== "message") return false;
    const role = getMessageRole(item);
    if (role !== "assistant" && !showDetails && item.isContext) return false;
    if (role === "developer" && !showDetails) return false;
    if (role === "user" && !showDetails) {
      const text = getMessageTextToRender(item, role);
      if (!text.trim() && getMessageAttachments(item).length === 0) return false;
    }
    return true;
  }

  function buildTimelineCardKey(item, itemIndex) {
    const type = item && typeof item.type === "string" && item.type.trim() ? item.type.trim() : "item";
    const safeIndex = Number.isInteger(itemIndex) && itemIndex >= 0 ? itemIndex : 0;
    if (type === "message" && item && typeof item.messageIndex === "number") return `message:${item.messageIndex}`;
    if (type === "usage") {
      const messageIndex =
        item && typeof item.messageIndex === "number" && Number.isFinite(item.messageIndex)
          ? Math.max(0, Math.floor(item.messageIndex))
          : 0;
      const timestampIso = normalizePatchGroupKeyPart(item && item.timestampIso);
      const usageSignature = stableStringHash(JSON.stringify((item && item.usage) || {}));
      if (messageIndex > 0) return `usage:${messageIndex}:${usageSignature}`;
      if (timestampIso) return `usage:time:${stableStringHash(timestampIso)}:${usageSignature}`;
    }
    if (type === "environment") {
      const timestampIso = normalizePatchGroupKeyPart(item && item.timestampIso);
      const envSignature = stableStringHash(
        JSON.stringify({
          cwd: item && item.cwd,
          branch: item && item.gitBranch,
          commit: item && item.gitCommit,
          dirty: item && item.gitDirty,
        }),
      );
      if (timestampIso) return `environment:time:${stableStringHash(timestampIso)}:${envSignature}`;
      return `environment:${envSignature}`;
    }
    if (type === "systemEvent") {
      const kind = normalizePatchGroupKeyPart(item && item.kind) || "event";
      const source = normalizePatchGroupKeyPart(item && item.source) || "source";
      const scope = normalizePatchGroupKeyPart(item && item.scope) || "scope";
      const timestampIso = normalizePatchGroupKeyPart(item && item.timestampIso);
      if (timestampIso) return `systemEvent:${kind}:${source}:${scope}:${stableStringHash(timestampIso)}`;
      return `systemEvent:${kind}:${source}:${scope}:${safeIndex}`;
    }
    if (type === "patchGroup") return buildPatchGroupCardKey(item, safeIndex);
    if (type === "tool") {
      const callId = item && typeof item.callId === "string" && item.callId.trim() ? item.callId.trim() : "";
      if (callId) return `tool:${callId}`;
    }
    return `${type}:${safeIndex}`;
  }

  function buildPatchGroupCardKey(item, safeIndex) {
    const turnId = normalizePatchGroupKeyPart(item && item.turnId);
    if (turnId) return `patchGroup:turn:${stableStringHash(turnId)}`;

    const entrySignature = buildPatchGroupEntrySignature(item);
    const messageIndex =
      item && typeof item.messageIndex === "number" && Number.isFinite(item.messageIndex)
        ? Math.max(0, Math.floor(item.messageIndex))
        : 0;
    if (messageIndex > 0 && entrySignature) return `patchGroup:message:${messageIndex}:${entrySignature}`;
    if (entrySignature) return `patchGroup:entries:${entrySignature}`;

    const timestampIso = normalizePatchGroupKeyPart(item && item.timestampIso);
    if (timestampIso) return `patchGroup:time:${stableStringHash(timestampIso)}`;
    return `patchGroup:${safeIndex}`;
  }

  function buildPatchGroupEntrySignature(item) {
    const entries = item && Array.isArray(item.entries) ? item.entries : [];
    if (entries.length === 0) return "";
    const parts = entries
      .map((entry) =>
        [
          normalizePatchGroupKeyPart(entry && entry.callId),
          normalizePatchGroupKeyPart(entry && entry.path),
          normalizePatchGroupKeyPart(entry && entry.movePath),
          normalizePatchGroupKeyPart(entry && entry.displayPath),
          normalizePatchGroupKeyPart(entry && entry.moveDisplayPath),
          normalizePatchGroupKeyPart(entry && entry.changeType),
        ].join(">"),
      )
      .filter((part) => part.replace(/>/g, "").length > 0)
      .sort();
    return parts.length > 0 ? stableStringHash(parts.join("|")) : "";
  }

  function normalizePatchGroupKeyPart(value) {
    return typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
  }

  function stableStringHash(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function applyTimelineCardWidthState(bubble, cardKey) {
    if (!(bubble instanceof HTMLElement)) return;
    const key = typeof cardKey === "string" ? cardKey : "";
    if (key) bubble.dataset.cardKey = key;
    bubble.classList.toggle("bubble-wide", key.length > 0 && (wideTimelineCardKeys.has(key) || allDiffPatchGroupKeys.has(key)));
  }

  function createTimelineCardWidthButton(cardKey, bubble) {
    const btn = el("button", { type: "button", className: "iconBtn cardWidthBtn" });
    const key = typeof cardKey === "string" ? cardKey : "";
    syncTimelineCardWidthButton(btn, key.length > 0 && wideTimelineCardKeys.has(key));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!key) return;
      const expanded = !wideTimelineCardKeys.has(key);
      if (expanded) wideTimelineCardKeys.add(key);
      else wideTimelineCardKeys.delete(key);
      if (bubble instanceof HTMLElement) bubble.classList.toggle("bubble-wide", expanded);
      syncTimelineCardWidthButton(btn, expanded);
      schedulePatchLayoutSync();
    });
    return btn;
  }

  function syncTimelineCardWidthButton(button, expanded) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.innerHTML = expanded ? CARD_RESTORE_ICON_SVG : CARD_EXPAND_ICON_SVG;
    const label = expanded
      ? getSafeUiText(i18n.restoreCardWidthTooltip, "Restore card width")
      : getSafeUiText(i18n.expandCardWidthTooltip, "Expand card to full width");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", expanded ? "true" : "false");
  }

  function normalizeBookmarkKeys(values) {
    const out = new Set();
    if (!Array.isArray(values)) return out;
    for (const value of values) {
      const key = typeof value === "string" ? value.trim() : "";
      if (key) out.add(key);
    }
    return out;
  }

  function getItemBookmarkKey(item) {
    return item && typeof item.bookmarkKey === "string" ? item.bookmarkKey.trim() : "";
  }

  function isItemBookmarked(item) {
    const key = getItemBookmarkKey(item);
    return !!(key && bookmarkedKeys.has(key));
  }

  function applyBookmarkMetadata(element, item) {
    if (!(element instanceof HTMLElement)) return;
    if (!isBookmarkUiEnabled()) {
      delete element.dataset.bookmarked;
      delete element.dataset.bookmarkKey;
      element.classList.remove("bookmarked");
      return;
    }
    const key = getItemBookmarkKey(item);
    if (key) element.dataset.bookmarkKey = key;
    else delete element.dataset.bookmarkKey;
    const bookmarked = isItemBookmarked(item);
    element.dataset.bookmarked = bookmarked ? "true" : "false";
    if (item && item.type === "message") element.dataset.timeGuideRole = getMessageRole(item);
    else delete element.dataset.timeGuideRole;
    element.classList.toggle("bookmarked", bookmarked);
  }

  function appendBookmarkButton(container, item) {
    if (!(container instanceof HTMLElement)) return;
    if (!isBookmarkUiEnabled()) return;
    const key = getItemBookmarkKey(item);
    if (!key) return;
    container.appendChild(createBookmarkButton(key));
  }

  function createBookmarkButton(bookmarkKey) {
    const btn = el("button", { type: "button", className: "iconBtn bookmarkBtn" });
    btn.dataset.bookmarkKey = bookmarkKey;
    btn.innerHTML = BOOKMARK_ICON_SVG;
    syncBookmarkButton(btn, bookmarkedKeys.has(bookmarkKey));
    return btn;
  }

  function syncBookmarkButton(button, bookmarked) {
    if (!(button instanceof HTMLButtonElement)) return;
    const on = bookmarked === true;
    const label = on
      ? getSafeUiText(i18n.bookmarkRemoveTooltip, "Remove bookmark")
      : getSafeUiText(i18n.bookmarkAddTooltip, "Add bookmark");
    button.classList.toggle("bookmarkBtn-on", on);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function applyBookmarkStateToDom() {
    if (!isBookmarkUiEnabled()) return;
    for (const button of document.querySelectorAll(".bookmarkBtn[data-bookmark-key]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      syncBookmarkButton(button, bookmarkedKeys.has(button.dataset.bookmarkKey || ""));
    }
    for (const element of document.querySelectorAll("[data-bookmark-key]")) {
      if (!(element instanceof HTMLElement)) continue;
      const bookmarked = bookmarkedKeys.has(element.dataset.bookmarkKey || "");
      element.dataset.bookmarked = bookmarked ? "true" : "false";
      element.classList.toggle("bookmarked", bookmarked);
    }
  }

  function toggleBookmarkKeyLocally(key) {
    if (!key) return;
    if (bookmarkedKeys.has(key)) bookmarkedKeys.delete(key);
    else bookmarkedKeys.add(key);
    applyBookmarkStateToDom();
    updateTimeGuide({ afterPaint: true, rebuildItems: true });
  }

  function isBookmarkUiEnabled() {
    return timeGuideEnabled === true;
  }

  function buildMessageNavMap(items) {
    const navMap = new Map();
    const indexesByRole = { user: [], assistant: [] };
    for (const item of items) {
      if (!canRenderMessage(item)) continue;
      const role = getMessageRole(item);
      if (role !== "user" && role !== "assistant") continue;
      if (typeof item.messageIndex !== "number") continue;
      indexesByRole[role].push(item.messageIndex);
      navMap.set(item.messageIndex, { showNav: true, role, prevIndex: null, nextIndex: null });
    }

    // Keep per-message navigation available even when same-role messages are consecutive.
    for (const role of ["user", "assistant"]) {
      const indexes = indexesByRole[role];
      for (let i = 0; i < indexes.length; i += 1) {
        const messageIndex = indexes[i];
        navMap.set(messageIndex, {
          showNav: true,
          role,
          prevIndex: i > 0 ? indexes[i - 1] : null,
          nextIndex: i + 1 < indexes.length ? indexes[i + 1] : null,
        });
      }
    }
    return navMap;
  }

  function buildPatchGroupNavMap(items) {
    const navMap = new Map();
    const patchIndexes = [];
    for (const [itemIndex, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "patchGroup") continue;
      patchIndexes.push(itemIndex);
      navMap.set(itemIndex, { prevIndex: null, nextIndex: null });
    }

    for (let i = 0; i < patchIndexes.length; i += 1) {
      const itemIndex = patchIndexes[i];
      navMap.set(itemIndex, {
        prevIndex: i > 0 ? patchIndexes[i - 1] : null,
        nextIndex: i + 1 < patchIndexes.length ? patchIndexes[i + 1] : null,
      });
    }
    return navMap;
  }

  function createMessageNavButton(direction, role, targetIndex) {
    const btn = el("button", { type: "button", className: "iconBtn navBtn" });
    const label = getMessageNavLabel(direction, role);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = direction === "prev" ? NAV_UP_ICON_SVG : NAV_DOWN_ICON_SVG;
    if (typeof targetIndex !== "number") {
      btn.disabled = true;
      return btn;
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToMessage(targetIndex);
    });
    return btn;
  }

  function createPatchGroupNavButton(direction, targetIndex) {
    const btn = el("button", { type: "button", className: "iconBtn navBtn" });
    const label =
      direction === "prev"
        ? getSafeUiText(i18n.jumpPrevDiff, "Jump to previous diff")
        : getSafeUiText(i18n.jumpNextDiff, "Jump to next diff");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = direction === "prev" ? NAV_UP_ICON_SVG : NAV_DOWN_ICON_SVG;
    if (typeof targetIndex !== "number") {
      btn.disabled = true;
      return btn;
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToPatchGroup(targetIndex);
    });
    return btn;
  }

  function getMessageNavLabel(direction, role) {
    if (role === "user") {
      return direction === "prev"
        ? i18n.jumpPrevUser || "Jump to previous user prompt"
        : i18n.jumpNextUser || "Jump to next user prompt";
    }
    return direction === "prev"
      ? i18n.jumpPrevAssistant || "Jump to previous assistant response"
      : i18n.jumpNextAssistant || "Jump to next assistant response";
  }

  function jumpToMessage(messageIndex) {
    selectedMessageIndex = messageIndex;
    expandedMessageIndexes.add(messageIndex);
    ensureTurnExpandedForReveal(getTurnIdForMessageIndex(messageIndex), { render: false });
    render();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) return;
    if (isUserMessageIndex(messageIndex)) suppressStickyUserUntilUserScroll();
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
  }

  function jumpToPatchGroup(itemIndex) {
    clearHighlights();
    if (ensureTurnExpandedForReveal(getTurnIdForItemIndex(itemIndex), { render: true })) {
      requestAnimationFrame(() => jumpToPatchGroup(itemIndex));
      return;
    }
    const elTarget = document.getElementById(`patch-group-${itemIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
    setTimeout(() => {
      elTarget.classList.remove("highlight");
    }, 1800);
  }

  function revealPatchTarget(target, onRestored) {
    const finish = () => {
      if (typeof onRestored === "function") onRestored();
    };
    if (!target) {
      finish();
      return;
    }
    ensureTurnExpandedForReveal(getTurnIdForPatchRevealTarget(target), { render: false });
    if (typeof target.entryId === "string" && target.entryId.trim()) expandedPatchEntries.add(target.entryId.trim());
    const patch = findPatchTargetElement(target);
    if (patch && patch.entry) {
      const details = patch.entry.closest("details.patchEntry");
      if (details) {
        details.open = true;
        const entryId = getPatchEntryIdFromDetails(details);
        if (entryId) expandedPatchEntries.add(entryId);
      }
    }

    render();
    const nextPatch = findPatchTargetElement(target);
    const elTarget = nextPatch && (nextPatch.entry || nextPatch.group);
    if (!elTarget) {
      if (typeof target.messageIndex === "number") revealMessage(target.messageIndex, finish);
      else finish();
      return;
    }
    clearHighlights();
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
    finish();
    setTimeout(() => {
      elTarget.classList.remove("highlight");
    }, 2000);
  }

  function findPatchTargetElement(target) {
    const groups = Array.from(document.querySelectorAll(".patchGroupCard"));
    const wantedEntryId = typeof target.entryId === "string" ? target.entryId : "";
    const wantedPaths = [target.filePath, target.movePath].filter((value) => typeof value === "string" && value.trim());
    let best = null;
    let messageFallback = null;
    for (const group of groups) {
      const groupIndex = Number(group.dataset.patchGroupIndex);
      const item = Number.isFinite(groupIndex) && model && Array.isArray(model.items) ? model.items[groupIndex] : null;
      const messageMatches =
        typeof target.messageIndex === "number" && item && item.messageIndex === target.messageIndex;
      const timestampScore = scoreRevealTimestamp(target.timestampIso, item && item.timestampIso);
      const entries = Array.from(group.querySelectorAll("details.patchEntry"));
      for (const entry of entries) {
        const entryId = getPatchEntryIdFromDetails(entry);
        const idMatches = !!wantedEntryId && entryId === wantedEntryId;
        const pathEl = entry.querySelector(".patchEntryPath");
        const title = pathEl ? pathEl.textContent || "" : "";
        const pathMatches = wantedPaths.some((pathValue) => pathMatchesRevealTarget(title, pathValue));
        if (!idMatches && !pathMatches) continue;
        const score = (idMatches ? 1000 : 0) + (pathMatches ? 100 : 0) + timestampScore + (messageMatches ? 40 : 0);
        if (!best || score > best.score) best = { group, entry, score };
      }
      if (messageMatches && !messageFallback) messageFallback = { group, entry: null, score: 1 };
    }
    return best || messageFallback;
  }

  function getPatchEntryIdFromDetails(details) {
    if (!(details instanceof HTMLElement)) return "";
    const entries = model && Array.isArray(model.items) ? model.items : [];
    const group = details.closest(".patchGroupCard");
    const groupIndex = group ? Number(group.dataset.patchGroupIndex) : -1;
    const item = Number.isFinite(groupIndex) ? entries[groupIndex] : null;
    if (!item || !Array.isArray(item.entries)) return "";
    const all = Array.from(group.querySelectorAll("details.patchEntry"));
    const index = all.indexOf(details);
    const entry = index >= 0 ? item.entries[index] : null;
    return entry && typeof entry.id === "string" ? entry.id : "";
  }

  function pathMatchesRevealTarget(displayText, rawPath) {
    const left = normalizeRevealPath(displayText);
    const right = normalizeRevealPath(rawPath);
    if (!left || !right) return false;
    return left === right || left.includes(right) || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  function scoreRevealTimestamp(targetIso, itemIso) {
    const targetMs = parseRevealTimestampMs(targetIso);
    const itemMs = parseRevealTimestampMs(itemIso);
    if (targetMs === null || itemMs === null) return 0;
    const delta = Math.abs(targetMs - itemMs);
    if (delta <= 1000) return 80;
    if (delta <= 60 * 1000) return 60;
    if (delta <= 5 * 60 * 1000) return 35;
    if (delta <= 60 * 60 * 1000) return 10;
    return 0;
  }

  function parseRevealTimestampMs(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  function normalizeRevealPath(value) {
    return String(value || "")
      .replace(/→/g, " ")
      .replace(/\\/g, "/")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function revealMessage(messageIndex, onRestored) {
    const finish = () => {
      if (typeof onRestored === "function") onRestored();
    };
    ensureTurnExpandedForReveal(getTurnIdForMessageIndex(messageIndex), { render: false });
    expandedMessageIndexes.add(messageIndex);
    render();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) {
      finish();
      return;
    }
    elTarget.classList.add("highlight");
    if (isUserMessageIndex(messageIndex)) suppressStickyUserUntilUserScroll();
    elTarget.scrollIntoView({ block: "center" });
    finish();
    setTimeout(() => {
      elTarget.classList.remove("highlight");
    }, 1800);
  }

  function restoreHighlight(messageIndex) {
    // After re-render, restore the highlight for the selected bubble (scroll is restored separately).
    clearHighlights();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
  }

  function applyPageSearchSeed(seed) {
    if (!(pageSearchBarEl instanceof HTMLElement) || !(pageSearchInputEl instanceof HTMLInputElement)) return;
    pendingPageSearchSeed = null;
    applyPageSearchPanelWidth();
    pageSearchBarEl.hidden = false;
    document.body.classList.add("pageSearchOpen");
    updateToolbarCompactMode();
    applyPageSearchSeedCore(seed, { fallbackToNearest: false });
    suppressNextPageSearchFocusSuggestions = true;
    pageSearchInputEl.focus();
    pageSearchInputEl.select();
  }

  function applyPendingPageSearchSeedOnOpen() {
    if (!(pageSearchInputEl instanceof HTMLInputElement)) return false;
    const seed = pendingPageSearchSeed;
    if (!seed) return false;
    pendingPageSearchSeed = null;
    return applyPageSearchSeedCore(seed, { fallbackToNearest: true });
  }

  function applyPageSearchSeedCore(seed, options = {}) {
    pageSearchInputEl.value = seed.queryInput;
    pageSearchCaseSensitive = seed.caseSensitive === true;
    pageSearchSuppressedTemporaryAttachmentDetailKeys = new Set();
    hidePageSearchSuggestions();
    refreshPageSearchResults({
      preserveIndex: false,
      reveal: false,
      fallbackToNearest: options.fallbackToNearest === true,
      ...(typeof seed.preferredMessageIndex === "number"
        ? { preferredMessageIndex: seed.preferredMessageIndex }
        : {}),
    });
    commitCurrentPageSearchQuery();
    return true;
  }

  function findNearestPageSearchResultToScrollPosition() {
    if (!Array.isArray(pageSearchResults) || pageSearchResults.length === 0) return -1;
    const root = getScrollRoot();
    const rootRect = root instanceof HTMLElement ? root.getBoundingClientRect() : { top: 0 };
    const targetTop = Number.isFinite(rootRect.top) ? rootRect.top : 0;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pageSearchResults.length; i += 1) {
      const mark = pageSearchResults[i]?.mark;
      if (!(mark instanceof HTMLElement)) continue;
      const rect = mark.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const distance = Math.abs(rect.top - targetTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function restoreScroll(scrollY, onRestored) {
    // Restore scroll after DOM updates (wait 2 frames so layout is settled).
    const y = Math.max(0, Math.floor(Number(scrollY) || 0));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        getScrollRoot().scrollTo(0, y);
        if (typeof onRestored === "function") onRestored();
      });
    });
  }

  function restoreScrollToBottom(onRestored) {
    // Follow the latest content card after DOM updates finish.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToLatestFollowTarget({ persist: false });
        requestAnimationFrame(() => {
          scrollToLatestFollowTarget({ persist: true });
          if (typeof onRestored === "function") onRestored();
        });
      });
    });
  }

  function restoreScrollToLatestBoundary(onRestored) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = getTimelineBoundaryCard("bottom");
        if (target) {
          scrollElementIntoRootView(target, { behavior: "auto", block: "end", endInset: getTimelineEndScrollInset(target) });
        } else {
          const root = getScrollRoot();
          root.scrollTo(0, root.scrollHeight);
        }
        requestAnimationFrame(() => {
          persistCurrentChatOpenPosition({ immediate: true });
          if (typeof onRestored === "function") onRestored();
        });
      });
    });
  }

  function scrollToLatestFollowTarget(options = {}) {
    const behavior = options.behavior === "smooth" ? "smooth" : "auto";
    const target = getTimelineFollowLatestCard();
    if (target) {
      scrollElementIntoRootView(target, { behavior, block: "end", endInset: getTimelineEndScrollInset(target) });
    } else {
      const root = getScrollRoot();
      root.scrollTo({ top: root.scrollHeight, behavior });
    }
    if (options.persist === true) {
      requestAnimationFrame(() => persistCurrentChatOpenPosition({ immediate: true }));
    }
  }

  function getTimelineBoundaryCard(direction) {
    const cards = getRenderedTimelineVisualTargets();
    if (cards.length === 0) return null;
    return direction === "bottom" ? cards[cards.length - 1] : cards[0];
  }

  function getTimelineFollowLatestCard() {
    const targets = getRenderedTimelineVisualTargets();
    if (targets.length === 0) return null;

    const preferredTurnId = normalizeTurnId(model && (model.liveRunningTurnId || model.latestTurnId));
    if (preferredTurnId) {
      const turnTargets = targets.filter((target) => target instanceof HTMLElement && target.dataset.turnId === preferredTurnId);
      const runningTurnTarget = getRunningTurnVisualTarget(turnTargets);
      if (runningTurnTarget) return runningTurnTarget;
      const completedTurnTarget = getCompletedTurnEndVisualTarget(turnTargets);
      if (completedTurnTarget) return completedTurnTarget;
      const turnTarget = getLatestTurnVisualTarget(turnTargets);
      if (turnTarget) return turnTarget;
    }

    return getLatestTurnVisualTarget(targets);
  }

  function getRunningTurnVisualTarget(targets) {
    const liveTurnId = normalizeTurnId(model && model.liveRunningTurnId);
    if (!liveTurnId || !Array.isArray(targets)) return null;
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (
        target instanceof HTMLElement &&
        target.dataset.turnId === liveTurnId &&
        target.classList.contains("runningTurnAnchorRow")
      ) {
        return target;
      }
    }
    return null;
  }

  function getCompletedTurnEndVisualTarget(targets) {
    if (!isTurnTimelineEnabled() || !Array.isArray(targets)) return null;
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (
        target instanceof HTMLElement &&
        target.dataset.turnBoundary === "end" &&
        target.classList.contains("turnEndMarker") &&
        target.classList.contains("turnMarker-completed")
      ) {
        return target;
      }
    }
    return null;
  }

  function getLatestTurnVisualTarget(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    const rows = targets.filter((target) => target instanceof HTMLElement && target.classList.contains("row"));
    const latestRow = getLatestMeaningfulTimelineCard(rows);
    if (latestRow) return latestRow;

    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (target instanceof HTMLElement && target.classList.contains("runningTurnAnchorRow")) return target;
    }
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (
        target instanceof HTMLElement &&
        (target.classList.contains("turnEndMarker") || target.classList.contains("turnCollapsedSummaryMarker"))
      ) {
        return target;
      }
    }
    return targets[targets.length - 1];
  }

  function getLatestMeaningfulTimelineCard(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return null;
    const last = cards[cards.length - 1];
    if (!(last instanceof HTMLElement)) return null;
    if (last.dataset.itemType !== "patchGroup" && last.dataset.itemType !== "environment") return last;

    for (let i = cards.length - 2; i >= 0; i -= 1) {
      const candidate = cards[i];
      if (
        candidate instanceof HTMLElement &&
        candidate.dataset.itemType !== "patchGroup" &&
        candidate.dataset.itemType !== "environment"
      ) {
        return candidate;
      }
    }
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      const candidate = cards[i];
      if (candidate instanceof HTMLElement && candidate.dataset.itemType !== "environment") return candidate;
    }
    return null;
  }

  function getTimelineEndScrollInset(target) {
    if (!(target instanceof HTMLElement)) return 0;
    return target.classList.contains("runningTurnAnchorRow") ||
      target.classList.contains("turnEndMarker") ||
      target.classList.contains("turnCollapsedSummaryMarker")
      ? 12
      : 10;
  }

  function getTimelineStartScrollInset(target) {
    return target instanceof HTMLElement ? 10 : 0;
  }

  function normalizeScrollInset(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
  }

  function scrollElementIntoRootView(element, options = {}) {
    if (!(element instanceof HTMLElement)) return;
    const root = getScrollRoot();
    const behavior = options.behavior === "smooth" ? "smooth" : "auto";
    const block = options.block === "end" ? "end" : "start";
    const endInset = block === "end" ? normalizeScrollInset(options.endInset) : 0;
    const startInset = block === "start" ? normalizeScrollInset(options.startInset) : 0;

    if (!(root instanceof HTMLElement)) {
      element.scrollIntoView({ behavior, block, inline: "nearest" });
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const nextTop =
      block === "end"
        ? root.scrollTop + elementRect.bottom - rootRect.bottom + endInset
        : root.scrollTop + elementRect.top - rootRect.top - startInset;
    root.scrollTo({ top: Math.max(0, Math.floor(nextTop)), behavior });
  }

  function restoreSavedChatOpenPosition(fsPath, hostMessageIndex, onRestored) {
    const finish = () => {
      if (typeof onRestored === "function") onRestored();
    };
    if (chatOpenPosition !== "lastMessage") {
      debugChatOpenPosition("restoreSkip", { reason: "mode", mode: chatOpenPosition });
      finish();
      return null;
    }
    const key = typeof fsPath === "string" ? fsPath : "";
    if (!key) {
      debugChatOpenPosition("restoreSkip", { reason: "noPath" });
      finish();
      return null;
    }
    const positions =
      webviewState && webviewState.chatOpenPositions && typeof webviewState.chatOpenPositions === "object"
        ? webviewState.chatOpenPositions
        : null;
    const saved = positions && positions[key] && typeof positions[key] === "object" ? positions[key] : null;
    const messageIndex =
      typeof hostMessageIndex === "number"
        ? hostMessageIndex
        : typeof saved?.messageIndex === "number"
          ? saved.messageIndex
          : null;
    if (typeof messageIndex !== "number") {
      debugChatOpenPosition("restoreSkip", {
        reason: "noSavedIndex",
        session: getDebugSessionName(key),
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0, finish);
      return null;
    }
    if (messageIndex <= 0 || isFirstRenderedMessageIndex(messageIndex)) {
      debugChatOpenPosition("restoreTop", {
        reason: messageIndex <= 0 ? "firstMessage" : "firstRenderedMessage",
        session: getDebugSessionName(key),
        index: messageIndex,
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0, finish);
      return null;
    }
    let elTarget = document.getElementById(`msg-${messageIndex}`);
    let targetMessageIndex = messageIndex;
    if (!elTarget) {
      elTarget = findPreviousRenderedMessageElement(messageIndex);
      targetMessageIndex = readMessageAnchorIndex(elTarget);
    }
    if (!elTarget || typeof targetMessageIndex !== "number") {
      debugChatOpenPosition("restoreTop", {
        reason: "noPreviousMessage",
        session: getDebugSessionName(key),
        index: messageIndex,
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0, finish);
      return null;
    }
    if (targetMessageIndex !== messageIndex && isFirstRenderedMessageIndex(targetMessageIndex)) {
      debugChatOpenPosition("restoreTop", {
        reason: "firstRenderedFallback",
        session: getDebugSessionName(key),
        index: messageIndex,
        fallbackIndex: targetMessageIndex,
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0, finish);
      return null;
    }
    debugChatOpenPosition("restoreApply", {
      session: getDebugSessionName(key),
      index: targetMessageIndex,
      requestedIndex: targetMessageIndex === messageIndex ? undefined : messageIndex,
      hostIndex: hostMessageIndex,
      scrollTop: getScrollTop(),
    });
    if (isUserMessageIndex(targetMessageIndex)) suppressStickyUserUntilUserScroll();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elTarget.scrollIntoView({ block: "start" });
        debugChatOpenPosition("restoreDone", {
          session: getDebugSessionName(key),
          index: targetMessageIndex,
          scrollTop: getScrollTop(),
        });
        showToast(i18n.restoredLastPosition || "Restored last viewed position.", { key: "restoredLastPosition" });
        finish();
      });
    });
    return targetMessageIndex;
  }

  function clearHighlights() {
    for (const elx of document.querySelectorAll(".highlight")) elx.classList.remove("highlight");
  }

  function showToast(text, options = {}) {
    const container = ensureToastContainer();
    if (!container) return;
    const toastKey = normalizeToastKey(options.key);
    if (toastKey) removeExistingToastByKey(container, toastKey);
    const toast = el("div", { className: "chatToast" });
    toast.textContent = String(text || "");
    if (toastKey) toast.dataset.toastKey = toastKey;
    container.appendChild(toast);
    const durationMs = normalizeToastDuration(options.durationMs);
    setTimeout(() => {
      try {
        toast.remove();
        if (container.childElementCount === 0) container.remove();
      } catch {
        // Ignore rare failures to remove the toast node.
      }
    }, durationMs);
  }

  function normalizeToastKey(value) {
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > 80) return "";
    return /^[A-Za-z0-9_.:-]+$/.test(key) ? key : "";
  }

  function removeExistingToastByKey(container, key) {
    if (!(container instanceof HTMLElement) || !key) return;
    for (const toast of Array.from(container.querySelectorAll(`[data-toast-key="${cssEscape(key)}"]`))) {
      toast.remove();
    }
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function normalizeToastDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration)) return 2400;
    return Math.min(8000, Math.max(1200, Math.floor(duration)));
  }

  function ensureToastContainer() {
    const existing = document.querySelector(".chatToastContainer");
    if (existing instanceof HTMLElement) return existing;
    if (!(document.body instanceof HTMLElement)) return null;
    const container = el("div", { className: "chatToastContainer" });
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
    return container;
  }

  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    return e;
  }

  function normalizeRevealTarget(value) {
    if (!value || typeof value !== "object") return null;
    if (value.kind !== "patchEntry") return null;
    return {
      kind: "patchEntry",
      messageIndex:
        typeof value.messageIndex === "number" && Number.isFinite(value.messageIndex)
          ? Math.max(0, Math.floor(value.messageIndex))
          : undefined,
      timestampIso: typeof value.timestampIso === "string" ? value.timestampIso : "",
      filePath: typeof value.filePath === "string" ? value.filePath : "",
      movePath: typeof value.movePath === "string" ? value.movePath : "",
      entryId: typeof value.entryId === "string" ? value.entryId : "",
    };
  }

  function normalizePageSearchSeed(value) {
    if (!value || typeof value !== "object") return null;
    const queryInput = typeof value.queryInput === "string" ? value.queryInput.trim() : "";
    if (!queryInput) return null;
    const preferredMessageIndex =
      typeof value.preferredMessageIndex === "number" && Number.isFinite(value.preferredMessageIndex)
        ? Math.max(0, Math.floor(value.preferredMessageIndex))
        : undefined;
    return {
      queryInput: queryInput.slice(0, 1000),
      caseSensitive: value.caseSensitive === true,
      ...(typeof preferredMessageIndex === "number" ? { preferredMessageIndex } : {}),
      ...(value.autoOpen === false ? { autoOpen: false } : {}),
    };
  }

  function normalizeSearchHistoryCandidates(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const queryInput = typeof item.queryInput === "string" ? item.queryInput.trim() : "";
      if (!queryInput) continue;
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, queryInput: queryInput.slice(0, 1000) });
      if (out.length >= MAX_PAGE_SEARCH_HISTORY_CANDIDATES) break;
    }
    return out;
  }

  function renderMarkdownInto(container, markdownText) {
    if (!md) {
      const textBlock = el("div", { className: "textBlock" });
      textBlock.textContent = String(markdownText ?? "");
      container.appendChild(textBlock);
      return;
    }
    container.innerHTML = md.render(String(markdownText ?? ""));
    enhanceMarkdownCodeBlocks(container);
  }

  function renderAssistantMarkdownInto(container, markdownText) {
    const parts = splitCodeCommentDirectives(markdownText);
    if (parts.length === 1 && parts[0].type === "markdown") {
      renderMarkdownInto(container, parts[0].text);
      return;
    }
    for (const part of parts) {
      if (part.type === "codeComment") {
        container.appendChild(renderCodeCommentDirective(part.comment));
        continue;
      }
      if (!String(part.text || "").trim()) continue;
      const segment = el("div", { className: "markdownSegment" });
      renderMarkdownInto(segment, part.text);
      container.appendChild(segment);
    }
  }

  function splitCodeCommentDirectives(markdownText) {
    const text = String(markdownText ?? "");
    const parts = [];
    let cursor = 0;
    let searchFrom = 0;
    let converted = 0;

    while (converted < MAX_CODE_COMMENT_DIRECTIVES_PER_MESSAGE) {
      const start = text.indexOf(CODE_COMMENT_DIRECTIVE_PREFIX, searchFrom);
      if (start < 0) break;
      const parsed = parseCodeCommentDirectiveAt(text, start);
      if (!parsed) {
        searchFrom = start + CODE_COMMENT_DIRECTIVE_PREFIX.length;
        continue;
      }
      if (start > cursor) parts.push({ type: "markdown", text: text.slice(cursor, start) });
      parts.push({ type: "codeComment", comment: parsed.comment });
      cursor = parsed.endIndex;
      searchFrom = cursor;
      converted += 1;
    }

    if (cursor < text.length) parts.push({ type: "markdown", text: text.slice(cursor) });
    return parts.length > 0 ? parts : [{ type: "markdown", text }];
  }

  function parseCodeCommentDirectiveAt(text, start) {
    if (!text.startsWith(CODE_COMMENT_DIRECTIVE_PREFIX, start)) return null;
    const contentStart = start + CODE_COMMENT_DIRECTIVE_PREFIX.length;
    let inString = false;
    let escaped = false;
    for (let i = contentStart; i < text.length; i += 1) {
      if (i - start > MAX_CODE_COMMENT_DIRECTIVE_LENGTH) return null;
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "}") {
        const rawContent = text.slice(contentStart, i);
        const attrs = parseCodeCommentAttributes(rawContent);
        if (!attrs) {
          return { comment: buildUnparsedCodeComment(rawContent), endIndex: i + 1 };
        }
        const comment = normalizeCodeCommentAttributes(attrs);
        if (!comment) {
          return { comment: buildUnparsedCodeComment(rawContent), endIndex: i + 1 };
        }
        return { comment, endIndex: i + 1 };
      }
    }
    return null;
  }

  function parseCodeCommentAttributes(source) {
    const attrs = {};
    const seenKeys = new Set();
    let index = 0;
    while (index < source.length) {
      const found = findNextCodeCommentAttributeKey(source, index);
      if (!found) break;
      if (seenKeys.has(found.key)) return null;
      seenKeys.add(found.key);

      if (source[found.valueIndex] === '"') {
        const parsed = parseCodeCommentString(source, found.valueIndex);
        if (!parsed) return null;
        attrs[found.key] = parsed.value;
        index = parsed.nextIndex;
        continue;
      }

      const numberMatch = /^[0-9]+/.exec(source.slice(found.valueIndex));
      if (!numberMatch) return null;
      attrs[found.key] = Number(numberMatch[0]);
      index = found.valueIndex + numberMatch[0].length;
    }
    return attrs;
  }

  function findNextCodeCommentAttributeKey(source, startIndex) {
    let index = startIndex;
    let inString = false;
    let escaped = false;
    while (index < source.length) {
      const ch = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        index += 1;
        continue;
      }
      if (!isCodeCommentIdentifierStart(ch)) {
        index += 1;
        continue;
      }
      const keyStart = index;
      index += 1;
      while (index < source.length && isCodeCommentIdentifierPart(source[index])) index += 1;
      const key = source.slice(keyStart, index);
      const separatorIndex = skipCodeCommentWhitespace(source, index);
      if (source[separatorIndex] === "=" && CODE_COMMENT_ATTRIBUTE_KEYS.has(key)) {
        return { key, valueIndex: skipCodeCommentWhitespace(source, separatorIndex + 1) };
      }
    }
    return null;
  }

  function isCodeCommentIdentifierStart(ch) {
    return /^[A-Za-z_]$/.test(ch || "");
  }

  function isCodeCommentIdentifierPart(ch) {
    return /^[A-Za-z0-9_-]$/.test(ch || "");
  }

  function parseCodeCommentString(source, start) {
    let out = "";
    let index = start + 1;
    while (index < source.length) {
      const ch = source[index];
      if (ch === '"') return { value: out, nextIndex: index + 1 };
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && source[index + 1] === "\n") index += 1;
        out += "\n";
        index += 1;
        continue;
      }
      if (ch !== "\\") {
        out += ch;
        index += 1;
        continue;
      }
      const next = source[index + 1];
      if (next === '"' || next === "\\") out += next;
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "\r" || next === "\n") {
        out += "\\";
        if (next === "\r" && source[index + 2] === "\n") index += 1;
        out += "\n";
      } else return null;
      index += 2;
    }
    return null;
  }

  function skipCodeCommentWhitespace(source, index) {
    let out = index;
    while (out < source.length && /[ \t\r\n]/.test(source[out])) out += 1;
    return out;
  }

  function normalizeCodeCommentAttributes(attrs) {
    const file = truncateCodeCommentText(attrs.file, MAX_CODE_COMMENT_FILE_LENGTH);
    const title = truncateCodeCommentText(attrs.title, MAX_CODE_COMMENT_TITLE_LENGTH);
    const body = truncateCodeCommentText(attrs.body, MAX_CODE_COMMENT_BODY_LENGTH);
    if (!file || !title || !body) return null;
    const start = normalizePositiveLineNumber(attrs.start);
    const rawEnd = normalizePositiveLineNumber(attrs.end);
    const end = start && rawEnd && rawEnd >= start ? rawEnd : undefined;
    const priority = truncateCodeCommentText(attrs.priority, 32);
    return {
      file,
      title,
      body,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(priority ? { priority } : {}),
    };
  }

  function buildUnparsedCodeComment(rawContent) {
    const rawBody = truncateCodeCommentText(rawContent, MAX_CODE_COMMENT_BODY_LENGTH);
    return {
      unparsed: true,
      rawBody,
    };
  }

  function truncateCodeCommentText(value, maxLength) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    return Array.from(trimmed).slice(0, Math.max(1, maxLength)).join("");
  }

  function normalizePositiveLineNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const out = Math.floor(value);
    return out > 0 ? out : undefined;
  }

  function renderCodeCommentDirective(comment) {
    const card = el("section", { className: "codeCommentCard" });
    const header = el("div", { className: "codeCommentHeader" });
    const label = el("span", { className: "codeCommentLabel" });
    label.textContent = i18n.codeCommentLabel || "Code Comment";
    header.appendChild(label);
    if (comment.priority) {
      const badge = el("span", { className: "codeCommentBadge" });
      badge.textContent = comment.priority;
      header.appendChild(badge);
    }
    card.appendChild(header);

    const title = el("div", { className: "codeCommentTitle" });
    title.textContent = comment.unparsed ? i18n.codeCommentUnparsedTitle || "Code comment (unparsed)" : comment.title;
    card.appendChild(title);

    if (!comment.unparsed) {
      const location = el("div", { className: "codeCommentLocation" });
      const locationParts = [`${i18n.codeCommentFile || "File"}: ${comment.file}`];
      const lineLabel = formatCodeCommentLineRange(comment);
      if (lineLabel) locationParts.push(`${i18n.codeCommentLines || "Lines"}: ${lineLabel}`);
      location.textContent = locationParts.join("  ");
      card.appendChild(location);
    }

    const body = el("div", { className: "codeCommentBody" });
    body.textContent = comment.unparsed
      ? comment.rawBody || i18n.codeCommentUnparsedEmptyBody || "(empty directive)"
      : comment.body;
    card.appendChild(body);
    return card;
  }

  function formatCodeCommentLineRange(comment) {
    if (!comment.start) return "";
    return comment.end && comment.end !== comment.start ? `${comment.start}-${comment.end}` : String(comment.start);
  }

  function enhanceMarkdownCodeBlocks(root) {
    const pres = root.querySelectorAll("pre");
    for (const pre of pres) {
      if (pre.parentElement && pre.parentElement.classList.contains("codeBlock")) continue;
      const codeEl = pre.querySelector("code");
      const codeText = codeEl ? codeEl.textContent || "" : pre.textContent || "";
      const lang = inferMarkdownCodeLanguage(codeEl);
      const displayLang = resolveMarkdownCodeLabel(lang, codeText);

      const wrap = el("div", { className: "codeBlock" });
      const header = el("div", { className: "codeHeader" });
      const label = el("span", {});
      label.textContent = displayLang;
      header.appendChild(label);
      const btn = el("button", { type: "button", className: "codeCopyBtn iconBtn" });
      const copyLabel = i18n.copy || "Copy";
      const copyCodeLabel = i18n.copyCodeTooltip || copyLabel;
      btn.innerHTML = COPY_ICON_SVG;
      btn.title = copyCodeLabel;
      btn.setAttribute("aria-label", copyCodeLabel);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "copy", text: String(codeText || "") });
      });
      header.appendChild(btn);
      wrap.appendChild(header);

      pre.replaceWith(wrap);
      const highlightedPre = createHighlightedCodeBlockElement(codeText, lang);
      wrap.appendChild(highlightedPre || pre);
    }
  }

  function inferMarkdownCodeLanguage(codeEl) {
    if (!codeEl) return "";
    const cls = String(codeEl.className || "");
    const m = cls.match(/(?:^|\\s)language-([a-z0-9_+-]+)(?:\\s|$)/i);
    return m ? m[1] : "";
  }

  function resolveMarkdownCodeLabel(lang, codeText) {
    const shiki = getShikiHighlighter();
    if (shiki && typeof shiki.getLanguageLabel === "function") {
      const label = shiki.getLanguageLabel(lang, codeText);
      if (typeof label === "string" && label.trim().length > 0) return label.trim();
    }
    return lang ? String(lang) : "";
  }

  function createHighlightedCodeBlockElement(codeText, lang) {
    const shiki = getShikiHighlighter();
    if (!shiki || typeof shiki.highlightCodeToHtml !== "function") return null;

    let html = "";
    try {
      html = shiki.highlightCodeToHtml(codeText, lang) || "";
    } catch {
      return null;
    }
    if (!html) return null;

    const tmp = el("div", {});
    tmp.innerHTML = html.trim();
    const highlightedPre = tmp.firstElementChild;
    if (!(highlightedPre instanceof HTMLElement)) return null;
    if (highlightedPre.tagName.toLowerCase() !== "pre") return null;

    removeShikiLineBreakTextNodes(highlightedPre);
    highlightedPre.classList.add("codePre");
    highlightedPre.setAttribute("dir", "ltr");
    return highlightedPre;
  }

  function createHighlightedInlineCodeElement(codeText, lang) {
    const shiki = getShikiHighlighter();
    if (!shiki || typeof shiki.highlightLineFragment !== "function") return null;

    let fragment = null;
    try {
      fragment = shiki.highlightLineFragment(codeText, lang);
    } catch {
      return null;
    }
    if (!fragment || typeof fragment.html !== "string" || !fragment.html) return null;

    const codeEl = el("code", { className: "patchDiffCode" });
    if (typeof fragment.className === "string" && fragment.className.trim()) {
      for (const className of fragment.className.split(/\s+/)) {
        if (className) codeEl.classList.add(className);
      }
    }
    if (typeof fragment.style === "string" && fragment.style.trim()) {
      codeEl.style.cssText = fragment.style;
      codeEl.style.backgroundColor = "transparent";
    }
    codeEl.innerHTML = fragment.html;
    codeEl.setAttribute("dir", "ltr");
    return codeEl;
  }

  function removeShikiLineBreakTextNodes(highlightedPre) {
    const codeEl = highlightedPre.querySelector("code");
    if (!(codeEl instanceof HTMLElement)) return;

    for (const node of Array.from(codeEl.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      if (!/^\s*$/.test(node.textContent || "")) continue;
      codeEl.removeChild(node);
    }
  }

  function getShikiHighlighter() {
    const candidate = window.codexHistoryViewerShiki;
    if (!candidate || typeof candidate !== "object") return null;
    return candidate;
  }

  function renderMathExpression(mdi, content, displayMode) {
    const rawContent = String(content ?? "");
    const normalizedContent = rawContent.trim();
    const escapeHtml =
      mdi && mdi.utils && typeof mdi.utils.escapeHtml === "function" ? mdi.utils.escapeHtml : fallbackEscapeHtml;
    const fallbackClass = displayMode ? "mathFallback mathFallback-block" : "mathFallback mathFallback-inline";
    const fallbackTag = displayMode ? "div" : "code";
    const fallbackHtml = `<${fallbackTag} class="${fallbackClass}">${escapeHtml(rawContent)}</${fallbackTag}>`;
    const katex = window.katex;

    if (!normalizedContent || !katex || typeof katex.renderToString !== "function") return fallbackHtml;

    try {
      return katex.renderToString(normalizedContent, {
        displayMode,
        output: "htmlAndMathml",
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    } catch {
      return fallbackHtml;
    }
  }

  function installMathRenderer(mdi) {
    mdi.inline.ruler.before("escape", "math_inline", (state, silent) => {
      const start = state.pos;
      if (start >= state.posMax) return false;

      const marker = state.src.charCodeAt(start);
      if (marker === 0x24) return tokenizeDollarMath(state, silent);
      if (marker === 0x5c) return tokenizeParenthesisMath(state, silent);
      return false;
    });

    mdi.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (start + 1 >= max) return false;
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;

      let openDelimiter = "";
      let closeDelimiter = "";
      if (state.src.startsWith("$$", start)) {
        openDelimiter = "$$";
        closeDelimiter = "$$";
      } else if (state.src.startsWith("\\[", start)) {
        openDelimiter = "\\[";
        closeDelimiter = "\\]";
      } else {
        return false;
      }

      const firstLineText = state.src.slice(start + openDelimiter.length, max);
      const sameLineContent = extractClosedBlockMathLine(firstLineText, closeDelimiter);
      if (sameLineContent != null) {
        if (!silent) {
          const token = state.push("math_block", "math", 0);
          token.block = true;
          token.content = sameLineContent;
          token.map = [startLine, startLine + 1];
          token.markup = openDelimiter;
        }
        state.line = startLine + 1;
        return true;
      }

      const contentLines = [];
      if (firstLineText.length > 0) contentLines.push(firstLineText);

      let nextLine = startLine;
      while (nextLine + 1 < endLine) {
        nextLine += 1;
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineMax = state.eMarks[nextLine];
        const lineText = state.src.slice(lineStart, lineMax);
        const closingContent = extractClosedBlockMathLine(lineText, closeDelimiter);

        if (closingContent != null) {
          if (closingContent.length > 0) contentLines.push(closingContent);
          if (!silent) {
            const token = state.push("math_block", "math", 0);
            token.block = true;
            token.content = contentLines.join("\n");
            token.map = [startLine, nextLine + 1];
            token.markup = openDelimiter;
          }
          state.line = nextLine + 1;
          return true;
        }

        contentLines.push(lineText);
      }

      return false;
    });

    mdi.renderer.rules.math_inline = (tokens, idx) => renderMathExpression(mdi, tokens[idx]?.content, false);
    mdi.renderer.rules.math_block = (tokens, idx) => `${renderMathExpression(mdi, tokens[idx]?.content, true)}\n`;
  }

  function tokenizeDollarMath(state, silent) {
    const start = state.pos;
    if (start + 1 >= state.posMax) return false;
    if (state.src.charCodeAt(start + 1) === 0x24) return false;

    const nextChar = state.src.charCodeAt(start + 1);
    if (isMarkdownWhitespace(nextChar)) return false;

    let match = start + 1;
    while (match < state.posMax) {
      match = state.src.indexOf("$", match);
      if (match < 0 || match >= state.posMax) return false;
      if (isEscapedMarker(state.src, match)) {
        match += 1;
        continue;
      }

      const prevChar = state.src.charCodeAt(match - 1);
      const afterChar = match + 1 < state.posMax ? state.src.charCodeAt(match + 1) : -1;
      if (isMarkdownWhitespace(prevChar) || isAsciiDigit(afterChar)) {
        match += 1;
        continue;
      }

      const content = state.src.slice(start + 1, match);
      if (content.includes("\n") || !content.trim()) return false;

      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = content;
        token.markup = "$";
      }

      state.pos = match + 1;
      return true;
    }

    return false;
  }

  function tokenizeParenthesisMath(state, silent) {
    const start = state.pos;
    if (!state.src.startsWith("\\(", start)) return false;

    let match = start + 2;
    while (match < state.posMax) {
      match = state.src.indexOf("\\)", match);
      if (match < 0 || match >= state.posMax) return false;
      if (isEscapedMarker(state.src, match)) {
        match += 2;
        continue;
      }

      const content = state.src.slice(start + 2, match);
      if (content.includes("\n") || !content.trim()) return false;

      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = content;
        token.markup = "\\(";
      }

      state.pos = match + 2;
      return true;
    }

    return false;
  }

  function extractClosedBlockMathLine(lineText, closeDelimiter) {
    const text = String(lineText ?? "");
    if (text.trim() === closeDelimiter) return "";

    if (closeDelimiter === "$$") {
      const match = text.match(/^(.*?)(?:\s*\$\$\s*)$/);
      return match ? match[1] : null;
    }

    const match = text.match(/^(.*?)(?:\s*\\\]\s*)$/);
    return match ? match[1] : null;
  }

  function isEscapedMarker(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 0x5c; i -= 1) {
      slashCount += 1;
    }
    return slashCount % 2 === 1;
  }

  function isMarkdownWhitespace(code) {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  }

  function isAsciiDigit(code) {
    return code >= 0x30 && code <= 0x39;
  }

  function fallbackEscapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return char;
      }
    });
  }

  function createMarkdownRenderer() {
    if (typeof window.markdownit !== "function") return null;
    const mdi = window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
    });

    const baseValidateLink = mdi.validateLink;
    mdi.validateLink = (url) => {
      const s = String(url ?? "").trim().toLowerCase();
      if (s.startsWith("command:")) return false;
      return baseValidateLink(url);
    };

    const defaultLinkOpen =
      mdi.renderer.rules.link_open ||
      function (tokens, idx, options, _env, self) {
        return self.renderToken(tokens, idx, options);
      };
    mdi.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!token) return defaultLinkOpen(tokens, idx, options, env, self);

      const setAttr = (name, value) => {
        const i = token.attrIndex(name);
        if (i < 0) token.attrPush([name, value]);
        else token.attrs[i][1] = value;
      };

      setAttr("target", "_blank");
      setAttr("rel", "noreferrer noopener");
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    installMathRenderer(mdi);
    return mdi;
  }

  function tryParseLocalFileLink(rawHref) {
    const href = String(rawHref || "").trim();
    if (!href || href.startsWith("command:")) return null;

    const fromVscodeCdn = parseFromVscodeResourceCdn(href);
    if (fromVscodeCdn) return fromVscodeCdn;

    const fromFileUri = parseFromFileUri(href);
    if (fromFileUri) return fromFileUri;

    return splitPathAndLocation(safeDecodeURIComponent(href));
  }

  function parseFromVscodeResourceCdn(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "file+.vscode-resource.vscode-cdn.net") return null;

    let decodedPath = safeDecodeURIComponent(`${url.pathname || ""}${url.hash || ""}`);
    decodedPath = decodedPath.replace(/^\/+/, "");
    if (!decodedPath) return null;
    return splitPathAndLocation(decodedPath, { allowHashSuffix: !!url.hash });
  }

  function parseFromFileUri(href) {
    if (!href.toLowerCase().startsWith("file://")) return null;
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }

    let decodedPath = safeDecodeURIComponent(`${url.pathname || ""}${url.hash || ""}`);
    if (/^\/[a-zA-Z]:\//.test(decodedPath)) decodedPath = decodedPath.slice(1);
    if (!decodedPath) return null;
    return splitPathAndLocation(decodedPath, { allowHashSuffix: !!url.hash });
  }

  function splitPathAndLocation(pathLike, options) {
    const text = String(pathLike || "").trim();
    const kind = detectPathKind(text);
    if (!kind) return null;

    const hashTarget = options && options.allowHashSuffix === false ? null : parseHashPathLocation(text);
    if (hashTarget) return hashTarget;

    const colonTarget = options && options.allowColonSuffix === false ? null : parseColonPathLocation(text);
    if (colonTarget) return colonTarget;

    return { fsPath: text, kind };
  }

  function parseHashPathLocation(text) {
    // Support GitHub / VS Code style locations such as #L39, #L39C2, and #L39-L45.
    const m = text.match(/^(.*?)(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)$/i);
    if (!m) return null;
    return buildPathLocationTarget(m[1], m[2], m[3], text);
  }

  function parseColonPathLocation(text) {
    const m = text.match(/^(.*?)(?::(\d+)(?::(\d+))?)$/);
    if (!m) return null;
    return buildPathLocationTarget(m[1], m[2], m[3], text);
  }

  function buildPathLocationTarget(fsPathLike, lineText, columnText, fallbackFsPath) {
    const fsPath = String(fsPathLike || "").trim();
    const kind = detectPathKind(fsPath);
    if (!kind) return null;

    const line = Number(lineText);
    const column = columnText ? Number(columnText) : undefined;
    if (!Number.isFinite(line) || line < 1) return { fsPath: fallbackFsPath, kind };

    return {
      fsPath,
      line,
      kind,
      column: Number.isFinite(column) && column >= 1 ? column : undefined,
    };
  }

  function detectPathKind(s) {
    const text = String(s || "").trim();
    if (!text) return null;
    if (isAbsolutePathLike(text)) return "absolute";
    return looksLikeRelativePath(text) ? "relative" : null;
  }

  function isAbsolutePathLike(s) {
    const text = String(s || "").trim();
    if (!text) return false;
    if (/^[a-zA-Z]:[\\/]/.test(text)) return true;
    if (text.startsWith("\\\\")) return true;
    return text.startsWith("/");
  }

  function looksLikeRelativePath(s) {
    const text = String(s || "").trim();
    if (!text) return false;
    if (isAbsolutePathLike(text)) return false;
    if (text.startsWith("#") || text.startsWith("?")) return false;
    if (text.startsWith("//")) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
    if (text.startsWith("./") || text.startsWith("../") || text.startsWith(".\\") || text.startsWith("..\\")) return true;
    if (text.includes("/") || text.includes("\\")) return true;

    const body = text.replace(/[?#].*$/u, "");
    return /^[^\s\\/]+(?:\.[^\s\\/]+)+$/u.test(body);
  }

  function safeDecodeURIComponent(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }
})();
