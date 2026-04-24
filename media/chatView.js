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
  const btnMarkdown = document.getElementById("btnMarkdown");
  const btnCopyResume = document.getElementById("btnCopyResume");
  const btnToggleDetails = document.getElementById("btnToggleDetails");
  const btnScrollTop = document.getElementById("btnScrollTop");
  const btnScrollBottom = document.getElementById("btnScrollBottom");
  const btnPageSearch = document.getElementById("btnPageSearch");
  const btnAutoRefresh = document.getElementById("btnAutoRefresh");
  const btnReload = document.getElementById("btnReload");
  const pageSearchBarEl = document.getElementById("pageSearchBar");
  const pageSearchResizeHandleEl = document.getElementById("pageSearchResizeHandle");
  const pageSearchTitleEl = document.getElementById("pageSearchTitle");
  const pageSearchInputEl = document.getElementById("pageSearchInput");
  const pageSearchCountEl = document.getElementById("pageSearchCount");
  const pageSearchResultsEl = document.getElementById("pageSearchResults");
  const btnPageSearchPrev = document.getElementById("btnPageSearchPrev");
  const btnPageSearchNext = document.getElementById("btnPageSearchNext");
  const btnPageSearchClose = document.getElementById("btnPageSearchClose");

  const md = createMarkdownRenderer();
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
  const UNPIN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.28 2.78a.75.75 0 1 0-1.06-1.06L1.72 10.22a.75.75 0 1 0 1.06 1.06l3.13-3.13h1.34v3.1a.75.75 0 1 0 1.5 0v-3.1h1.34l2.13 2.13a.75.75 0 1 0 1.06-1.06L11.06 7V5.66l.22-.22a.75.75 0 0 0 0-1.06L10.84 3.94l.44-.44Z"/></svg>';
  const MARKDOWN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 2h9.5A1.75 1.75 0 0 1 14.5 3.75v8.5A1.75 1.75 0 0 1 12.75 14h-9.5A1.75 1.75 0 0 1 1.5 12.25v-8.5A1.75 1.75 0 0 1 3.25 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h9.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-9.5Zm1.5 1.75h1.5l1.25 1.88 1.25-1.88h1.5v5.5H9V7.55L7.5 9.75 6 7.55v3.2H4.75v-5.5Zm6.5 3h1.25l-1.88 2.5-1.87-2.5h1.25V5.25h1.25v3Z"/></svg>';
  const SEARCH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm4.9 6.83 2.13 2.14a.75.75 0 1 1-1.06 1.06l-2.14-2.13a.75.75 0 1 1 1.07-1.07Z"/></svg>';
  const AUTO_REFRESH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><g fill="none"><path d="M5.2 2.6A5.2 5.2 0 0 1 13 7"/><path d="M13 7l1.15-1.55M13 7l-1.55-1.15"/><path d="M10.8 13.4A5.2 5.2 0 0 1 3 9"/><path d="M3 9l-1.15 1.55M3 9l1.55 1.15"/><circle cx="8" cy="8" r="2.25"/><path d="M8 6.75v1.45l1.05.65"/></g></svg>';
  const CLOSE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
  const SAVE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h7.5c.4 0 .78.16 1.06.44l1.25 1.25c.28.28.44.66.44 1.06v7.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25V5.06L10.94 3.5H10.5v2.25c0 .414-.336.75-.75.75h-4.5a.75.75 0 0 1-.75-.75V3.5h-.75Zm2.25 0V5h3V3.5H6Zm-.25 5h4.5A1.75 1.75 0 0 1 12 10.25v2.25h-1.5v-2.25a.25.25 0 0 0-.25-.25h-4.5a.25.25 0 0 0-.25.25v2.25H4v-2.25C4 9.284 4.784 8.5 5.75 8.5Z"/></svg>';
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
  const OPEN_POSITION_SAVE_DEBOUNCE_MS = 800;
  const MAX_CACHED_IMAGE_DATA = 64;

  /** @type {any} */
  let model = null;
  /** @type {any} */
  let i18n = {};
  /** @type {{ timeZone?: string }} */
  let dateTime = {};
  let toolDisplayMode = "detailsOnly";
  let userLongMessageFolding = "off";
  let assistantLongMessageFolding = "off";
  let imageSettings = { thumbnailSize: "medium" };
  let panelKind = "session";
  let chatOpenPosition = "top";
  let autoRefreshAvailable = false;
  let autoRefreshMode = "off";
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
  let expandedMessageIndexes = new Set();
  let expandedPatchEntries = new Set();
  let wideTimelineCardKeys = new Set();
  let wrappedPatchHunkKeys = new Set();
  let isPinned = false;
  let pageSearchMatches = [];
  let pageSearchResults = [];
  let activePageSearchResultIndex = -1;
  let pageSearchPanelWidth = null;
  let pageSearchResizeState = null;
  let openPositionSaveTimer = 0;
  let toolbarCompactFrame = 0;
  let patchLayoutFrame = 0;
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
    scrollRootEl.addEventListener("scroll", schedulePersistChatOpenPosition, { passive: true });
  }
  window.addEventListener("blur", () => {
    persistCurrentChatOpenPosition({ immediate: true });
  });
  window.addEventListener("pagehide", () => {
    persistCurrentChatOpenPosition({ immediate: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistCurrentChatOpenPosition({ immediate: true });
    }
  });

  // Initial button labels (overwritten after receiving sessionData).
  setToolbarButtonWithIcon(btnResumeInCodex, "Resume in Codex", RESUME_ICON_SVG);
  setToolbarButtonWithIcon(btnPinToggle, "Pin", PIN_ICON_SVG);
  setToolbarButtonWithIcon(btnMarkdown, "Markdown", MARKDOWN_ICON_SVG);
  setToolbarButtonWithIcon(btnCopyResume, "Copy prompt", COPY_ICON_SVG);
  // Scroll buttons stay icon-only in the toolbar.
  if (btnScrollTop instanceof HTMLElement) btnScrollTop.innerHTML = SCROLL_TOP_ICON_SVG;
  if (btnScrollBottom instanceof HTMLElement) btnScrollBottom.innerHTML = SCROLL_BOTTOM_ICON_SVG;
  if (btnPageSearch instanceof HTMLElement) btnPageSearch.innerHTML = SEARCH_ICON_SVG;
  if (btnAutoRefresh instanceof HTMLElement) btnAutoRefresh.innerHTML = AUTO_REFRESH_ICON_SVG;
  // Reload is icon-only (tooltip is set via i18n).
  btnReload.innerHTML = RELOAD_ICON_SVG;
  setToolbarButtonWithIcon(btnToggleDetails, "Details", DETAILS_OFF_ICON_SVG);
  if (btnPageSearchPrev instanceof HTMLElement) btnPageSearchPrev.innerHTML = NAV_UP_ICON_SVG;
  if (btnPageSearchNext instanceof HTMLElement) btnPageSearchNext.innerHTML = NAV_DOWN_ICON_SVG;
  if (btnPageSearchClose instanceof HTMLElement) btnPageSearchClose.innerHTML = CLOSE_ICON_SVG;

  btnResumeInCodex.addEventListener("click", () => {
    vscode.postMessage({ type: "resumeInSource" });
  });
  btnPinToggle.addEventListener("click", () => {
    vscode.postMessage({ type: "togglePin" });
  });
  btnPageSearch.addEventListener("click", () => {
    togglePageSearch();
  });

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
    showToast(getAutoRefreshToast(autoRefreshMode));
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

    showDetails = nextShowDetails;
    updateToolbar();
    if (showDetails) requestFullDetailsIfNeeded({ restoreByCard: true });
    else requestReload({ includeDetails: false, preserveUiState: true, restoreByCard: true });
    render();
    restorePendingDetailScrollAnchorAfterRender({ clear: !expectsSessionData });
  });
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
    refreshPageSearchResults({ reveal: true });
  });
  pageSearchInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigatePageSearchResults(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePageSearch();
    }
  });
  if (pageSearchResizeHandleEl instanceof HTMLElement) {
    pageSearchResizeHandleEl.addEventListener("pointerdown", (event) => {
      if (!(pageSearchBarEl instanceof HTMLElement)) return;
      if (window.innerWidth <= 860) return;
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
    pageSearchPanelWidth = normalizePageSearchPanelWidth(pageSearchPanelWidth);
    applyPageSearchPanelWidth();
    scheduleToolbarCompactMode();
    schedulePatchLayoutSync();
  });
  applyPageSearchPanelWidth();
  if (toolbarResizeObserver) toolbarResizeObserver.observe(toolbarEl);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
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
    if (msg.type === "sessionData") {
      const restoreScrollY = typeof msg.restoreScrollY === "number" ? msg.restoreScrollY : undefined;
      const restoreSelectedMessageIndex =
        typeof msg.restoreSelectedMessageIndex === "number" ? msg.restoreSelectedMessageIndex : undefined;
      const preserveUiState = msg.preserveUiState === true;
      const autoScrollToBottom = msg.autoScrollToBottom === true;
      const savedOpenMessageIndex =
        typeof msg.savedOpenMessageIndex === "number" && Number.isFinite(msg.savedOpenMessageIndex)
          ? Math.max(0, Math.floor(msg.savedOpenMessageIndex))
          : null;
      debugLoggingEnabled = msg.debugLoggingEnabled === true;
      const isRestore = typeof restoreScrollY === "number" || typeof restoreSelectedMessageIndex === "number";
      let shouldPreserveUiState = preserveUiState || isRestore;

      const prevShowDetails = showDetails;
      const prevExpandedNote = expandedNote;
      const prevSelectedMessageIndex = selectedMessageIndex;
      const prevExpandedMessageIndexes = new Set(expandedMessageIndexes);
      const prevExpandedPatchEntries = new Set(expandedPatchEntries);
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
      model = incomingModel;
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || {};
      panelKind = normalizePanelKind(msg.panelKind, msg.isPreview);
      chatOpenPosition = normalizeChatOpenPosition(msg.chatOpenPosition);
      autoRefreshAvailable = msg.autoRefreshAvailable === true;
      autoRefreshMode = normalizeAutoRefreshMode(msg.autoRefreshMode);
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
      detailsLoaded = msg.detailsLoaded === true || msg.detailMode === "full";
      detailReloadPending = false;
      debugChatOpenPosition("sessionData", {
        session: getDebugSessionName(nextModelPath),
        mode: chatOpenPosition,
        panelKind,
        changed: sessionChanged,
        hostIndex: savedOpenMessageIndex,
        restore: isRestore,
        preserveUiState: shouldPreserveUiState,
        autoScrollToBottom,
        reveal: typeof msg.revealMessageIndex === "number",
      });
      expandedNote = shouldPreserveUiState ? prevExpandedNote : false;
      selectedMessageIndex = shouldPreserveUiState
        ? typeof restoreSelectedMessageIndex === "number"
          ? restoreSelectedMessageIndex
          : prevSelectedMessageIndex
        : typeof msg.revealMessageIndex === "number"
          ? msg.revealMessageIndex
          : null;
      expandedMessageIndexes = shouldPreserveUiState ? prevExpandedMessageIndexes : new Set();
      expandedPatchEntries = shouldPreserveUiState ? prevExpandedPatchEntries : new Set();
      wideTimelineCardKeys = shouldPreserveUiState ? prevWideTimelineCardKeys : new Set();
      wrappedPatchHunkKeys = shouldPreserveUiState ? prevWrappedPatchHunkKeys : new Set();
      if (!shouldPreserveUiState && typeof msg.revealMessageIndex === "number") {
        expandedMessageIndexes.add(msg.revealMessageIndex);
      }

      // On reload, preserve the current UI state (details visibility); on normal render, auto-determine as before.
      showDetails = shouldPreserveUiState ? prevShowDetails : shouldAutoShowDetails(model, selectedMessageIndex);
      updateToolbar();
      render();
      const restoredDetailAnchor = restorePendingDetailScrollAnchorAfterRender({ clear: true });
      if (isImagePreviewOpen()) syncImagePreviewControls();

      if (shouldPreserveUiState) {
        if (typeof selectedMessageIndex === "number") restoreHighlight(selectedMessageIndex);
        if (!restoredDetailAnchor) {
          if (typeof restoreScrollY === "number") restoreScroll(restoreScrollY);
          else if (autoScrollToBottom) restoreScrollToBottom();
        }
      } else if (typeof msg.revealMessageIndex === "number") {
        revealMessage(msg.revealMessageIndex);
      } else if (chatOpenPosition === "top") {
        debugChatOpenPosition("restoreTop", { reason: "mode", session: getDebugSessionName(nextModelPath) });
        restoreScroll(0);
      } else {
        const restoredIndex = restoreSavedChatOpenPosition(nextModelPath, savedOpenMessageIndex);
        if (typeof restoredIndex === "number") {
          selectedMessageIndex = restoredIndex;
        }
      }
      return;
    }
    if (msg.type === "i18n") {
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || dateTime || {};
      debugLoggingEnabled = msg.debugLoggingEnabled === true;
      chatOpenPosition = normalizeChatOpenPosition(msg.chatOpenPosition);
      autoRefreshAvailable = msg.autoRefreshAvailable === true;
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
      imageSettings = normalizeImageSettings(msg.imageSettings);
      updateToolbar();
      render();
      if (isImagePreviewOpen()) syncImagePreviewControls();
      return;
    }
    if (msg.type === "requestReload") {
      requestReload({ followLatest: msg.mode === "follow" });
      return;
    }
    if (msg.type === "copied") {
      showToast(i18n.copied || "Copied.");
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

  vscode.postMessage({ type: "ready" });

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

  function updateToolbar() {
    const isClaudeSession = !!(model && model.meta && model.meta.historySource === "claude");
    const resumeLabel = isClaudeSession
      ? i18n.resumeInClaude || "Resume in Claude Code"
      : i18n.resumeInCodex || "Resume in Codex";
    const resumeTooltip = isClaudeSession
      ? i18n.resumeInClaudeTooltip || resumeLabel
      : i18n.resumeInCodexTooltip || resumeLabel;
    setToolbarButtonWithIcon(btnResumeInCodex, resumeLabel, RESUME_ICON_SVG);
    btnResumeInCodex.title = resumeTooltip;
    btnResumeInCodex.setAttribute("aria-label", resumeTooltip);

    const pinLabel = isPinned ? i18n.unpin || "Unpin" : i18n.pin || "Pin";
    const pinTooltip = isPinned
      ? i18n.unpinTooltip || pinLabel
      : i18n.pinTooltip || pinLabel;
    const pinIcon = isPinned ? UNPIN_ICON_SVG : PIN_ICON_SVG;
    setToolbarButtonWithIcon(btnPinToggle, pinLabel, pinIcon);
    btnPinToggle.title = pinTooltip;
    btnPinToggle.setAttribute("aria-label", pinTooltip);

    const pageSearchLabel = getSafeUiText(i18n.pageSearch, "Find");
    const pageSearchTooltip = getSafeUiText(i18n.pageSearchTooltip, "Toggle in-page search");
    btnPageSearch.innerHTML = SEARCH_ICON_SVG;
    btnPageSearch.title = pageSearchTooltip;
    btnPageSearch.setAttribute("aria-label", pageSearchTooltip);
    if (btnAutoRefresh instanceof HTMLElement) {
      const autoRefreshTooltip = getAutoRefreshTooltip(autoRefreshMode);
      btnAutoRefresh.hidden = !autoRefreshAvailable;
      btnAutoRefresh.innerHTML = AUTO_REFRESH_ICON_SVG;
      btnAutoRefresh.dataset.mode = autoRefreshMode;
      btnAutoRefresh.title = autoRefreshTooltip;
      btnAutoRefresh.setAttribute("aria-label", autoRefreshTooltip);
      btnAutoRefresh.setAttribute("aria-pressed", autoRefreshMode === "off" ? "false" : "true");
    }

    const markdownLabel = i18n.markdown || "Markdown";
    const markdownTooltip = i18n.markdownTooltip || markdownLabel;
    setToolbarButtonWithIcon(btnMarkdown, markdownLabel, MARKDOWN_ICON_SVG);
    btnMarkdown.title = markdownTooltip;
    btnMarkdown.setAttribute("aria-label", markdownTooltip);
    const copyResumeLabel = i18n.copyResume || "Copy prompt";
    // Show a descriptive tooltip so the button intent is clear.
    const copyResumeTooltip = i18n.copyResumeTooltip || copyResumeLabel;
    setToolbarButtonWithIcon(btnCopyResume, copyResumeLabel, COPY_ICON_SVG);
    btnCopyResume.title = copyResumeTooltip;
    btnCopyResume.setAttribute("aria-label", copyResumeTooltip);
    const scrollTopLabel = i18n.scrollTop || "Top";
    const scrollTopTooltip = i18n.scrollTopTooltip || scrollTopLabel;
    btnScrollTop.title = scrollTopTooltip;
    btnScrollTop.setAttribute("aria-label", scrollTopTooltip);
    const scrollBottomLabel = i18n.scrollBottom || "Bottom";
    const scrollBottomTooltip = i18n.scrollBottomTooltip || scrollBottomLabel;
    btnScrollBottom.title = scrollBottomTooltip;
    btnScrollBottom.setAttribute("aria-label", scrollBottomTooltip);
    const reloadLabel = i18n.reload || "Reload";
    const reloadTooltip = i18n.reloadTooltip || reloadLabel;
    btnReload.title = reloadTooltip;
    btnReload.setAttribute("aria-label", reloadTooltip);
    const detailsLabel = showDetails
      ? i18n.detailsOn || "Hide details"
      : i18n.detailsOff || "Show details";
    const detailsTooltip = showDetails
      ? i18n.detailsOnTooltip || detailsLabel
      : i18n.detailsOffTooltip || detailsLabel;
    const detailsIcon = showDetails ? DETAILS_ON_ICON_SVG : DETAILS_OFF_ICON_SVG;
    setToolbarButtonWithIcon(btnToggleDetails, detailsLabel, detailsIcon);
    btnToggleDetails.title = detailsTooltip;
    btnToggleDetails.setAttribute("aria-label", detailsTooltip);
    if (pageSearchInputEl instanceof HTMLInputElement) {
      const searchPlaceholder = getSafeUiText(i18n.pageSearchPlaceholder, "Find in this view");
      pageSearchInputEl.placeholder = searchPlaceholder;
      pageSearchInputEl.setAttribute("aria-label", searchPlaceholder);
    }
    if (pageSearchTitleEl instanceof HTMLElement) {
      pageSearchTitleEl.textContent = pageSearchLabel;
    }
    const prevTooltip = getSafeUiText(i18n.pageSearchPrevTooltip, "Previous match");
    const nextTooltip = getSafeUiText(i18n.pageSearchNextTooltip, "Next match");
    const closeTooltip = getSafeUiText(i18n.pageSearchCloseTooltip, "Close search");
    btnPageSearchPrev.title = prevTooltip;
    btnPageSearchPrev.setAttribute("aria-label", prevTooltip);
    btnPageSearchNext.title = nextTooltip;
    btnPageSearchNext.setAttribute("aria-label", nextTooltip);
    btnPageSearchClose.title = closeTooltip;
    btnPageSearchClose.setAttribute("aria-label", closeTooltip);
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

  function scrollToBoundary(direction) {
    const target = getTimelineBoundaryCard(direction);
    if (target) {
      scrollElementIntoRootView(target, { behavior: "smooth", block: "start" });
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
    return showDetails || expandedPatchEntries.size > 0;
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

    for (const node of document.querySelectorAll("[id^='msg-']")) {
      if (!(node instanceof HTMLElement)) continue;
      const match = /^msg-(\d+)$/u.exec(node.id);
      if (!match) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
      const distance = Math.abs(rect.top - viewportTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = Number(match[1]);
      }
    }

    if (!Number.isFinite(bestIndex)) return null;
    return isFirstRenderedMessageIndex(bestIndex) ? 0 : bestIndex;
  }

  function captureTimelineScrollAnchor() {
    const rows = getRenderedTimelineRows();
    if (rows.length === 0) return null;

    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const viewportTop = rootRect.top + 8;
    const viewportBottom = rootRect.bottom;
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
      const score = rect.top <= viewportTop && rect.bottom >= viewportTop ? 0 : Math.abs(rect.top - viewportTop) + 1;
      if (score < bestScore) {
        bestScore = score;
        best = row;
      }
    }

    if (!best) best = rows[0];
    const itemIndex = Number(best.dataset.itemIndex);
    return {
      fsPath: model && typeof model.fsPath === "string" ? model.fsPath : "",
      cardKey: typeof best.dataset.cardKey === "string" ? best.dataset.cardKey : "",
      itemIndex: Number.isFinite(itemIndex) ? Math.max(0, Math.floor(itemIndex)) : 0,
    };
  }

  function getRenderedTimelineRows() {
    if (!(timelineEl instanceof HTMLElement)) return [];
    return Array.from(timelineEl.querySelectorAll(":scope > .row")).filter(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
  }

  function restorePendingDetailScrollAnchorAfterRender(options = {}) {
    const anchor = pendingDetailScrollAnchor;
    if (!anchor) return false;
    restoreTimelineScrollAnchorAfterLayout(anchor);
    if (options.clear === true) pendingDetailScrollAnchor = null;
    return true;
  }

  function restoreTimelineScrollAnchorAfterLayout(anchor) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreTimelineScrollAnchor(anchor);
      });
    });
  }

  function restoreTimelineScrollAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return false;
    const currentPath = model && typeof model.fsPath === "string" ? model.fsPath : "";
    if (anchor.fsPath && currentPath && anchor.fsPath !== currentPath) return false;

    const target = findTimelineRowForAnchor(anchor);
    if (target) {
      scrollElementIntoRootView(target, { behavior: "auto", block: "start" });
      return true;
    }

    restoreScroll(0);
    return false;
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
  }

  function normalizePageSearchPanelWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) return null;
    if (window.innerWidth <= 860) return null;
    const maxWidth = Math.max(MIN_PAGE_SEARCH_WIDTH, window.innerWidth - 36);
    return Math.max(MIN_PAGE_SEARCH_WIDTH, Math.min(Math.round(width), maxWidth));
  }

  function applyPageSearchPanelWidth() {
    const normalized = normalizePageSearchPanelWidth(pageSearchPanelWidth);
    pageSearchPanelWidth = normalized;
    if (normalized == null) {
      document.documentElement.style.removeProperty("--chv-page-search-width");
      return;
    }
    document.documentElement.style.setProperty("--chv-page-search-width", `${normalized}px`);
  }

  function persistPageSearchPanelWidth() {
    if (typeof vscode.setState !== "function") return;
    webviewState = {
      ...(webviewState && typeof webviewState === "object" ? webviewState : {}),
      pageSearchPanelWidth,
    };
    vscode.setState(webviewState);
  }

  function isPageSearchOpen() {
    return pageSearchBarEl instanceof HTMLElement && !pageSearchBarEl.hidden;
  }

  function normalizeAutoRefreshMode(value) {
    return value === "preserve" || value === "follow" ? value : "off";
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

  function resetSessionScopedUiState() {
    resetPageSearchState();
    if (imagePreview || isImagePreviewOpen()) closeImagePreview();
    resetImageDataCache();
    pendingDetailScrollAnchor = null;
  }

  function resetPageSearchState() {
    cancelPageSearchResize();
    if (pageSearchBarEl instanceof HTMLElement) pageSearchBarEl.hidden = true;
    document.body.classList.remove("pageSearchOpen");
    if (pageSearchInputEl instanceof HTMLInputElement) pageSearchInputEl.value = "";
    clearPageSearchHighlights();
    renderPageSearchResults();
    updatePageSearchStatus();
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
    const selectedText = window.getSelection ? String(window.getSelection() || "").trim() : "";
    if (!pageSearchInputEl.value && selectedText && !/\s*\n\s*/u.test(selectedText)) {
      pageSearchInputEl.value = selectedText;
    }
    refreshPageSearchResults({ preserveIndex: true, reveal: false });
    pageSearchInputEl.focus();
    pageSearchInputEl.select();
  }

  function closePageSearch() {
    if (!(pageSearchBarEl instanceof HTMLElement)) return;
    pageSearchBarEl.hidden = true;
    document.body.classList.remove("pageSearchOpen");
    cancelPageSearchResize();
    clearPageSearchHighlights();
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function refreshPageSearchResults(options = {}) {
    const preserveIndex = !!options.preserveIndex;
    const reveal = options.reveal !== false;
    const query = pageSearchInputEl instanceof HTMLInputElement ? pageSearchInputEl.value.trim() : "";
    const previousIndex = preserveIndex ? activePageSearchResultIndex : -1;
    clearPageSearchHighlights();
    if (!query) {
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    const loweredQuery = query.toLowerCase();
    const roots = [annotationEl, metaEl, timelineEl].filter((node) => node instanceof HTMLElement);
    const textNodes = [];

    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return shouldAcceptPageSearchTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      const loweredText = text.toLowerCase();
      let matchIndex = loweredText.indexOf(loweredQuery);
      if (matchIndex < 0) continue;

      const fragment = document.createDocumentFragment();
      const pendingMarks = [];
      let cursor = 0;
      while (matchIndex >= 0) {
        if (matchIndex > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
        }
        const mark = document.createElement("mark");
        mark.className = "pageSearchMatch";
        mark.textContent = text.slice(matchIndex, matchIndex + query.length);
        fragment.appendChild(mark);
        pendingMarks.push({ mark, start: matchIndex });
        pageSearchMatches.push(mark);
        cursor = matchIndex + query.length;
        matchIndex = loweredText.indexOf(loweredQuery, cursor);
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);

      for (const pending of pendingMarks) {
        pageSearchResults.push(buildPageSearchResult(pending.mark, text, pending.start, query.length));
      }
    }

    renderPageSearchResults();

    if (pageSearchResults.length === 0) {
      updatePageSearchStatus();
      return;
    }

    const nextIndex =
      preserveIndex && previousIndex >= 0 ? Math.min(previousIndex, pageSearchResults.length - 1) : 0;
    activatePageSearchResult(nextIndex, { reveal });
  }

  function shouldAcceptPageSearchTextNode(node) {
    if (!(node instanceof Text)) return false;
    const text = node.textContent || "";
    if (!text.trim()) return false;

    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement)) return false;
    if (parent.closest("#pageSearchBar")) return false;
    if (parent.closest("script, style, textarea, input, select, button")) return false;
    if (parent.closest("mark.pageSearchMatch")) return false;
    if (parent.closest("[hidden]")) return false;

    const closedDetails = parent.closest("details:not([open])");
    if (closedDetails) {
      const summary = parent.closest("summary");
      if (!(summary instanceof HTMLElement) || summary.parentElement !== closedDetails) return false;
    }

    if (parent.getClientRects().length === 0 && !parent.closest("summary")) return false;
    return true;
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

  function navigatePageSearchResults(delta) {
    if (!isPageSearchOpen()) {
      openPageSearch();
      return;
    }
    if (pageSearchResults.length === 0) {
      refreshPageSearchResults({ reveal: false });
      if (pageSearchResults.length === 0) return;
    }
    const total = pageSearchResults.length;
    const currentIndex = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    const nextIndex = (currentIndex + delta + total) % total;
    activatePageSearchResult(nextIndex, { reveal: true });
  }

  function activatePageSearchResult(index, options = {}) {
    if (pageSearchResults.length === 0) {
      activePageSearchResultIndex = -1;
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    const reveal = options.reveal !== false;
    for (const match of pageSearchMatches) {
      if (match instanceof HTMLElement) match.classList.remove("pageSearchMatch-active");
    }

    const safeIndex = Math.max(0, Math.min(index, pageSearchResults.length - 1));
    activePageSearchResultIndex = safeIndex;
    const activeResult = pageSearchResults[safeIndex];
    if (activeResult && activeResult.mark instanceof HTMLElement) {
      activeResult.mark.classList.add("pageSearchMatch-active");
      if (reveal) {
        activeResult.mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }
    }
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function buildPageSearchResult(mark, sourceText, startIndex, queryLength) {
    const snippet = buildPageSearchSnippet(sourceText, startIndex, queryLength);
    const context = describePageSearchContext(mark);
    return {
      mark,
      title: context.title,
      meta: context.meta,
      lineNumber: context.lineNumber,
      snippet,
    };
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

  function describeBubbleSearchContext(bubble) {
    const roleLabel = bubble.classList.contains("user")
      ? getSafeUiText(i18n.roleUser, "User")
      : bubble.classList.contains("assistant")
        ? getSafeUiText(i18n.roleAssistant, "Assistant")
        : bubble.classList.contains("developer")
          ? getSafeUiText(i18n.roleDeveloper, "Developer")
          : getSafeUiText(i18n.roleMessage, "Message");
    const messageIndex = bubble.dataset.messageIndex ? `#${bubble.dataset.messageIndex}` : "";
    const metaText = getElementText(bubble.querySelector(".metaLine"));
    return {
      title: [roleLabel, messageIndex].filter(Boolean).join(" "),
      meta: metaText,
      lineNumber: "",
    };
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

    const query = pageSearchInputEl instanceof HTMLInputElement ? pageSearchInputEl.value.trim() : "";
    if (!query) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = getSafeUiText(i18n.pageSearchTypeToSearch, "Type to search");
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
        activatePageSearchResult(index, { reveal: true });
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

  function getElementText(node) {
    return node instanceof HTMLElement && typeof node.textContent === "string" ? node.textContent.trim() : "";
  }

  function updatePageSearchStatus() {
    if (!(pageSearchCountEl instanceof HTMLElement)) return;
    const total = pageSearchResults.length;
    if (btnPageSearchPrev instanceof HTMLButtonElement) btnPageSearchPrev.disabled = total <= 1;
    if (btnPageSearchNext instanceof HTMLButtonElement) btnPageSearchNext.disabled = total <= 1;
    if (total === 0) {
      pageSearchCountEl.textContent = "0/0";
      return;
    }
    const current = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex + 1 : 1;
    pageSearchCountEl.textContent = `${current}/${total}`;
  }

  function render() {
    if (lazyImageObserver) lazyImageObserver.disconnect();
    if (annotationEl) annotationEl.textContent = "";
    metaEl.textContent = "";
    timelineEl.textContent = "";
    pageSearchMatches = [];
    pageSearchResults = [];
    activePageSearchResultIndex = -1;
    if (!model) return;

    renderAnnotationHeader(model.annotation);

    // Render session metadata at the top.
    const metaLines = [];
    if (model.meta && model.meta.timestampIso) metaLines.push(`Start: ${formatIsoYmdHm(model.meta.timestampIso)}`);
    if (model.meta && model.meta.cwd) metaLines.push(`CWD: ${model.meta.cwd}`);
    if (model.meta && model.meta.originator) metaLines.push(`Originator: ${model.meta.originator}`);
    if (model.meta && model.meta.cliVersion) metaLines.push(`CLI: ${model.meta.cliVersion}`);
    if (model.meta && model.meta.modelProvider) metaLines.push(`Model Provider: ${model.meta.modelProvider}`);
    if (model.meta && model.meta.source) metaLines.push(`Source: ${model.meta.source}`);
    if (metaLines.length > 0) metaEl.textContent = metaLines.join(" | ");

    const items = Array.isArray(model.items) ? model.items : [];
    // Build navigation metadata between messages before rendering.
    messageNavMap = buildMessageNavMap(items);
    patchGroupNavMap = buildPatchGroupNavMap(items);
    for (const [itemIndex, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      const rendered = renderItem(item, itemIndex);
      if (rendered) timelineEl.appendChild(rendered);
    }
    schedulePatchLayoutSync();
    if (isPageSearchOpen()) refreshPageSearchResults({ preserveIndex: true, reveal: false });
    else {
      renderPageSearchResults();
      updatePageSearchStatus();
    }
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

  function renderItem(item, itemIndex) {
    const cardKey = buildTimelineCardKey(item, itemIndex);
    let rendered = null;
    if (item.type === "message") rendered = renderMessage(item, cardKey);
    else if (item.type === "patchGroup") rendered = renderPatchGroup(item, itemIndex, cardKey);
    else if (item.type === "tool") rendered = shouldRenderToolCard() ? renderTool(item, cardKey) : null;
    else rendered = showDetails ? renderNote(item, cardKey) : null;

    if (rendered instanceof HTMLElement) {
      rendered.dataset.cardKey = cardKey;
      rendered.dataset.itemIndex = String(itemIndex);
    }
    return rendered;
  }

  function renderMessage(item, cardKey) {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "assistant";
    if (role !== "assistant" && !showDetails && item.isContext) return null;

    const textToRender = getMessageTextToRender(item, role);
    const images = getMessageImages(item);
    if (role === "user" && !showDetails && !textToRender.trim() && images.length === 0) return null;
    if (role === "developer" && !showDetails) return null;

    const row = el("div", { className: `row ${role}` });

    const bubble = el("div", { className: `bubble ${role}` });
    applyTimelineCardWidthState(bubble, cardKey);
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
    headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
    metaLine.appendChild(headerActions);
    bubble.appendChild(metaLine);

    const collapseState = resolveMessageCollapseState(item, role, textToRender);
    const body = el("div", { className: `messageBody messageBody-${role}` });
    if (collapseState.canCollapse && collapseState.collapsed) {
      body.classList.add("messageBody-collapsed", `messageBody-collapsed-${role}`);
    }

    const content = el("div", { className: role === "assistant" ? "messageBodyContent markdown" : "messageBodyContent" });
    if (textToRender.trim()) {
      if (role === "assistant") {
        renderMarkdownInto(content, textToRender);
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
    if (images.length > 0) {
      body.appendChild(renderMessageImages(images));
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

  function getMessageImages(item) {
    if (!item || !Array.isArray(item.images)) return [];
    return item.images.filter((image) => image && image.type === "image");
  }

  function renderMessageImages(images) {
    const thumbnailSize = imageSettings.thumbnailSize || "medium";
    const wrap = el("div", { className: `messageImages messageImages-${thumbnailSize}` });
    const previewImages = images.filter(canPreviewImage);
    for (const image of images) {
      wrap.appendChild(renderMessageImage(image, previewImages, previewImages.indexOf(image)));
    }
    return wrap;
  }

  function renderMessageImage(image, previewImages, previewIndex) {
    const label = typeof image.label === "string" && image.label.trim() ? image.label.trim() : "Image attachment";
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

    const label = frame.dataset.imageLabel || cached.label || "Image attachment";
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
    preview.closeButton.focus();
  }

  function closeImagePreview() {
    const preview = ensureImagePreview();
    preview.overlay.hidden = true;
    preview.image.removeAttribute("src");
    preview.thumbnailStrip.replaceChildren();
    document.body.classList.remove("imagePreviewOpen");
    imagePreview = null;
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
    vscode.postMessage({ type: "saveImage", imageId: image.imageId });
  }

  function getCurrentPreviewImage() {
    if (!imagePreview || !Array.isArray(imagePreview.images) || imagePreview.images.length === 0) return null;
    const index = clampImagePreviewIndex(imagePreview.index, imagePreview.images.length);
    imagePreview.index = index;
    return imagePreview.images[index] || null;
  }

  function toPreviewImage(image) {
    const label = typeof image.label === "string" && image.label.trim() ? image.label.trim() : "Image attachment";
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
    if (expand) expandedMessageIndexes.add(messageIndex);
    else expandedMessageIndexes.delete(messageIndex);
    render();
    if (typeof selectedMessageIndex === "number") restoreHighlight(selectedMessageIndex);
    const target = document.getElementById(`msg-${messageIndex}`);
    if (target) target.scrollIntoView({ block: "nearest" });
  }

  function renderPatchGroup(item, itemIndex, cardKey) {
    const row = el("div", { className: "row tool" });
    const bubble = el("div", { className: "bubble tool toolCard patchGroupCard toolCard-kind-edit" });
    applyTimelineCardWidthState(bubble, cardKey);
    bubble.id = `patch-group-${itemIndex}`;
    bubble.dataset.patchGroupIndex = String(itemIndex);

    const header = el("div", { className: "toolCardHeader" });
    const titleWrap = el("div", { className: "toolCardTitleWrap" });
    const icon = el("span", { className: "toolCardIcon", "aria-hidden": "true" });
    icon.innerHTML = getToolIconSvg("edit");
    titleWrap.appendChild(icon);

    const title = el("div", { className: "toolCardTitle" });
    title.textContent = formatTemplate(i18n.patchGroupCount || "{0} changes", item.entryCount || 0);
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    const headerActions = el("div", { className: "toolCardHeaderActions patchGroupHeaderActions" });
    const badge = el("div", { className: "patchGroupSummary" });
    badge.appendChild(renderSignedCountBadge(item.totalAdded, "add"));
    badge.appendChild(renderSignedCountBadge(item.totalRemoved, "remove"));
    headerActions.appendChild(badge);

    const nav = patchGroupNavMap.get(itemIndex) || { prevIndex: null, nextIndex: null };
    const navActions = el("div", { className: "messageNav patchGroupNav" });
    navActions.appendChild(createPatchGroupNavButton("prev", nav.prevIndex));
    navActions.appendChild(createPatchGroupNavButton("next", nav.nextIndex));
    headerActions.appendChild(navActions);
    headerActions.appendChild(createTimelineCardWidthButton(cardKey, bubble));
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

    const entriesWrap = el("div", { className: "patchEntryList" });
    const entries = Array.isArray(item.entries) ? item.entries : [];
    if (entries.length === 0) {
      const empty = el("div", { className: "toolCardSecondary" });
      empty.textContent = i18n.patchNoDiff || "No diff available";
      entriesWrap.appendChild(empty);
    } else {
      for (const entry of entries) {
        entriesWrap.appendChild(renderPatchEntry(entry));
      }
    }
    bubble.appendChild(entriesWrap);

    row.appendChild(bubble);
    return row;
  }

  function renderPatchEntry(entry) {
    const details = el("details", { className: "patchEntry" });
    const entryLanguage = inferPatchLanguage(entry);
    details.open = expandedPatchEntries.has(entry.id);
    let body;
    let bodyReady = false;
    const ensurePatchBody = () => {
      if (!(body instanceof HTMLElement) || bodyReady) return;
      populatePatchEntryBody(body, entry, entryLanguage);
      bodyReady = true;
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
      if (details.open) expandedPatchEntries.add(entry.id);
      else expandedPatchEntries.delete(entry.id);
      if (details.open && entry.detailsOmitted) {
        requestFullDetailsIfNeeded();
      }
      if (details.open) ensurePatchBody();
      applyPatchToggleLabel();
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
    if (details.open) ensurePatchBody();
    details.appendChild(body);
    return details;
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

  function normalizeLongMessageFoldingMode(value) {
    return value === "always" ? "always" : value === "auto" ? "auto" : "off";
  }

  function normalizeImageSettings(value) {
    const rawSize = value && typeof value.thumbnailSize === "string" ? value.thumbnailSize : "";
    const thumbnailSize = rawSize === "small" || rawSize === "large" ? rawSize : "medium";
    return { thumbnailSize };
  }

  function normalizeChatOpenPosition(value) {
    return value === "lastMessage" ? "lastMessage" : "top";
  }

  function normalizePanelKind(value, legacyIsPreview) {
    if (value === "reusable" || value === "session") return value;
    return legacyIsPreview === true ? "reusable" : "session";
  }

  function debugChatOpenPosition(eventName, details) {
    if (!debugLoggingEnabled) return;
    vscode.postMessage({
      type: "debug",
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
    const title = el("div", { className: "metaLine" });
    const titleText = el("span", {});
    titleText.textContent = item && item.title ? String(item.title) : "note";
    title.appendChild(titleText);
    const headerActions = el("div", { className: "messageNav cardHeaderActions" });
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
      if (!text.trim() && getMessageImages(item).length === 0) return false;
    }
    return true;
  }

  function buildTimelineCardKey(item, itemIndex) {
    const type = item && typeof item.type === "string" && item.type.trim() ? item.type.trim() : "item";
    const safeIndex = Number.isInteger(itemIndex) && itemIndex >= 0 ? itemIndex : 0;
    if (type === "message" && item && typeof item.messageIndex === "number") return `message:${item.messageIndex}`;
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
    bubble.classList.toggle("bubble-wide", key.length > 0 && wideTimelineCardKeys.has(key));
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
    render();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
  }

  function jumpToPatchGroup(itemIndex) {
    clearHighlights();
    const elTarget = document.getElementById(`patch-group-${itemIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
    setTimeout(() => {
      elTarget.classList.remove("highlight");
    }, 1800);
  }

  function revealMessage(messageIndex) {
    expandedMessageIndexes.add(messageIndex);
    render();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
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

  function restoreScroll(scrollY) {
    // Restore scroll after DOM updates (wait 2 frames so layout is settled).
    const y = Math.max(0, Math.floor(Number(scrollY) || 0));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        getScrollRoot().scrollTo(0, y);
      });
    });
  }

  function restoreScrollToBottom() {
    // Follow the latest rendered card after DOM updates finish.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = getTimelineBoundaryCard("bottom");
        if (target) {
          scrollElementIntoRootView(target, { behavior: "auto", block: "start" });
          return;
        }
        const root = getScrollRoot();
        root.scrollTo(0, root.scrollHeight);
      });
    });
  }

  function getTimelineBoundaryCard(direction) {
    const cards = getRenderedTimelineRows();
    if (cards.length === 0) return null;
    return direction === "bottom" ? cards[cards.length - 1] : cards[0];
  }

  function scrollElementIntoRootView(element, options = {}) {
    if (!(element instanceof HTMLElement)) return;
    const root = getScrollRoot();
    const behavior = options.behavior === "smooth" ? "smooth" : "auto";
    const block = options.block === "end" ? "end" : "start";

    if (!(root instanceof HTMLElement)) {
      element.scrollIntoView({ behavior, block, inline: "nearest" });
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const nextTop =
      block === "end"
        ? root.scrollTop + elementRect.bottom - rootRect.bottom
        : root.scrollTop + elementRect.top - rootRect.top;
    root.scrollTo({ top: Math.max(0, Math.floor(nextTop)), behavior });
  }

  function restoreSavedChatOpenPosition(fsPath, hostMessageIndex) {
    if (chatOpenPosition !== "lastMessage") {
      debugChatOpenPosition("restoreSkip", { reason: "mode", mode: chatOpenPosition });
      return null;
    }
    const key = typeof fsPath === "string" ? fsPath : "";
    if (!key) {
      debugChatOpenPosition("restoreSkip", { reason: "noPath" });
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
      restoreScroll(0);
      return null;
    }
    if (messageIndex <= 0 || isFirstRenderedMessageIndex(messageIndex)) {
      debugChatOpenPosition("restoreTop", {
        reason: messageIndex <= 0 ? "firstMessage" : "firstRenderedMessage",
        session: getDebugSessionName(key),
        index: messageIndex,
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0);
      return null;
    }
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) {
      debugChatOpenPosition("restoreMiss", {
        session: getDebugSessionName(key),
        index: messageIndex,
        hostIndex: hostMessageIndex,
      });
      restoreScroll(0);
      return null;
    }
    debugChatOpenPosition("restoreApply", {
      session: getDebugSessionName(key),
      index: messageIndex,
      hostIndex: hostMessageIndex,
      scrollTop: getScrollTop(),
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elTarget.scrollIntoView({ block: "start" });
        debugChatOpenPosition("restoreDone", {
          session: getDebugSessionName(key),
          index: messageIndex,
          scrollTop: getScrollTop(),
        });
        showToast(i18n.restoredLastPosition || "Restored last viewed position.");
      });
    });
    return messageIndex;
  }

  function clearHighlights() {
    for (const elx of document.querySelectorAll(".highlight")) elx.classList.remove("highlight");
  }

  function showToast(text) {
    // Simple toast that disappears after a short delay.
    const toast = el("div", {});
    toast.textContent = String(text || "");
    toast.style.position = "fixed";
    toast.style.right = "12px";
    toast.style.bottom = "12px";
    toast.style.padding = "8px 10px";
    toast.style.border = "1px solid var(--chv-border)";
    toast.style.borderRadius = "8px";
    toast.style.background = "var(--chv-bg)";
    toast.style.color = "var(--chv-fg)";
    toast.style.zIndex = "3";
    document.body.appendChild(toast);
    setTimeout(() => {
      try {
        toast.remove();
      } catch {
        // Ignore rare failures to remove the toast node.
      }
    }, 1200);
  }

  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    return e;
  }

  function shouldAutoShowDetails(model, revealMessageIndex) {
    if (!model || !Array.isArray(model.items)) return false;
    if (typeof revealMessageIndex !== "number") return false;
    for (const item of model.items) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "message") continue;
      if (typeof item.messageIndex !== "number") continue;
      if (item.messageIndex !== revealMessageIndex) continue;
      return item.role === "user";
    }
    return false;
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
