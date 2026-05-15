// File change history webview script.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const restoreCoverEl = document.getElementById("restoreCover");

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
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 12.8a.75.75 0 0 1-.53-.22l-4.1-4.1a.75.75 0 1 1 1.06-1.06L8 11.01l3.57-3.59a.75.75 0 1 1 1.06 1.06l-4.1 4.1a.75.75 0 0 1-.53.22Z"/></svg>';
  const SEARCH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.75 2a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 1.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm4.9 6.83 2.13 2.14a.75.75 0 1 1-1.06 1.06l-2.14-2.13a.75.75 0 1 1 1.07-1.07Z"/></svg>';
  const CLOSE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';
  const OPEN_FILE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h5.5a.75.75 0 0 1 0 1.5h-5.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm4.72 1.22a.75.75 0 0 1 .53-.22h4.25a.75.75 0 0 1 .75.75V8a.75.75 0 0 1-1.5 0V5.56L8.78 9.28a.75.75 0 1 1-1.06-1.06l3.72-3.72H9a.75.75 0 0 1-.53-1.28Z"/></svg>';
  const HISTORY_ICON_SVG = OPEN_FILE_ICON_SVG;
  const BOOKMARK_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.25 2A1.25 1.25 0 0 1 5.5.75h5A1.25 1.25 0 0 1 11.75 2v11.8a.75.75 0 0 1-1.14.64L8 12.86l-2.61 1.58a.75.75 0 0 1-1.14-.64V2Zm1.5.25v10.22l1.86-1.13a.75.75 0 0 1 .78 0l1.86 1.13V2.25h-4.5Z"/></svg>';

  const MIN_PAGE_SEARCH_WIDTH = 280;
  const RESTORE_COVER_HIDE_DELAY_MS = 140;
  const RESTORE_COVER_MIN_VISIBLE_MS = 220;
  const RESTORE_COVER_MAX_WAIT_MS = 900;
  const RESTORE_COVER_STABLE_FRAMES = 3;

  let i18n = {};
  let dateTime = {};
  let model = null;
  let sourceIcons = {};
  let extensionIcon = "";
  let staleReason = null;
  let dismissedStale = false;
  let loadingMore = false;
  let bookmarkedKeys = new Set();
  let timeGuideEnabled = false;
  let debugLoggingEnabled = false;
  let pageSearchOpen = false;
  let pageSearchQuery = "";
  let pageSearchMatches = [];
  let pageSearchResults = [];
  let activePageSearchResultIndex = -1;
  let pageSearchResizeState = null;
  let restoreCoverActive = false;
  let restoreCoverFrame = 0;
  let restoreCoverTimer = 0;
  let restoreCoverShownAt = 0;
  let pendingDateGuideAfterRestoreCover = false;
  let dateGuide = null;
  let dateGuideUpdateFrame = 0;
  let dateGuideUpdateTimer = 0;
  let dateGuideUpdateIdle = 0;
  let dateGuideUpdateGeneration = 0;
  let webviewState = typeof vscode.getState === "function" ? vscode.getState() || {} : {};
  let sourceFilter = normalizeSourceFilter(webviewState.sourceFilter);
  let pageSearchPanelWidth = Number.isFinite(Number(webviewState.pageSearchPanelWidth))
    ? Number(webviewState.pageSearchPanelWidth)
    : null;
  let pendingReloadScrollAnchor = null;

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.i18n) i18n = msg.i18n;
    if (msg.dateTime && typeof msg.dateTime === "object") dateTime = msg.dateTime;
    if (msg.sourceIcons) sourceIcons = msg.sourceIcons;
    if (typeof msg.extensionIcon === "string") extensionIcon = msg.extensionIcon;
    if (typeof msg.timeGuideEnabled === "boolean") {
      timeGuideEnabled = msg.timeGuideEnabled;
      if (!timeGuideEnabled) updateDateGuide();
    }
    debugLoggingEnabled = msg.debugLoggingEnabled === true;

    if (msg.type === "viewState") {
      if (msg.visible === false) showRestoreCover();
      else if (msg.visible === true) scheduleRestoreCoverRelease();
      return;
    }
    if (msg.type === "i18n") {
      render();
      return;
    }
    if (msg.type === "resetUi") {
      resetPageSearchState();
      dismissedStale = false;
      getScrollRoot().scrollTo(0, 0);
      return;
    }
    if (msg.type === "loading") {
      renderLoading(msg.message || "");
      return;
    }
    if (msg.type === "model") {
      const scrollTop = getScrollRoot().scrollTop;
      const reloadScrollAnchor = pendingReloadScrollAnchor;
      pendingReloadScrollAnchor = null;
      model = msg.model || null;
      bookmarkedKeys = normalizeBookmarkKeys(msg.bookmarks);
      const modelReason = typeof msg.reason === "string" ? msg.reason : "";
      sourceFilter = normalizeSourceFilterForModel(sourceFilter, model);
      staleReason = msg.staleReason || null;
      loadingMore = false;
      if (typeof msg.addedCount === "number" && msg.addedCount > 0) {
        requestAnimationFrame(() => {
          const toastKey = model && model.hasMore ? "loadMoreDoneMore" : "loadMoreDone";
          const fallback =
            toastKey === "loadMoreDoneMore"
              ? "Added {0} changes. More history is available."
              : "Added {0} changes";
          showToast(formatTemplate(text(toastKey, fallback), msg.addedCount), { key: "loadMore" });
        });
      } else if (shouldShowMoreHistoryToast(modelReason, model)) {
        requestAnimationFrame(() => {
          showToast(text("loadMoreAvailable", "More history is available. Use Load more at the bottom to continue."), {
            key: "loadMore",
          });
        });
      }
      render();
      if (reloadScrollAnchor) restoreReloadScrollAnchor(reloadScrollAnchor, scrollTop);
      else restoreScroll(scrollTop);
      return;
    }
    if (msg.type === "bookmarkState") {
      bookmarkedKeys = normalizeBookmarkKeys(msg.keys);
      applyBookmarkStateToDom();
      updateDateGuide();
      return;
    }
    if (msg.type === "stale") {
      staleReason = msg.reason || staleReason;
      dismissedStale = false;
      render();
      return;
    }
    if (msg.type === "loadMoreStarted") {
      const scrollTop = getScrollRoot().scrollTop;
      loadingMore = true;
      render();
      restoreScroll(scrollTop);
      return;
    }
    if (msg.type === "error") {
      pendingReloadScrollAnchor = null;
      loadingMore = false;
      renderError(msg.message || "");
      return;
    }
    if (msg.type === "loadMoreFailed") {
      const scrollTop = getScrollRoot().scrollTop;
      loadingMore = false;
      render();
      restoreScroll(scrollTop);
      showToast(msg.message || "", { key: "loadMore" });
      return;
    }
    if (msg.type === "loadMoreCancelled") {
      const scrollTop = getScrollRoot().scrollTop;
      loadingMore = false;
      render();
      restoreScroll(scrollTop);
      showToast(msg.message || text("loadMoreCanceled", "Additional loading was cancelled."), { key: "loadMore" });
      return;
    }
    if (msg.type === "inlineError") {
      showToast(msg.message || "", { key: "inlineError" });
      return;
    }
    if (msg.type === "cancelled") {
      const scrollTop = getScrollRoot().scrollTop;
      loadingMore = false;
      showToast(msg.message || "", { key: "cancelled" });
      render();
      restoreScroll(scrollTop);
      return;
    }
    if (msg.type === "copied") {
      showToast(msg.message || text("copied", "Copied."), { key: "copied" });
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

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openPageSearch();
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      navigatePageSearchResults(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape" && pageSearchOpen && isInsidePageSearch(event.target)) {
      event.preventDefault();
      closePageSearch();
    }
  });

  window.addEventListener("resize", () => {
    pageSearchPanelWidth = normalizePageSearchPanelWidth(pageSearchPanelWidth);
    applyPageSearchPanelWidth();
    updateToolbarHeight(document.getElementById("toolbar"));
    updateDateGuide();
  });
  window.addEventListener("pagehide", () => {
    showRestoreCover();
  });
  window.addEventListener("pageshow", () => {
    scheduleRestoreCoverRelease();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") showRestoreCover();
    else if (document.visibilityState === "visible") scheduleRestoreCoverRelease();
  });

  function renderLoading(message) {
    renderShell((wrap) => {
      const loading = el("section", { className: "statePanel" });
      const titleRow = el("div", { className: "statePanelTitleRow" });
      if (extensionIcon) {
        const icon = el("span", { className: "statePanelIcon" });
        icon.style.setProperty("--state-panel-icon", `url("${extensionIcon}")`);
        titleRow.appendChild(icon);
      }
      const title = el("h1", {});
      title.textContent = text("title", "File AI Change History");
      titleRow.appendChild(title);
      const detail = el("p", {});
      detail.textContent = message || text("loading", "Loading...");
      loading.appendChild(titleRow);
      loading.appendChild(detail);
      wrap.appendChild(loading);
    });
  }

  function renderError(message) {
    renderShell((wrap) => {
      const panel = el("section", { className: "statePanel errorPanel" });
      const title = el("h1", {});
      title.textContent = message || text("loadFailed", "Failed to load.");
      const btn = el("button", { type: "button", className: "primaryBtn" });
      btn.textContent = text("reload", "Reload");
      btn.addEventListener("click", () => vscode.postMessage({ type: "reload" }));
      panel.appendChild(title);
      panel.appendChild(btn);
      wrap.appendChild(panel);
    });
  }

  function render() {
    renderShell((wrap) => {
      if (staleReason && !dismissedStale) wrap.appendChild(renderStaleBanner());

      if (!model) {
        wrap.appendChild(renderEmptyState(text("emptyTitle", "No changes found"), ""));
        return;
      }

      const body = el("div", { className: "fchBody" });
      const content = el("section", { id: "contentRoot", className: "cardColumn" });
      const allCards = Array.isArray(model.cards) ? model.cards : [];
      const cards = getVisibleCards(allCards);
      if (allCards.length === 0) {
        content.appendChild(renderEmptyState(text("emptyTitle", "No changes found"), text("emptyHint", "")));
      } else if (cards.length === 0) {
        content.appendChild(
          renderEmptyState(
            text("emptyFilterTitle", "No changes for selected sources"),
            text("emptyFilterHint", "Turn on Codex or Claude in the header, or load more history."),
          ),
        );
        content.appendChild(renderLoadControls());
      } else {
        for (let i = 0; i < cards.length; i += 1) {
          content.appendChild(renderCard(cards[i], i, cards));
        }
        content.appendChild(renderLoadControls());
      }
      body.appendChild(content);
      wrap.appendChild(body);
    });
  }

  function renderShell(renderContent) {
    clearPageSearchHighlights();
    clearApp();
    const toolbar = renderToolbar();
    app.appendChild(toolbar);
    updateToolbarHeight(toolbar);
    app.appendChild(renderPageSearchPanel());
    const scrollRoot = el("main", { id: "scrollRoot" });
    scrollRoot.addEventListener("scroll", handleScrollRootScroll, { passive: true });
    const wrap = el("div", { className: "fchRoot" });
    renderContent(wrap);
    scrollRoot.appendChild(wrap);
    app.appendChild(scrollRoot);
    if (pageSearchOpen) refreshPageSearchResults({ preserveIndex: true, reveal: false });
    else {
      renderPageSearchResults();
      updatePageSearchStatus();
    }
    updateDateGuide();
  }

  function renderToolbar() {
    const toolbar = el("div", { id: "toolbar" });
    toolbar.appendChild(toolbarIconButton("btnOpenFile", text("openFile", "Open target file"), OPEN_FILE_ICON_SVG, () => {
      vscode.postMessage({ type: "openFile" });
    }));
    toolbar.appendChild(toolbarIconButton("btnCopyPath", text("copyPath", "Copy file path"), COPY_ICON_SVG, () => {
      vscode.postMessage({ type: "copyPath" });
    }));
    toolbar.appendChild(renderToolbarInfo());
    toolbar.appendChild(toolbarIconButton("btnScrollTop", text("top", "Top"), SCROLL_TOP_ICON_SVG, () => {
      scrollToBoundary("top");
    }));
    toolbar.appendChild(toolbarIconButton("btnScrollBottom", text("bottom", "Bottom"), SCROLL_BOTTOM_ICON_SVG, () => {
      scrollToBoundary("bottom");
    }));
    toolbar.appendChild(toolbarIconButton("btnPageSearch", text("pageSearchTooltip", "Toggle in-page search"), SEARCH_ICON_SVG, () => {
      togglePageSearch();
    }));
    toolbar.appendChild(toolbarIconButton("btnReload", text("reload", "Reload"), RELOAD_ICON_SVG, () => {
      requestToolbarReload();
    }));
    return toolbar;
  }

  function renderToolbarInfo() {
    const info = el("div", { id: "toolbarInfo" });
    if (!model || !model.target) {
      info.appendChild(el("span", { className: "toolbarPath" }));
      return info;
    }

    const pathText = el("div", { className: "toolbarPath" });
    pathText.textContent = model.target.fsPath || model.target.fileName || "";
    pathText.title = pathText.textContent;
    info.appendChild(pathText);

    const stats = el("div", { className: "toolbarStats" });
    const total = el("span", { className: "headerResultCount" });
    total.textContent = formatResultCount(getVisibleCards(Array.isArray(model.cards) ? model.cards : []).length);
    stats.appendChild(total);

    const counts = model.sourceCounts || { codex: 0, claude: 0 };
    const enabled = model.enabledSources || {};
    if (enabled.codex) stats.appendChild(sourceCountToggle("codex", counts.codex || 0));
    if (enabled.claude) stats.appendChild(sourceCountToggle("claude", counts.claude || 0));
    info.appendChild(stats);
    return info;
  }

  function renderPageSearchPanel() {
    const bar = el("div", { id: "pageSearchBar" });
    bar.hidden = !pageSearchOpen;
    const resizeHandle = el("div", { id: "pageSearchResizeHandle" });
    resizeHandle.setAttribute("aria-hidden", "true");
    attachPageSearchResizeHandlers(resizeHandle);
    bar.appendChild(resizeHandle);

    const inner = el("div", { id: "pageSearchInner" });
    const header = el("div", { id: "pageSearchHeader" });
    const title = el("div", { id: "pageSearchTitle" });
    title.textContent = text("pageSearchTitle", text("search", "Search"));
    const actions = el("div", { id: "pageSearchActions" });
    actions.appendChild(pageSearchActionButton("btnPageSearchPrev", text("pageSearchPrevTooltip", "Previous match"), NAV_UP_ICON_SVG, () => {
      navigatePageSearchResults(-1);
    }));
    actions.appendChild(pageSearchActionButton("btnPageSearchNext", text("pageSearchNextTooltip", "Next match"), NAV_DOWN_ICON_SVG, () => {
      navigatePageSearchResults(1);
    }));
    actions.appendChild(pageSearchActionButton("btnPageSearchClose", text("pageSearchCloseTooltip", "Close search"), CLOSE_ICON_SVG, () => {
      closePageSearch();
    }));
    header.appendChild(title);
    header.appendChild(actions);
    inner.appendChild(header);

    const inputRow = el("div", { id: "pageSearchInputRow" });
    const input = el("input", { id: "pageSearchInput", type: "search", spellcheck: false, autocomplete: "off" });
    input.placeholder = text("pageSearchPlaceholder", text("searchPlaceholder", "Search loaded diffs"));
    input.value = pageSearchQuery;
    input.addEventListener("input", () => {
      pageSearchQuery = input.value || "";
      refreshPageSearchResults({ reveal: true });
    });
    input.addEventListener("keydown", (event) => {
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
    const count = el("div", { id: "pageSearchCount" });
    count.setAttribute("aria-live", "polite");
    inputRow.appendChild(input);
    inputRow.appendChild(count);
    inner.appendChild(inputRow);
    bar.appendChild(inner);
    bar.appendChild(el("div", { id: "pageSearchResults" }));
    return bar;
  }

  function renderStaleBanner() {
    const banner = el("section", { className: "staleBanner" });
    const msg = el("div", {});
    msg.textContent =
      staleReason === "sources"
        ? text("staleSources", "Source settings changed. Reload to apply.")
        : text("staleIndexToolContent", "Search index content setting changed. Reload to apply.");
    const close = el("button", { type: "button", className: "iconBtn" });
    close.innerHTML = CLOSE_ICON_SVG;
    close.title = text("close", "Close");
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", () => {
      dismissedStale = true;
      vscode.postMessage({ type: "dismissStale" });
      render();
    });
    banner.appendChild(msg);
    banner.appendChild(close);
    return banner;
  }

  function renderEmptyState(titleText, hintText) {
    const panel = el("section", { className: "statePanel" });
    const title = el("h2", {});
    title.textContent = titleText;
    panel.appendChild(title);
    if (hintText) {
      const hint = el("p", {});
      hint.textContent = hintText;
      panel.appendChild(hint);
    }
    return panel;
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

  function getCardBookmarkKey(card) {
    return card && typeof card.bookmarkKey === "string" ? card.bookmarkKey.trim() : "";
  }

  function isCardBookmarked(card) {
    const key = getCardBookmarkKey(card);
    return !!(key && bookmarkedKeys.has(key));
  }

  function createBookmarkButton(card) {
    if (!isBookmarkUiEnabled()) return null;
    const key = getCardBookmarkKey(card);
    if (!key) return null;
    const btn = el("button", { type: "button", className: "iconBtn bookmarkBtn" });
    btn.dataset.bookmarkKey = key;
    btn.innerHTML = BOOKMARK_ICON_SVG;
    syncBookmarkButton(btn, bookmarkedKeys.has(key));
    return btn;
  }

  function syncBookmarkButton(button, bookmarked) {
    if (!(button instanceof HTMLButtonElement)) return;
    const on = bookmarked === true;
    const label = on ? text("bookmarkRemove", "Remove bookmark") : text("bookmarkAdd", "Add bookmark");
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
    for (const card of document.querySelectorAll(".diffCard[data-bookmark-key]")) {
      if (!(card instanceof HTMLElement)) continue;
      const bookmarked = bookmarkedKeys.has(card.dataset.bookmarkKey || "");
      card.dataset.bookmarked = bookmarked ? "true" : "false";
      card.classList.toggle("bookmarked", bookmarked);
    }
  }

  function toggleBookmarkKeyLocally(key) {
    if (!key) return;
    if (bookmarkedKeys.has(key)) bookmarkedKeys.delete(key);
    else bookmarkedKeys.add(key);
    applyBookmarkStateToDom();
    updateDateGuide();
  }

  function isBookmarkUiEnabled() {
    return timeGuideEnabled === true;
  }

  function renderCard(card, index, visibleCards) {
    const cards = Array.isArray(visibleCards) ? visibleCards : [];
    const cardEl = el("article", { className: "diffCard", id: card.id });
    cardEl.dataset.localDate = String(card.localDate || "");
    const bookmarkKey = getCardBookmarkKey(card);
    if (isBookmarkUiEnabled() && bookmarkKey) cardEl.dataset.bookmarkKey = bookmarkKey;
    const cardBookmarked = isBookmarkUiEnabled() && isCardBookmarked(card);
    cardEl.dataset.bookmarked = cardBookmarked ? "true" : "false";
    cardEl.classList.toggle("bookmarked", cardBookmarked);
    const header = el("div", { className: "cardHeader" });

    const left = el("div", { className: "cardTitleBlock" });
    const meta = el("div", { className: "cardMetaLine" });
    const source = el("span", { className: `sourcePill source-${card.source}` });
    source.title = card.sourceLabel || card.source || "";
    if (!appendSourceIcon(source, card.source, "sourceIcon")) {
      const sourceText = el("span", {});
      sourceText.textContent = card.sourceLabel || card.source || "";
      source.appendChild(sourceText);
    }
    meta.appendChild(source);
    appendMeta(meta, card.dateTimeLabel);
    appendMeta(meta, changeTypeLabel(card.changeType));
    left.appendChild(meta);

    const title = el("h2", {});
    title.textContent = card.sessionTitle || "";
    left.appendChild(title);

    header.appendChild(left);

    const actions = el("div", { className: "messageNav cardActions" });
    actions.appendChild(navButton("prevCard", index > 0 ? cards[index - 1]?.id || "" : ""));
    actions.appendChild(navButton("nextCard", index + 1 < cards.length ? cards[index + 1]?.id || "" : ""));
    const bookmarkBtn = createBookmarkButton(card);
    if (bookmarkBtn) actions.appendChild(bookmarkBtn);
    const openBtn = el("button", { type: "button", className: "secondaryBtn iconTextBtn" });
    openBtn.innerHTML = HISTORY_ICON_SVG;
    const openText = el("span", { className: "btnText" });
    openText.textContent = text("openInHistory", "Open in History");
    openBtn.appendChild(openText);
    openBtn.title = openText.textContent;
    openBtn.setAttribute("aria-label", openText.textContent);
    openBtn.addEventListener("click", () => vscode.postMessage({ type: "openHistory", cardId: card.id }));
    actions.appendChild(openBtn);
    header.appendChild(actions);
    cardEl.appendChild(header);

    const stats = el("div", { className: "statLine" });
    if (card.moveDisplayPath && card.moveDisplayPath !== card.displayPath) {
      const moved = el("span", { className: "movedText" });
      moved.textContent = formatTemplate(text("movedTo", "Moved to: {0}"), card.moveDisplayPath);
      stats.appendChild(moved);
    }
    if (stats.childElementCount > 0) cardEl.appendChild(stats);

    const details = el("details", { className: "diffDetails" });
    details.open = !isHugeDiff(card);
    const summary = el("summary", { className: "diffDetailsSummary" });
    const summaryPath = el("span", { className: "diffDetailsPath" });
    summaryPath.textContent = card.displayPath || "";
    summary.appendChild(summaryPath);
    const summaryCounts = el("span", { className: "diffDetailsCounts" });
    summaryCounts.appendChild(countBadge(card.added, "added"));
    summaryCounts.appendChild(countBadge(card.removed, "removed"));
    summary.appendChild(summaryCounts);
    details.appendChild(summary);
    details.appendChild(renderDiff(card.entry || {}));
    cardEl.appendChild(details);
    return cardEl;
  }

  function renderDiff(entry) {
    const wrap = el("div", { className: "diffWrap" });
    const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
    if (hunks.length === 0) {
      const empty = el("div", { className: "emptyDiff" });
      empty.textContent = text("patchNoDiff", "");
      wrap.appendChild(empty);
      return wrap;
    }
    for (const hunk of hunks) {
      const hunkEl = el("section", { className: "patchHunk diffHunk" });
      const header = el("div", { className: "patchHunkHeader hunkHeader" });
      const headerText = el("span", { className: "patchHunkHeaderText hunkHeaderText" });
      headerText.textContent = hunk.header || "@@";
      header.appendChild(headerText);
      hunkEl.appendChild(header);

      const labels = el("div", { className: "patchDiffColumnLabels diffColumnLabels" });
      const before = el("div", { className: "patchDiffColumnLabel patchDiffColumnLabel-before diffColumnLabel" });
      before.textContent = text("patchBefore", "Before");
      const after = el("div", { className: "patchDiffColumnLabel patchDiffColumnLabel-after diffColumnLabel" });
      after.textContent = text("patchAfter", "After");
      labels.appendChild(before);
      labels.appendChild(after);
      hunkEl.appendChild(labels);

      const rows = Array.isArray(hunk.rows) ? hunk.rows : [];
      const blocks = el("div", { className: "patchDiffBlocks" });
      blocks.appendChild(renderPatchBlock(rows, "left"));
      blocks.appendChild(renderPatchBlock(rows, "right"));
      hunkEl.appendChild(blocks);
      wrap.appendChild(hunkEl);
    }
    return wrap;
  }

  function renderPatchBlock(rows, side) {
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
      textColumn.appendChild(renderPatchTextCell(textValue, side, kind, index));
    });

    viewport.appendChild(textColumn);
    block.appendChild(lineColumn);
    block.appendChild(viewport);
    return block;
  }

  function renderPatchLineNumber(value, side, kind, rowIndex) {
    const cell = el("div", { className: `patchDiffLineNo patchDiffLineNo-${side} patchDiffLineNo-${kind}` });
    cell.dataset.rowIndex = String(rowIndex);
    cell.textContent = typeof value === "number" ? String(value) : "";
    return cell;
  }

  function renderPatchTextCell(value, side, kind, rowIndex) {
    const cell = el("div", { className: `patchDiffText patchDiffText-${side} patchDiffText-${kind}` });
    cell.dataset.rowIndex = String(rowIndex);
    cell.textContent = typeof value === "string" && value ? value : " ";
    return cell;
  }

  function renderLoadControls() {
    const wrap = el("section", { className: "loadControls" });
    if (model.hasMore) {
      const btn = el("button", { type: "button", className: "primaryBtn" });
      btn.textContent = text("loadMore", "Load more");
      btn.disabled = loadingMore;
      btn.addEventListener("click", () => {
        if (loadingMore) return;
        vscode.postMessage({ type: "loadMore" });
      });
      wrap.appendChild(btn);
    } else if (model.noMore) {
      const done = el("div", { className: "noMore" });
      done.textContent = text("noMore", "No more history");
      wrap.appendChild(done);
    }
    return wrap;
  }

  function togglePageSearch() {
    if (pageSearchOpen) closePageSearch();
    else openPageSearch();
  }

  function resetPageSearchState() {
    cancelPageSearchResize();
    pageSearchOpen = false;
    pageSearchQuery = "";
    clearPageSearchHighlights();
    pageSearchResults = [];
    activePageSearchResultIndex = -1;
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function openPageSearch() {
    pageSearchOpen = true;
    const bar = document.getElementById("pageSearchBar");
    if (bar instanceof HTMLElement) bar.hidden = false;
    document.body.classList.add("pageSearchOpen");
    applyPageSearchPanelWidth();
    const input = document.getElementById("pageSearchInput");
    if (input instanceof HTMLInputElement) {
      const selectedText = window.getSelection ? String(window.getSelection() || "").trim() : "";
      if (!input.value && selectedText && !/\s*\n\s*/u.test(selectedText)) {
        input.value = selectedText;
        pageSearchQuery = selectedText;
      }
      refreshPageSearchResults({ preserveIndex: true, reveal: false });
      input.focus();
      input.select();
    }
  }

  function closePageSearch() {
    pageSearchOpen = false;
    const bar = document.getElementById("pageSearchBar");
    if (bar instanceof HTMLElement) bar.hidden = true;
    document.body.classList.remove("pageSearchOpen");
    cancelPageSearchResize();
    clearPageSearchHighlights();
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function refreshPageSearchResults(options) {
    const preserveIndex = !!(options && options.preserveIndex);
    const reveal = !options || options.reveal !== false;
    const previousIndex = preserveIndex ? activePageSearchResultIndex : -1;
    const input = document.getElementById("pageSearchInput");
    if (input instanceof HTMLInputElement) pageSearchQuery = input.value.trim();
    const query = pageSearchQuery.trim();
    clearPageSearchHighlights();
    if (!query) {
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    const loweredQuery = query.toLowerCase();
    const roots = [document.getElementById("contentRoot")].filter((node) => node instanceof HTMLElement);
    const textNodes = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return shouldAcceptPageSearchTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      while (walker.nextNode()) textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      const sourceText = textNode.textContent || "";
      const loweredText = sourceText.toLowerCase();
      let matchIndex = loweredText.indexOf(loweredQuery);
      if (matchIndex < 0) continue;

      const fragment = document.createDocumentFragment();
      const pendingMarks = [];
      let cursor = 0;
      while (matchIndex >= 0) {
        if (matchIndex > cursor) fragment.appendChild(document.createTextNode(sourceText.slice(cursor, matchIndex)));
        const mark = document.createElement("mark");
        mark.className = "pageSearchMatch";
        mark.textContent = sourceText.slice(matchIndex, matchIndex + query.length);
        fragment.appendChild(mark);
        pendingMarks.push({ mark, start: matchIndex });
        pageSearchMatches.push(mark);
        cursor = matchIndex + query.length;
        matchIndex = loweredText.indexOf(loweredQuery, cursor);
      }
      if (cursor < sourceText.length) fragment.appendChild(document.createTextNode(sourceText.slice(cursor)));
      textNode.parentNode.replaceChild(fragment, textNode);

      for (const pending of pendingMarks) {
        pageSearchResults.push(buildPageSearchResult(pending.mark, sourceText, pending.start, query.length));
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
    const value = node.textContent || "";
    if (!value.trim()) return false;
    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement)) return false;
    if (parent.closest("#pageSearchBar, .dateGuide")) return false;
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

  function buildPageSearchResult(mark, sourceText, start, length) {
    const card = mark.closest(".diffCard");
    const title = getElementText(card && card.querySelector(".cardTitleBlock h2")) || text("pageSearchTitle", "Find");
    const meta = getElementText(card && card.querySelector(".diffDetailsPath")) || "";
    return {
      mark,
      title,
      meta,
      lineNumber: getNearestLineNumber(mark),
      snippet: buildSearchSnippet(sourceText, start, length),
    };
  }

  function buildSearchSnippet(sourceText, start, length) {
    const prefixStart = Math.max(0, start - 34);
    const suffixEnd = Math.min(sourceText.length, start + length + 54);
    const prefix = `${prefixStart > 0 ? "..." : ""}${sourceText.slice(prefixStart, start)}`;
    const match = sourceText.slice(start, start + length);
    const suffix = `${sourceText.slice(start + length, suffixEnd)}${suffixEnd < sourceText.length ? "..." : ""}`;
    return { prefix, match, suffix };
  }

  function getNearestLineNumber(mark) {
    const patchText = mark.closest(".patchDiffText");
    if (patchText instanceof HTMLElement && patchText.dataset.rowIndex) {
      const block = patchText.closest(".patchDiffBlock");
      const lineNo = block && block.querySelector(`.patchDiffLineNo[data-row-index="${patchText.dataset.rowIndex}"]`);
      const value = getElementText(lineNo);
      if (value) return value;
    }
    const cardIndex = getRenderedCards().findIndex((card) => card.contains(mark));
    return cardIndex >= 0 ? String(cardIndex + 1) : "";
  }

  function renderPageSearchResults() {
    const resultsEl = document.getElementById("pageSearchResults");
    if (!(resultsEl instanceof HTMLElement)) return;
    resultsEl.textContent = "";

    const query = pageSearchQuery.trim();
    if (!query) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = text("pageSearchTypeToSearch", text("searchPlaceholder", "Search loaded diffs"));
      resultsEl.appendChild(empty);
      return;
    }

    if (pageSearchResults.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = text("pageSearchNoMatches", text("searchNoMatches", "No matches"));
      resultsEl.appendChild(empty);
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
      title.textContent = result.title;
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
      resultsEl.appendChild(item);
    });
  }

  function navigatePageSearchResults(delta) {
    if (!pageSearchOpen) openPageSearch();
    refreshPageSearchResults({ preserveIndex: true, reveal: false });
    if (pageSearchResults.length === 0) return;
    const current = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : delta > 0 ? -1 : 0;
    let next = current + delta;
    if (next < 0) next = pageSearchResults.length - 1;
    if (next >= pageSearchResults.length) next = 0;
    activatePageSearchResult(next, { reveal: true });
  }

  function activatePageSearchResult(index, options) {
    if (index < 0 || index >= pageSearchResults.length) return;
    for (const match of pageSearchMatches) match.classList.remove("pageSearchMatch-active");
    activePageSearchResultIndex = index;
    const result = pageSearchResults[index];
    if (result && result.mark) result.mark.classList.add("pageSearchMatch-active");
    updatePageSearchStatus();
    renderPageSearchResults();
    if (options && options.reveal && result && result.mark) {
      result.mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }

  function updatePageSearchStatus() {
    const countEl = document.getElementById("pageSearchCount");
    if (!(countEl instanceof HTMLElement)) return;
    const total = pageSearchResults.length;
    const prev = document.getElementById("btnPageSearchPrev");
    const next = document.getElementById("btnPageSearchNext");
    if (prev instanceof HTMLButtonElement) prev.disabled = total <= 1;
    if (next instanceof HTMLButtonElement) next.disabled = total <= 1;
    if (total === 0) {
      countEl.textContent = "0/0";
      return;
    }
    const current = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex + 1 : 1;
    countEl.textContent = `${current}/${total}`;
  }

  function scrollToBoundary(direction) {
    const cards = getRenderedCards();
    const target = direction === "bottom" ? cards[cards.length - 1] : cards[0];
    if (target) {
      scrollElementIntoRootView(target, { behavior: "smooth", block: "start" });
      return;
    }
    const root = getScrollRoot();
    root.scrollTo({ top: direction === "bottom" ? root.scrollHeight : 0, behavior: "smooth" });
  }

  function getRenderedCards() {
    return Array.from(document.querySelectorAll(".diffCard")).filter((item) => item instanceof HTMLElement);
  }

  function requestToolbarReload() {
    pendingReloadScrollAnchor = captureVisibleCardAnchor();
    debugWebview("reloadAnchor", "captured", {
      hasCard: !!(pendingReloadScrollAnchor && pendingReloadScrollAnchor.cardId),
      cardIndex: pendingReloadScrollAnchor ? pendingReloadScrollAnchor.cardIndex : undefined,
      scrollTop: pendingReloadScrollAnchor ? pendingReloadScrollAnchor.scrollTop : undefined,
    });
    vscode.postMessage({ type: "reload" });
  }

  function captureVisibleCardAnchor() {
    const root = getScrollRoot();
    const scrollTop = Number(root.scrollTop || 0);
    const rootRect = root.getBoundingClientRect();
    const cards = getRenderedCards();
    if (cards.length === 0 || rootRect.height <= 0) return { scrollTop };

    const minFocusLineOffset = Math.min(72, Math.max(0, rootRect.height - 1));
    const maxFocusLineOffset = Math.max(minFocusLineOffset, rootRect.height - 24);
    const focusLineOffset = clampNumber(rootRect.height * 0.25, minFocusLineOffset, maxFocusLineOffset);
    const focusLine = rootRect.top + focusLineOffset;
    let best = null;

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const rect = card.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, rootRect.top);
      const visibleBottom = Math.min(rect.bottom, rootRect.bottom);
      if (visibleBottom <= visibleTop) continue;

      const containsFocus = rect.top <= focusLine && rect.bottom >= focusLine;
      const distance = containsFocus ? 0 : Math.min(Math.abs(rect.top - focusLine), Math.abs(rect.bottom - focusLine));
      if (!best || distance < best.distance || (distance === best.distance && rect.top < best.rectTop)) {
        best = { card, index, distance, rectTop: rect.top };
      }
    }

    if (!best) return { scrollTop };
    const cardRect = best.card.getBoundingClientRect();
    return {
      scrollTop,
      cardId: best.card.id || "",
      cardIndex: best.index,
      focusLineOffset,
      focusOffsetInCard: Math.max(0, focusLine - cardRect.top),
    };
  }

  function restoreReloadScrollAnchor(anchor, fallbackScrollTop) {
    requestAnimationFrame(() => {
      const method = restoreCardAnchor(anchor);
      if (!method) {
        const fallback = Number.isFinite(Number(anchor && anchor.scrollTop)) ? anchor.scrollTop : fallbackScrollTop;
        getScrollRoot().scrollTo(0, Math.max(0, Number(fallback || 0)));
      }
      debugWebview("reloadAnchor", "restored", { method: method || "scrollTop" });
      updateDateGuideCurrent();
    });
  }

  function restoreCardAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return null;
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const idTarget = findRenderedCardById(anchor.cardId);
    const target = idTarget || findRenderedCardByIndex(anchor.cardIndex);
    if (!(target instanceof HTMLElement) || rootRect.height <= 0) return null;

    const targetRect = target.getBoundingClientRect();
    if (targetRect.height <= 0) return null;
    const focusLineOffset = clampNumber(Number(anchor.focusLineOffset), 0, Math.max(0, rootRect.height - 1));
    const focusOffsetInCard = clampNumber(Number(anchor.focusOffsetInCard), 0, Math.max(0, targetRect.height - 1));
    const desiredTop = focusLineOffset - focusOffsetInCard;
    const nextTop = root.scrollTop + targetRect.top - rootRect.top - desiredTop;
    root.scrollTo(0, Math.max(0, Math.floor(nextTop)));
    return idTarget ? "id" : "index";
  }

  function findRenderedCardById(cardId) {
    const id = typeof cardId === "string" ? cardId : "";
    if (!id) return null;
    for (const card of getRenderedCards()) {
      if (card.id === id) return card;
    }
    return null;
  }

  function findRenderedCardByIndex(index) {
    const numericIndex = Number(index);
    if (!Number.isInteger(numericIndex) || numericIndex < 0) return null;
    const cards = getRenderedCards();
    return cards[numericIndex] || null;
  }

  function getVisibleCards(cards) {
    const sourceCards = Array.isArray(cards) ? cards : [];
    return sourceCards.filter((card) => isSourceVisible(card && card.source));
  }

  function isSourceVisible(source) {
    if (source === "codex") return sourceFilter.codex !== false;
    if (source === "claude") return sourceFilter.claude !== false;
    return true;
  }

  function toggleSourceFilter(source) {
    if (source !== "codex" && source !== "claude") return;
    const enabled = (model && model.enabledSources) || {};
    const next = normalizeSourceFilter(sourceFilter);
    next[source] = !next[source];
    const enabledSources = ["codex", "claude"].filter((item) => enabled[item]);
    if (enabledSources.length > 0 && !enabledSources.some((item) => next[item])) return;
    sourceFilter = next;
    persistSourceFilter();
    resetPageSearchState();
    render();
    getScrollRoot().scrollTo(0, 0);
  }

  function normalizeSourceFilter(value) {
    const raw = value && typeof value === "object" ? value : {};
    const next = {
      codex: raw.codex !== false,
      claude: raw.claude !== false,
    };
    if (!next.codex && !next.claude) return { codex: true, claude: true };
    return next;
  }

  function normalizeSourceFilterForModel(filter, currentModel) {
    const next = normalizeSourceFilter(filter);
    const enabled = (currentModel && currentModel.enabledSources) || {};
    const enabledSources = ["codex", "claude"].filter((source) => enabled[source]);
    if (enabledSources.length > 0 && !enabledSources.some((source) => next[source])) {
      for (const source of enabledSources) next[source] = true;
    }
    return next;
  }

  function shouldShowMoreHistoryToast(reason, currentModel) {
    if (reason !== "initial" && reason !== "reload") return false;
    if (!currentModel || currentModel.hasMore !== true) return false;
    if (Array.isArray(currentModel.cards)) return currentModel.cards.length > 0;
    const totalCount = Number(currentModel.totalCount);
    return Number.isFinite(totalCount) && totalCount > 0;
  }

  function persistSourceFilter() {
    webviewState = { ...webviewState, sourceFilter };
    if (typeof vscode.setState === "function") vscode.setState(webviewState);
  }

  function handleScrollRootScroll() {
    if (timeGuideEnabled && dateGuide) dateGuide.handleScroll();
  }

  function updateDateGuide() {
    if (!timeGuideEnabled) {
      pendingDateGuideAfterRestoreCover = false;
      disposeDateGuide();
      return;
    }
    if (isRestoreCoverBlockingDateGuide()) {
      cancelPendingDateGuideUpdate();
      pendingDateGuideAfterRestoreCover = true;
      return;
    }
    scheduleDateGuideUpdateAfterPaint();
  }

  function updateDateGuideCurrent() {
    if (timeGuideEnabled && dateGuide) dateGuide.updateCurrent();
  }

  function ensureDateGuide() {
    if (dateGuide) return dateGuide;
    if (!window.CodexHistoryTimeGuide || typeof window.CodexHistoryTimeGuide.create !== "function") return null;
    dateGuide = window.CodexHistoryTimeGuide.create({
      mode: "timeline",
      positionStrategy: "index",
      minItems: 1,
      getHost: () => document.body,
      getScrollRoot,
      getContentElement: () => document.getElementById("contentRoot"),
      getTimeZone,
      getAriaLabel: () => text("dates", "Dates"),
      getItems: getDateGuideItems,
    });
    return dateGuide;
  }

  function disposeDateGuide() {
    cancelPendingDateGuideUpdate();
    if (!dateGuide) return;
    dateGuide.dispose();
    dateGuide = null;
  }

  function cancelPendingDateGuideUpdate() {
    dateGuideUpdateGeneration += 1;
    if (dateGuideUpdateFrame) {
      cancelAnimationFrame(dateGuideUpdateFrame);
      dateGuideUpdateFrame = 0;
    }
    if (dateGuideUpdateTimer) {
      window.clearTimeout(dateGuideUpdateTimer);
      dateGuideUpdateTimer = 0;
    }
    if (dateGuideUpdateIdle) {
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(dateGuideUpdateIdle);
      dateGuideUpdateIdle = 0;
    }
  }

  function scheduleDateGuideUpdateAfterPaint() {
    cancelPendingDateGuideUpdate();
    const generation = dateGuideUpdateGeneration;
    dateGuideUpdateFrame = requestAnimationFrame(() => {
      dateGuideUpdateFrame = 0;
      const run = () => {
        const startedAt = performance.now();
        dateGuideUpdateIdle = 0;
        dateGuideUpdateTimer = 0;
        if (generation !== dateGuideUpdateGeneration || !timeGuideEnabled || isRestoreCoverBlockingDateGuide()) return;
        const guide = ensureDateGuide();
        if (guide) {
          guide.scheduleUpdate();
          debugWebview("timeGuide", "buildDone", {
            scope: "fileChangeHistory",
            items: getDateGuideItems().length,
            totalMs: Math.round(performance.now() - startedAt),
          });
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        dateGuideUpdateIdle = window.requestIdleCallback(run, { timeout: 500 });
      } else {
        dateGuideUpdateTimer = window.setTimeout(run, 0);
      }
    });
  }

  function getDateGuideItems() {
    const cards = getVisibleCards(model && Array.isArray(model.cards) ? model.cards : []);
    const items = cards
      .map((card, index) => {
        const element = document.getElementById(card.id);
        const actualTimestampMs = parseTimestampMs(card.timestampIso);
        const localDate = isDateKey(card.localDate) ? String(card.localDate) : "";
        const timestampMs = Number.isFinite(actualTimestampMs) ? actualTimestampMs : NaN;
        return {
          actualTimestampMs,
          key: card.id,
          itemIndex: index,
          timestampIso: Number.isFinite(actualTimestampMs) ? String(card.timestampIso || "") : "",
          timestampMs,
          dateKey: localDate,
          title: card.sessionTitle || "",
          bookmarked: isCardBookmarked(card),
          tooltipOverride: buildDateGuideTooltip(card),
          element,
        };
      })
      .filter((item) => item.element instanceof HTMLElement && (Number.isFinite(item.timestampMs) || item.dateKey));
    fillEstimatedDateGuideTimestamps(items);
    return items.filter((item) => Number.isFinite(item.timestampMs));
  }

  function fillEstimatedDateGuideTimestamps(items) {
    let index = 0;
    while (index < items.length) {
      if (Number.isFinite(items[index].actualTimestampMs)) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < items.length && !Number.isFinite(items[index].actualTimestampMs)) index += 1;
      const end = index - 1;
      const previous = findPreviousActualDateGuideItem(items, start);
      const next = findNextActualDateGuideItem(items, end);
      applyEstimatedDateGuideRange(items, start, end, previous, next);
    }
  }

  function applyEstimatedDateGuideRange(items, start, end, previous, next) {
    const count = end - start + 1;
    const previousMs = previous ? previous.actualTimestampMs : NaN;
    const nextMs = next ? next.actualTimestampMs : NaN;
    if (Number.isFinite(previousMs) && Number.isFinite(nextMs) && nextMs > previousMs) {
      const step = (nextMs - previousMs) / (count + 1);
      for (let offset = 0; offset < count; offset += 1) {
        items[start + offset].timestampMs = previousMs + step * (offset + 1);
      }
      return;
    }
    if (Number.isFinite(previousMs)) {
      for (let offset = 0; offset < count; offset += 1) {
        items[start + offset].timestampMs = previousMs + (offset + 1) * 1000;
      }
      return;
    }
    if (Number.isFinite(nextMs)) {
      for (let offset = 0; offset < count; offset += 1) {
        items[start + offset].timestampMs = nextMs - (count - offset) * 1000;
      }
      return;
    }
    for (let offset = 0; offset < count; offset += 1) {
      const item = items[start + offset];
      const fallbackMs = parseDateKeyStartMs(item.dateKey);
      if (Number.isFinite(fallbackMs)) item.timestampMs = fallbackMs + offset * 1000;
    }
  }

  function findPreviousActualDateGuideItem(items, beforeIndex) {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      if (Number.isFinite(items[index].actualTimestampMs)) return items[index];
    }
    return null;
  }

  function findNextActualDateGuideItem(items, afterIndex) {
    for (let index = afterIndex + 1; index < items.length; index += 1) {
      if (Number.isFinite(items[index].actualTimestampMs)) return items[index];
    }
    return null;
  }

  function buildDateGuideTooltip(card) {
    const dateLabel = typeof card.dateTimeLabel === "string" ? card.dateTimeLabel.trim() : "";
    const title = typeof card.sessionTitle === "string" ? card.sessionTitle.trim() : "";
    if (dateLabel && title) return `${dateLabel} - ${title}`;
    return dateLabel || title || "";
  }

  function parseTimestampMs(value) {
    const timestamp = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }

  function parseDateKeyStartMs(value) {
    return isDateKey(value) ? parseTimestampMs(`${value}T00:00:00`) : NaN;
  }

  function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function getTimeZone() {
    return dateTime && typeof dateTime.timeZone === "string" ? dateTime.timeZone.trim() : "";
  }

  function isRestoreCoverBlockingDateGuide() {
    return restoreCoverActive || !!(restoreCoverEl instanceof HTMLElement && !restoreCoverEl.hidden);
  }

  function showRestoreCover() {
    if (!(restoreCoverEl instanceof HTMLElement)) return;
    cancelRestoreCoverRelease();
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
    const toolbar = document.getElementById("toolbar");
    const toolbarHeight = toolbar instanceof HTMLElement ? toolbar.offsetHeight : 0;
    const rootWidth = root instanceof HTMLElement ? root.clientWidth : 0;
    const rootHeight = root instanceof HTMLElement ? root.clientHeight : 0;
    return [window.innerWidth, window.innerHeight, rootWidth, rootHeight, toolbarHeight].join("x");
  }

  function releaseRestoreCover(details = {}) {
    restoreCoverFrame = 0;
    restoreCoverActive = false;
    document.body.classList.remove("restoreCoverActive");
    debugWebview("restoreCover", "release", {
      scope: "fileChangeHistory",
      waitMs: Math.round(Number(details.waitMs || 0)),
      timedOut: details.timedOut === true,
    });
    restoreCoverTimer = window.setTimeout(() => {
      restoreCoverTimer = 0;
      if (!restoreCoverActive && restoreCoverEl instanceof HTMLElement) restoreCoverEl.hidden = true;
      flushDateGuideAfterRestoreCover();
    }, RESTORE_COVER_HIDE_DELAY_MS);
  }

  function flushDateGuideAfterRestoreCover() {
    if (!pendingDateGuideAfterRestoreCover) {
      updateDateGuideCurrent();
      return;
    }
    pendingDateGuideAfterRestoreCover = false;
    updateDateGuide();
  }

  function scrollToCard(id) {
    const target = document.getElementById(id);
    if (!target) return;
    scrollElementIntoRootView(target, { behavior: "smooth", block: "start" });
    target.classList.add("highlight");
    setTimeout(() => target.classList.remove("highlight"), 2000);
  }

  function scrollElementIntoRootView(element, options) {
    const root = getScrollRoot();
    const rootRect = root.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const block = options && options.block === "center" ? "center" : "start";
    const behavior = (options && options.behavior) || "auto";
    const nextTop =
      block === "center"
        ? root.scrollTop + elementRect.top - rootRect.top - rootRect.height / 2 + elementRect.height / 2
        : root.scrollTop + elementRect.top - rootRect.top;
    root.scrollTo({ top: Math.max(0, Math.floor(nextTop)), behavior });
  }

  function updateToolbarHeight(toolbar) {
    if (toolbar instanceof HTMLElement) {
      document.documentElement.style.setProperty("--chv-toolbar-height", `${toolbar.offsetHeight}px`);
    }
  }

  function toolbarIconButton(id, label, svg, handler) {
    const btn = el("button", { id, type: "button", className: "toolbarIconBtn" });
    btn.innerHTML = svg;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", handler);
    return btn;
  }

  function pageSearchActionButton(id, label, svg, handler) {
    const btn = el("button", { id, type: "button", className: "toolbarIconBtn" });
    btn.innerHTML = svg;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", handler);
    return btn;
  }

  function navButton(labelKey, targetId) {
    const btn = el("button", { type: "button", className: "iconBtn navBtn" });
    btn.title = text(labelKey, labelKey);
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = labelKey === "prevCard" ? NAV_UP_ICON_SVG : NAV_DOWN_ICON_SVG;
    btn.disabled = !targetId;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      scrollToCard(targetId);
    });
    return btn;
  }

  function attachPageSearchResizeHandlers(handle) {
    handle.addEventListener("pointerdown", (event) => {
      const bar = document.getElementById("pageSearchBar");
      if (!(bar instanceof HTMLElement)) return;
      if (window.innerWidth <= 860) return;
      event.preventDefault();
      event.stopPropagation();
      pageSearchResizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: bar.getBoundingClientRect().width,
      };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("pageSearchResizing");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!pageSearchResizeState || pageSearchResizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      pageSearchPanelWidth = normalizePageSearchPanelWidth(
        pageSearchResizeState.startWidth + (pageSearchResizeState.startX - event.clientX),
      );
      applyPageSearchPanelWidth();
    });
    const finishResize = (event) => {
      if (!pageSearchResizeState || pageSearchResizeState.pointerId !== event.pointerId) return;
      pageSearchResizeState = null;
      document.body.classList.remove("pageSearchResizing");
      persistPageSearchPanelWidth();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointerup", finishResize);
    handle.addEventListener("pointercancel", finishResize);
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      pageSearchPanelWidth = null;
      applyPageSearchPanelWidth();
      persistPageSearchPanelWidth();
    });
  }

  function cancelPageSearchResize() {
    const resizeState = pageSearchResizeState;
    pageSearchResizeState = null;
    document.body.classList.remove("pageSearchResizing");
    const handle = document.getElementById("pageSearchResizeHandle");
    if (
      resizeState &&
      handle instanceof HTMLElement &&
      handle.hasPointerCapture(resizeState.pointerId)
    ) {
      handle.releasePointerCapture(resizeState.pointerId);
    }
  }

  function normalizePageSearchPanelWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || window.innerWidth <= 860) return null;
    const max = Math.max(MIN_PAGE_SEARCH_WIDTH, window.innerWidth - 20);
    return Math.min(max, Math.max(MIN_PAGE_SEARCH_WIDTH, Math.round(numeric)));
  }

  function applyPageSearchPanelWidth() {
    const bar = document.getElementById("pageSearchBar");
    if (!(bar instanceof HTMLElement)) return;
    const width = normalizePageSearchPanelWidth(pageSearchPanelWidth);
    if (width == null) bar.style.removeProperty("--chv-page-search-width");
    else bar.style.setProperty("--chv-page-search-width", `${width}px`);
  }

  function persistPageSearchPanelWidth() {
    webviewState = { ...webviewState, pageSearchPanelWidth };
    if (typeof vscode.setState === "function") vscode.setState(webviewState);
  }

  function isInsidePageSearch(target) {
    return target instanceof Node && !!document.getElementById("pageSearchBar")?.contains(target);
  }

  function appendMeta(parent, value) {
    if (!value) return;
    const item = el("span", { className: "metaChip" });
    item.textContent = value;
    parent.appendChild(item);
  }

  function isHugeDiff(card) {
    const rows = ((card.entry && card.entry.hunks) || []).reduce((sum, hunk) => sum + ((hunk.rows || []).length || 0), 0);
    return rows > 800 || Number(card.added || 0) + Number(card.removed || 0) > 1000;
  }

  function restoreScroll(scrollTop) {
    requestAnimationFrame(() => {
      getScrollRoot().scrollTo(0, Math.max(0, Number(scrollTop || 0)));
      updateDateGuideCurrent();
    });
  }

  function clampNumber(value, min, max) {
    const numericValue = Number(value);
    const numericMin = Number(min);
    const numericMax = Number(max);
    if (!Number.isFinite(numericValue)) return Number.isFinite(numericMin) ? numericMin : 0;
    if (!Number.isFinite(numericMin) || !Number.isFinite(numericMax) || numericMin > numericMax) return numericValue;
    return Math.min(numericMax, Math.max(numericMin, numericValue));
  }

  function debugWebview(scope, eventName, details) {
    if (!debugLoggingEnabled) return;
    vscode.postMessage({
      type: "debug",
      scope,
      event: eventName,
      details: details && typeof details === "object" ? details : {},
    });
  }

  function getScrollRoot() {
    const root = document.getElementById("scrollRoot");
    return root instanceof HTMLElement ? root : document.scrollingElement || document.documentElement;
  }

  function showToast(message, options = {}) {
    const container = ensureToastContainer();
    if (!container) return;
    const toastKey = normalizeToastKey(options.key);
    if (toastKey) removeExistingToastByKey(container, toastKey);
    const toast = el("div", { className: "fchToast" });
    toast.textContent = String(message || "");
    if (toastKey) toast.dataset.toastKey = toastKey;
    container.appendChild(toast);
    setTimeout(() => {
      try {
        toast.remove();
        if (container.childElementCount === 0) container.remove();
      } catch {
        // Ignore rare failures to remove the toast node.
      }
    }, 2400);
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

  function ensureToastContainer() {
    const existing = document.querySelector(".fchToastContainer");
    if (existing instanceof HTMLElement) return existing;
    if (!(document.body instanceof HTMLElement)) return null;
    const container = el("div", { className: "fchToastContainer" });
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
    return container;
  }

  function getElementText(node) {
    return node instanceof HTMLElement && typeof node.textContent === "string" ? node.textContent.trim() : "";
  }

  function formatResultCount(count) {
    return count === 1
      ? text("resultCountOne", "1 change")
      : formatTemplate(text("resultCountMany", "{0} changes"), count);
  }

  function countBadge(value, kind) {
    const patchKind = kind === "added" ? "add" : "remove";
    const badge = el("span", { className: `countBadge ${kind} patchCountBadge patchCountBadge-${patchKind}` });
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    badge.textContent = `${patchKind === "add" ? "+" : "-"}${safeValue}`;
    return badge;
  }

  function sourceCountToggle(source, count) {
    const chip = el("button", { type: "button", className: `toolbarSourceCount toolbarSourceCount-${source}` });
    const label = source === "codex" ? "Codex" : "Claude";
    const active = isSourceVisible(source);
    chip.title = `${label} ${Number(count || 0)}`;
    chip.setAttribute("aria-label", chip.title);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.addEventListener("click", () => toggleSourceFilter(source));
    if (!appendSourceIcon(chip, source, "toolbarSourceIcon")) {
      const fallback = el("span", { className: "toolbarSourceFallback" });
      fallback.textContent = label.charAt(0);
      chip.appendChild(fallback);
    }
    const value = el("span", { className: "toolbarSourceValue" });
    value.textContent = String(Number(count || 0));
    chip.appendChild(value);
    return chip;
  }

  function appendSourceIcon(parent, source, className) {
    if (!(parent instanceof Element)) return false;
    const icons = normalizeSourceIconSet(source);
    if (!icons) return false;
    if (icons.light && icons.dark && icons.light !== icons.dark) {
      parent.appendChild(createSourceIconImage(icons.light, `${className} sourceIconThemeLight`));
      parent.appendChild(createSourceIconImage(icons.dark, `${className} sourceIconThemeDark`));
      return true;
    }
    const src = icons.light || icons.dark;
    if (!src) return false;
    parent.appendChild(createSourceIconImage(src, className));
    return true;
  }

  function createSourceIconImage(src, className) {
    const icon = el("img", { className, alt: "" });
    icon.src = src;
    return icon;
  }

  function normalizeSourceIconSet(source) {
    const raw = sourceIcons && sourceIcons[source];
    if (!raw) return null;
    if (typeof raw === "string") return { light: raw, dark: raw };
    if (typeof raw !== "object") return null;
    const light = typeof raw.light === "string" ? raw.light : "";
    const dark = typeof raw.dark === "string" ? raw.dark : "";
    if (!light && !dark) return null;
    return { light, dark };
  }

  function changeTypeLabel(value) {
    return (
      {
        create: text("changeTypeCreate", "Create"),
        delete: text("changeTypeDelete", "Delete"),
        move: text("changeTypeMove", "Move"),
        rename: text("changeTypeRename", "Rename"),
        update: text("changeTypeUpdate", "Update"),
      }[value] || text("changeTypeUnknown", "Unknown")
    );
  }

  function text(key, fallback) {
    return typeof i18n[key] === "string" ? i18n[key] : fallback;
  }

  function formatTemplate(template) {
    const args = Array.prototype.slice.call(arguments, 1);
    return String(template || "").replace(/\{(\d+)\}/g, (_m, n) => {
      const value = args[Number(n)];
      return value === undefined ? `{${n}}` : String(value);
    });
  }

  function clearApp() {
    while (app.firstChild) app.removeChild(app.firstChild);
  }

  function el(tag, props) {
    const node = document.createElement(tag);
    if (!props) return node;
    for (const [key, value] of Object.entries(props)) {
      if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
    return node;
  }

  vscode.postMessage({ type: "ready" });
})();
