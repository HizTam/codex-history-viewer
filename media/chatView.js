// Webview script. Communicates with the extension via postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const toolbarEl = document.getElementById("toolbar");
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
  const btnReload = document.getElementById("btnReload");

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
  const RESUME_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.5 2.5a.75.75 0 0 1 .75.75v2.53A5.25 5.25 0 1 1 2.75 8a.75.75 0 0 1 1.5 0 3.75 3.75 0 1 0 2-3.31v2.06a.75.75 0 0 1-1.28.53L2.7 5.03a.75.75 0 0 1 0-1.06l2.27-2.25a.75.75 0 0 1 .53-.22Z"/></svg>';
  const PIN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.25 1.5a.75.75 0 0 0-.53 1.28L5.94 4v2.38L3.72 8.6a.75.75 0 0 0 .53 1.28h3v4.37a.75.75 0 0 0 1.5 0V9.88h3a.75.75 0 0 0 .53-1.28L10.06 6.38V4l1.22-1.22a.75.75 0 0 0-.53-1.28h-5.5Z"/></svg>';
  const UNPIN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M11.28 2.78a.75.75 0 1 0-1.06-1.06L1.72 10.22a.75.75 0 1 0 1.06 1.06l3.13-3.13h1.34v3.1a.75.75 0 1 0 1.5 0v-3.1h1.34l2.13 2.13a.75.75 0 1 0 1.06-1.06L11.06 7V5.66l.22-.22a.75.75 0 0 0 0-1.06L10.84 3.94l.44-.44Z"/></svg>';
  const MARKDOWN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.25 2h9.5A1.75 1.75 0 0 1 14.5 3.75v8.5A1.75 1.75 0 0 1 12.75 14h-9.5A1.75 1.75 0 0 1 1.5 12.25v-8.5A1.75 1.75 0 0 1 3.25 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h9.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-9.5Zm1.5 1.75h1.5l1.25 1.88 1.25-1.88h1.5v5.5H9V7.55L7.5 9.75 6 7.55v3.2H4.75v-5.5Zm6.5 3h1.25l-1.88 2.5-1.87-2.5h1.25V5.25h1.25v3Z"/></svg>';
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

  /** @type {any} */
  let model = null;
  /** @type {any} */
  let i18n = {};
  /** @type {{ timeZone?: string }} */
  let dateTime = {};
  let toolDisplayMode = "detailsOnly";
  let userLongMessageFolding = "off";
  let assistantLongMessageFolding = "off";
  let showDetails = false;
  let expandedNote = false;
  let selectedMessageIndex = null;
  let messageNavMap = new Map();
  let expandedMessageIndexes = new Set();
  let isPinned = false;
  let toolbarCompactFrame = 0;
  const toolbarResizeObserver =
    typeof ResizeObserver === "function" && toolbarEl instanceof HTMLElement
      ? new ResizeObserver(() => {
          scheduleToolbarCompactMode();
        })
      : null;

  // Initial button labels (overwritten after receiving sessionData).
  setToolbarButtonWithIcon(btnResumeInCodex, "Resume in Codex", RESUME_ICON_SVG);
  setToolbarButtonWithIcon(btnPinToggle, "Pin", PIN_ICON_SVG);
  setToolbarButtonWithIcon(btnMarkdown, "Markdown", MARKDOWN_ICON_SVG);
  setToolbarButtonWithIcon(btnCopyResume, "Copy prompt", COPY_ICON_SVG);
  // Scroll buttons stay icon-only in the toolbar.
  if (btnScrollTop instanceof HTMLElement) btnScrollTop.innerHTML = SCROLL_TOP_ICON_SVG;
  if (btnScrollBottom instanceof HTMLElement) btnScrollBottom.innerHTML = SCROLL_BOTTOM_ICON_SVG;
  // Reload is icon-only (tooltip is set via i18n).
  btnReload.innerHTML = RELOAD_ICON_SVG;
  setToolbarButtonWithIcon(btnToggleDetails, "Details", DETAILS_OFF_ICON_SVG);

  btnResumeInCodex.addEventListener("click", () => {
    vscode.postMessage({ type: "resumeInSource" });
  });
  btnPinToggle.addEventListener("click", () => {
    vscode.postMessage({ type: "togglePin" });
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

  btnReload.addEventListener("click", () => {
    // Send current position to the extension so reload can preserve scroll/selection.
    vscode.postMessage({
      type: "reload",
      scrollY: window.scrollY,
      selectedMessageIndex: typeof selectedMessageIndex === "number" ? selectedMessageIndex : undefined,
    });
  });

  btnToggleDetails.addEventListener("click", () => {
    showDetails = !showDetails;
    updateToolbar();
    render();
  });

  window.addEventListener("resize", () => {
    scheduleToolbarCompactMode();
  });
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

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "sessionData") {
      const restoreScrollY = typeof msg.restoreScrollY === "number" ? msg.restoreScrollY : undefined;
      const restoreSelectedMessageIndex =
        typeof msg.restoreSelectedMessageIndex === "number" ? msg.restoreSelectedMessageIndex : undefined;
      const isRestore = typeof restoreScrollY === "number" || typeof restoreSelectedMessageIndex === "number";

      const prevShowDetails = showDetails;
      const prevSelectedMessageIndex = selectedMessageIndex;
      const prevExpandedMessageIndexes = new Set(expandedMessageIndexes);

      model = msg.model || null;
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || {};
      toolDisplayMode = msg.toolDisplayMode === "compactCards" ? "compactCards" : "detailsOnly";
      userLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.userLongMessageFolding === "string" ? msg.userLongMessageFolding : msg.longMessageFolding,
      );
      assistantLongMessageFolding = normalizeLongMessageFoldingMode(
        typeof msg.assistantLongMessageFolding === "string"
          ? msg.assistantLongMessageFolding
          : msg.longMessageFolding,
      );
      isPinned = !!msg.isPinned;
      expandedNote = false;
      selectedMessageIndex = isRestore
        ? typeof restoreSelectedMessageIndex === "number"
          ? restoreSelectedMessageIndex
          : prevSelectedMessageIndex
        : typeof msg.revealMessageIndex === "number"
          ? msg.revealMessageIndex
          : null;
      expandedMessageIndexes = isRestore ? prevExpandedMessageIndexes : new Set();
      if (!isRestore && typeof msg.revealMessageIndex === "number") {
        expandedMessageIndexes.add(msg.revealMessageIndex);
      }

      // On reload, preserve the current UI state (details visibility); on normal render, auto-determine as before.
      showDetails = isRestore ? prevShowDetails : shouldAutoShowDetails(model, selectedMessageIndex);
      updateToolbar();
      render();

      if (isRestore) {
        if (typeof selectedMessageIndex === "number") restoreHighlight(selectedMessageIndex);
        if (typeof restoreScrollY === "number") restoreScroll(restoreScrollY);
      } else if (typeof msg.revealMessageIndex === "number") {
        revealMessage(msg.revealMessageIndex);
      }
      return;
    }
    if (msg.type === "i18n") {
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || dateTime || {};
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
      updateToolbar();
      render();
      return;
    }
    if (msg.type === "copied") {
      showToast(i18n.copied || "Copied.");
      return;
    }
  });

  vscode.postMessage({ type: "ready" });

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
    const scrollingEl = document.scrollingElement || document.documentElement;
    const top = direction === "bottom" ? scrollingEl.scrollHeight : 0;
    window.scrollTo({ top, behavior: "smooth" });
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
  }

  function render() {
    if (annotationEl) annotationEl.textContent = "";
    metaEl.textContent = "";
    timelineEl.textContent = "";
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
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rendered = renderItem(item);
      if (rendered) timelineEl.appendChild(rendered);
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

  function renderItem(item) {
    if (item.type === "message") return renderMessage(item);
    if (item.type === "tool") return shouldRenderToolCard() ? renderTool(item) : null;
    return showDetails ? renderNote(item) : null;
  }

  function renderMessage(item) {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "assistant";
    if (role !== "assistant" && !showDetails && item.isContext) return null;

    const textToRender = getMessageTextToRender(item, role);
    if (role === "user" && !showDetails && !textToRender.trim()) return null;
    if (role === "developer" && !showDetails) return null;

    const row = el("div", { className: `row ${role}` });

    const bubble = el("div", { className: `bubble ${role}` });
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

    if ((role === "user" || role === "assistant") && typeof item.messageIndex === "number") {
      const nav = messageNavMap.get(item.messageIndex);
      if (nav && nav.showNav) {
        const navActions = el("div", { className: "messageNav" });
        navActions.appendChild(createMessageNavButton("prev", nav.role, nav.prevIndex));
        navActions.appendChild(createMessageNavButton("next", nav.role, nav.nextIndex));
        metaLine.appendChild(navActions);
      }
    }
    bubble.appendChild(metaLine);

    const collapseState = resolveMessageCollapseState(item, role, textToRender);
    const body = el("div", { className: `messageBody messageBody-${role}` });
    if (collapseState.canCollapse && collapseState.collapsed) {
      body.classList.add("messageBody-collapsed", `messageBody-collapsed-${role}`);
    }

    const content = el("div", { className: role === "assistant" ? "messageBodyContent markdown" : "messageBodyContent" });
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

  function renderTool(item) {
    const row = el("div", { className: "row tool" });
    const presentation = resolveToolPresentation(item);
    const bubble = el("div", { className: "bubble tool toolCard" });
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
    if (presentation.badgeText) {
      const badge = el("span", { className: "toolCardBadge" });
      badge.textContent = presentation.badgeText;
      header.appendChild(badge);
    }
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
      appendToolDetailsBlock(bubble, i18n.arguments || "Arguments", "json", item.argumentsText);
      appendToolDetailsBlock(bubble, i18n.output || "Output", "", item.outputText);
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

  function renderNote(item) {
    const row = el("div", { className: "row tool" });
    const bubble = el("div", { className: "bubble tool" });
    const title = el("div", { className: "metaLine" });
    title.textContent = item && item.title ? String(item.title) : "note";
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
      if (!text.trim()) return false;
    }
    return true;
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
        window.scrollTo(0, y);
      });
    });
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
