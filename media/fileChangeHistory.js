// File change history webview script.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const restoreCoverEl = document.getElementById("restoreCover");
  const pageSearchBarEl = document.getElementById("pageSearchBar");
  const pageSearchResizeHandleEl = document.getElementById("pageSearchResizeHandle");
  const pageSearchTitleEl = document.getElementById("pageSearchTitle");
  const pageSearchInputEl = document.getElementById("pageSearchInput");
  const pageSearchCountEl = document.getElementById("pageSearchCount");
  const pageSearchSuggestionsEl = document.getElementById("pageSearchSuggestions");
  const pageSearchResultsEl = document.getElementById("pageSearchResults");
  const btnPageSearchPrevEl = document.getElementById("btnPageSearchPrev");
  const btnPageSearchNextEl = document.getElementById("btnPageSearchNext");
  const btnPageSearchCloseEl = document.getElementById("btnPageSearchClose");

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
  const TRASH_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.25 1.75h3.5c.69 0 1.25.56 1.25 1.25v.5h2.25a.75.75 0 0 1 0 1.5H12.9l-.62 8.05A1.75 1.75 0 0 1 10.54 14H5.46a1.75 1.75 0 0 1-1.74-1.95L3.1 5H2.75a.75.75 0 0 1 0-1.5H5V3c0-.69.56-1.25 1.25-1.25Zm1.25 5a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 1.5 0v-5Zm2.5 0a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 1.5 0v-5ZM6.5 3.5h3V3h-3v.5Zm-1 1.5.61 7.94c.01.03.03.06.07.06h5.08c.04 0 .06-.03.07-.06L11.5 5h-6Z"/></svg>';
  const OPEN_FILE_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.75 2h5.5a.75.75 0 0 1 0 1.5h-5.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm4.72 1.22a.75.75 0 0 1 .53-.22h4.25a.75.75 0 0 1 .75.75V8a.75.75 0 0 1-1.5 0V5.56L8.78 9.28a.75.75 0 1 1-1.06-1.06l3.72-3.72H9a.75.75 0 0 1-.53-1.28Z"/></svg>';
  const HISTORY_ICON_SVG = OPEN_FILE_ICON_SVG;
  const BOOKMARK_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.25 2A1.25 1.25 0 0 1 5.5.75h5A1.25 1.25 0 0 1 11.75 2v11.8a.75.75 0 0 1-1.14.64L8 12.86l-2.61 1.58a.75.75 0 0 1-1.14-.64V2Zm1.5.25v10.22l1.86-1.13a.75.75 0 0 1 .78 0l1.86 1.13V2.25h-4.5Z"/></svg>';

  const MIN_PAGE_SEARCH_WIDTH = 280;
  const PAGE_SEARCH_HORIZONTAL_MARGIN = 16;
  const PAGE_SEARCH_REFRESH_DEBOUNCE_MS = 180;
  const MAX_PAGE_SEARCH_HISTORY_CANDIDATES = 20;
  const RESTORE_POSITION_SAVE_DEBOUNCE_MS = 500;
  const RESTORE_COVER_HIDE_DELAY_MS = 140;
  const RESTORE_COVER_MIN_VISIBLE_MS = 220;
  const RESTORE_COVER_MAX_WAIT_MS = 900;
  const RESTORE_COVER_STABLE_FRAMES = 3;

  let i18n = {};
  let dateTime = {};
  let model = null;
  let modelCardIndexById = new Map();
  let modelCardById = new Map();
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
  let pageSearchHistoryCandidates = [];
  let pageSearchShowingSuggestions = false;
  let activePageSearchSuggestionIndex = -1;
  let suppressNextPageSearchFocusSuggestions = false;
  let pageSearchCaseSensitive = false;
  let pageSearchErrorText = "";
  let lastCommittedPageSearchHistory = null;
  let pageSearchRefreshTimer = 0;
  let pageSearchResizeState = null;
  let restorePositionSaveTimer = 0;
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
  pageSearchCaseSensitive = webviewState.pageSearchCaseSensitive === true;
  let pendingReloadScrollAnchor = null;
  let pendingLoadMoreScrollAnchor = null;

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.i18n) {
      i18n = msg.i18n;
      updatePageSearchStaticText();
    }
    if (msg.dateTime && typeof msg.dateTime === "object") dateTime = msg.dateTime;
    if (msg.searchHistoryCandidates) {
      pageSearchHistoryCandidates = normalizeSearchHistoryCandidates(msg.searchHistoryCandidates);
      reconcileCommittedPageSearchHistory();
    }
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
      updatePageSearchStaticText();
      render();
      return;
    }
    if (msg.type === "searchHistoryCandidates") {
      pageSearchHistoryCandidates = normalizeSearchHistoryCandidates(msg.candidates);
      reconcileCommittedPageSearchHistory();
      if (pageSearchShowingSuggestions) updatePageSearchSuggestionsAfterInput(pageSearchInputEl);
      return;
    }
    if (msg.type === "resetUi") {
      resetPageSearchState();
      dismissedStale = false;
      pendingReloadScrollAnchor = null;
      pendingLoadMoreScrollAnchor = null;
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
      const loadMoreScrollAnchor = msg.reason === "loadMore" ? pendingLoadMoreScrollAnchor : null;
      pendingReloadScrollAnchor = null;
      pendingLoadMoreScrollAnchor = null;
      model = msg.model || null;
      rebuildModelCardIndex();
      bookmarkedKeys = normalizeBookmarkKeys(msg.bookmarks);
      const modelReason = typeof msg.reason === "string" ? msg.reason : "";
      sourceFilter = normalizeSourceFilterForModel(sourceFilter, model);
      staleReason = msg.staleReason || null;
      loadingMore = false;
      const addedCount = normalizePositiveInteger(msg.addedCount);
      const visibleAddedCount = getVisibleAddedCount(msg);
      if (visibleAddedCount > 0) {
        requestAnimationFrame(() => {
          const toastKey = model && model.hasMore ? "loadMoreDoneMore" : "loadMoreDone";
          const fallback =
            toastKey === "loadMoreDoneMore"
              ? "Added {0} changes. More history is available."
              : "Added {0} changes";
          showToast(formatTemplate(text(toastKey, fallback), visibleAddedCount), { key: "loadMore" });
        });
      } else if (addedCount > 0) {
        requestAnimationFrame(() => {
          const toastKey = model && model.hasMore ? "loadMoreHiddenSourcesMore" : "loadMoreHiddenSources";
          const fallback =
            toastKey === "loadMoreHiddenSourcesMore"
              ? "Added {0} changes for hidden sources. More history is available."
              : "Added {0} changes for hidden sources.";
          showToast(formatTemplate(text(toastKey, fallback), addedCount), { key: "loadMore" });
        });
      } else if (shouldShowMoreHistoryToast(modelReason, model)) {
        requestAnimationFrame(() => {
          showToast(text("loadMoreAvailable", "More history is available. Use Load more at the bottom to continue."), {
            key: "loadMore",
          });
        });
      }
      render(modelReason);
      if (reloadScrollAnchor) restoreScrollAnchor(reloadScrollAnchor, scrollTop, persistRestoreState, "reloadAnchor");
      else if (msg.scrollAnchor) restoreScrollAnchor(msg.scrollAnchor, scrollTop, persistRestoreState, "reloadAnchor");
      else if (loadMoreScrollAnchor) restoreScrollAnchor(loadMoreScrollAnchor, scrollTop, persistRestoreState, "loadMoreAnchor");
      else restoreScroll(scrollTop, persistRestoreState);
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
      pendingLoadMoreScrollAnchor = captureVisibleCardAnchor();
      loadingMore = true;
      render();
      restoreScroll(scrollTop);
      return;
    }
    if (msg.type === "error") {
      pendingReloadScrollAnchor = null;
      pendingLoadMoreScrollAnchor = null;
      loadingMore = false;
      model = null;
      modelCardIndexById = new Map();
      modelCardById = new Map();
      renderError(msg.message || "");
      return;
    }
    if (msg.type === "loadMoreFailed") {
      const scrollTop = getScrollRoot().scrollTop;
      pendingLoadMoreScrollAnchor = null;
      loadingMore = false;
      render();
      restoreScroll(scrollTop);
      showToast(msg.message || "", { key: "loadMore" });
      return;
    }
    if (msg.type === "loadMoreCancelled") {
      const scrollTop = getScrollRoot().scrollTop;
      pendingLoadMoreScrollAnchor = null;
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
      pendingLoadMoreScrollAnchor = null;
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

  document.addEventListener("click", (event) => {
    if (!pageSearchShowingSuggestions) return;
    if (!isPageSearchSuggestionInteractionTarget(event.target)) hidePageSearchSuggestions();
  });

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
    applyPageSearchPanelWidth();
    updateToolbarHeight(document.getElementById("toolbar"));
    updateDateGuide();
  });
  window.addEventListener("pagehide", () => {
    showRestoreCover();
    persistRestorePosition({ immediate: true });
  });
  window.addEventListener("pageshow", () => {
    scheduleRestoreCoverRelease();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      showRestoreCover();
      persistRestorePosition({ immediate: true });
    }
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

  function render(modelReason) {
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
    }, { preservePageSearchIndex: modelReason !== "reload" });
  }

  function renderShell(renderContent, options) {
    const preservePageSearchIndex = !(options && options.preservePageSearchIndex === false);
    const pageSearchAnchor = pageSearchOpen && preservePageSearchIndex ? captureActivePageSearchResultAnchor() : null;
    clearPageSearchHighlights();
    clearApp();
    const toolbar = renderToolbar();
    app.appendChild(toolbar);
    updateToolbarHeight(toolbar);
    const scrollRoot = el("main", { id: "scrollRoot" });
    scrollRoot.addEventListener("scroll", handleScrollRootScroll, { passive: true });
    const wrap = el("div", { className: "fchRoot" });
    renderContent(wrap);
    scrollRoot.appendChild(wrap);
    app.appendChild(scrollRoot);
    if (pageSearchOpen) {
      refreshPageSearchResults({ preserveIndex: preservePageSearchIndex, reveal: false, anchor: pageSearchAnchor });
    } else {
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

  function initializePageSearchPanel() {
    if (pageSearchResizeHandleEl instanceof HTMLElement) attachPageSearchResizeHandlers(pageSearchResizeHandleEl);
    setupStaticPageSearchButton(btnPageSearchPrevEl, NAV_UP_ICON_SVG, () => navigatePageSearchResults(-1));
    setupStaticPageSearchButton(btnPageSearchNextEl, NAV_DOWN_ICON_SVG, () => navigatePageSearchResults(1));
    setupStaticPageSearchButton(btnPageSearchCloseEl, CLOSE_ICON_SVG, () => closePageSearch());
    if (pageSearchInputEl instanceof HTMLInputElement) {
      pageSearchInputEl.value = pageSearchQuery;
      pageSearchInputEl.addEventListener("input", () => {
        pageSearchQuery = pageSearchInputEl.value || "";
        if (pageSearchShowingSuggestions) {
          updatePageSearchSuggestionsAfterInput(pageSearchInputEl);
        }
        schedulePageSearchRefresh({ reveal: false, keepSuggestions: true });
      });
      pageSearchInputEl.addEventListener("focus", () => {
        if (suppressNextPageSearchFocusSuggestions) suppressNextPageSearchFocusSuggestions = false;
      });
      pageSearchInputEl.addEventListener("click", () => {
        showPageSearchSuggestions();
      });
      pageSearchInputEl.addEventListener("keydown", (event) => {
        handlePageSearchInputKeydown(event, pageSearchInputEl);
      });
    }
    updatePageSearchStaticText();
    syncPageSearchPanelVisibility();
    applyPageSearchPanelWidth();
    renderPageSearchResults();
    renderPageSearchSuggestions();
    updatePageSearchStatus();
  }

  function setupStaticPageSearchButton(button, svg, handler) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.innerHTML = svg;
    button.addEventListener("click", handler);
  }

  function updatePageSearchStaticText() {
    if (pageSearchTitleEl instanceof HTMLElement) {
      pageSearchTitleEl.textContent = text("pageSearchTitle", text("search", "Search"));
    }
    if (pageSearchInputEl instanceof HTMLInputElement) {
      pageSearchInputEl.placeholder = text("pageSearchPlaceholder", text("searchPlaceholder", "Search loaded diffs"));
    }
    updateStaticButtonLabel(btnPageSearchPrevEl, text("pageSearchPrevTooltip", "Previous match"));
    updateStaticButtonLabel(btnPageSearchNextEl, text("pageSearchNextTooltip", "Next match"));
    updateStaticButtonLabel(btnPageSearchCloseEl, text("pageSearchCloseTooltip", "Close search"));
  }

  function updateStaticButtonLabel(button, label) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function handlePageSearchInputKeydown(event, input) {
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
      if (!input.value.trim()) {
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
  }

  function syncPageSearchPanelVisibility() {
    if (pageSearchBarEl instanceof HTMLElement) pageSearchBarEl.hidden = !pageSearchOpen;
    document.body.classList.toggle("pageSearchOpen", pageSearchOpen);
  }

  function renderStaleBanner() {
    const banner = el("section", { className: "staleBanner" });
    const msg = el("div", {});
    msg.textContent =
      staleReason === "sources"
        ? text("staleSources", "Source settings changed. Reload to apply.")
        : staleReason === "association"
          ? text("staleAssociation", "Project associations changed. Reload to apply them to File AI Change History.")
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

  function normalizeSearchHistoryCandidates(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const queryInput = typeof item.queryInput === "string" ? item.queryInput.trim() : "";
      if (!queryInput) continue;
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, queryInput: queryInput.slice(0, 1000) });
      if (out.length >= MAX_PAGE_SEARCH_HISTORY_CANDIDATES) break;
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
    const cardNumber = getCardNumberOrFallback(card, index);
    cardEl.dataset.cardNumber = String(cardNumber);
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
    meta.appendChild(renderCardNumberBadge(cardNumber));
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
      const btn = el("button", { type: "button", className: "secondaryBtn loadMoreBtn" });
      btn.textContent = text("loadMore", "Load more");
      btn.disabled = loadingMore;
      btn.addEventListener("click", () => {
        if (loadingMore) return;
        vscode.postMessage({ type: "loadMore" });
      });
      wrap.appendChild(btn);
    } else if (model.noMore) {
      const done = el("div", { className: "noMore", "data-page-search-ignore": "true" });
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
    cancelPageSearchRefresh();
    cancelPageSearchResize();
    pageSearchOpen = false;
    pageSearchQuery = "";
    if (pageSearchInputEl instanceof HTMLInputElement) pageSearchInputEl.value = "";
    pageSearchShowingSuggestions = false;
    activePageSearchSuggestionIndex = -1;
    suppressNextPageSearchFocusSuggestions = false;
    pageSearchCaseSensitive = false;
    pageSearchErrorText = "";
    lastCommittedPageSearchHistory = null;
    persistPageSearchState();
    syncPageSearchPanelVisibility();
    clearPageSearchHighlights();
    pageSearchResults = [];
    activePageSearchResultIndex = -1;
    renderPageSearchResults();
    renderPageSearchSuggestions();
    updatePageSearchStatus();
  }

  function openPageSearch() {
    pageSearchOpen = true;
    syncPageSearchPanelVisibility();
    applyPageSearchPanelWidth();
    const input = pageSearchInputEl;
    if (input instanceof HTMLInputElement) {
      const selectedText = window.getSelection ? String(window.getSelection() || "").trim() : "";
      if (!input.value && selectedText && !/\s*\n\s*/u.test(selectedText)) {
        input.value = selectedText;
        pageSearchQuery = selectedText;
      }
      if (input.value) refreshPageSearchResults({ preserveIndex: true, reveal: false });
      else {
        renderPageSearchResults();
        updatePageSearchStatus();
      }
      suppressNextPageSearchFocusSuggestions = true;
      input.focus();
      input.select();
    }
  }

  function closePageSearch() {
    pageSearchOpen = false;
    syncPageSearchPanelVisibility();
    cancelPageSearchRefresh();
    cancelPageSearchResize();
    hidePageSearchSuggestions();
    suppressNextPageSearchFocusSuggestions = false;
    clearPageSearchHighlights();
    pageSearchCaseSensitive = false;
    pageSearchErrorText = "";
    lastCommittedPageSearchHistory = null;
    persistPageSearchState();
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function schedulePageSearchRefresh(options) {
    const query = pageSearchQuery.trim();
    if (!query) {
      cancelPageSearchRefresh();
      pageSearchErrorText = "";
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

  function flushPageSearchRefresh(options) {
    if (!pageSearchRefreshTimer) return false;
    window.clearTimeout(pageSearchRefreshTimer);
    pageSearchRefreshTimer = 0;
    refreshPageSearchResults(options);
    return true;
  }

  function cancelPageSearchRefresh() {
    if (!pageSearchRefreshTimer) return;
    window.clearTimeout(pageSearchRefreshTimer);
    pageSearchRefreshTimer = 0;
  }

  function refreshPageSearchResults(options) {
    const preserveIndex = !!(options && options.preserveIndex);
    const reveal = !options || options.reveal !== false;
    const previousAnchor =
      options && options.anchor ? options.anchor : preserveIndex ? captureActivePageSearchResultAnchor() : null;
    const previousIndex = preserveIndex ? activePageSearchResultIndex : -1;
    const input = document.getElementById("pageSearchInput");
    if (input instanceof HTMLInputElement) pageSearchQuery = input.value.trim();
    const query = pageSearchQuery.trim();
    if (!options || !options.keepSuggestions) hidePageSearchSuggestions();
    pageSearchErrorText = "";
    clearPageSearchHighlights();
    if (!query) {
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }

    const compiled = compilePageSearchQuery(query, pageSearchCaseSensitive);
    if (!compiled) {
      pageSearchErrorText = getPageSearchInvalidMessage(query);
      renderPageSearchResults();
      updatePageSearchStatus();
      return;
    }
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

    const occurrenceCountsByCardId = new Map();
    for (const textNode of textNodes) {
      const sourceText = textNode.textContent || "";
      const matches = compiled.findAll(sourceText);
      if (matches.length === 0) continue;

      const fragment = document.createDocumentFragment();
      const pendingMarks = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.start > cursor) fragment.appendChild(document.createTextNode(sourceText.slice(cursor, match.start)));
        const mark = document.createElement("mark");
        mark.className = "pageSearchMatch";
        mark.textContent = sourceText.slice(match.start, match.start + match.length);
        fragment.appendChild(mark);
        pendingMarks.push({ mark, start: match.start, length: match.length });
        pageSearchMatches.push(mark);
        cursor = match.start + match.length;
      }
      if (cursor < sourceText.length) fragment.appendChild(document.createTextNode(sourceText.slice(cursor)));
      textNode.parentNode.replaceChild(fragment, textNode);

      for (const pending of pendingMarks) {
        pageSearchResults.push(
          buildPageSearchResult(pending.mark, sourceText, pending.start, pending.length, occurrenceCountsByCardId),
        );
      }
    }

    renderPageSearchResults();
    if (pageSearchResults.length === 0) {
      updatePageSearchStatus();
      return;
    }

    const nextIndex = resolvePageSearchActiveIndex(previousAnchor, previousIndex, preserveIndex);
    activatePageSearchResult(nextIndex, { reveal });
  }

  function shouldAcceptPageSearchTextNode(node) {
    if (!(node instanceof Text)) return false;
    const value = node.textContent || "";
    if (!value.trim()) return false;
    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement)) return false;
    if (parent.closest("#pageSearchBar, .dateGuide")) return false;
    if (parent.closest("[data-page-search-ignore='true']")) return false;
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

  function buildPageSearchResult(mark, sourceText, start, length, occurrenceCountsByCardId) {
    const card = mark.closest(".diffCard");
    const title = getElementText(card && card.querySelector(".cardTitleBlock h2")) || text("pageSearchTitle", "Find");
    const meta = getElementText(card && card.querySelector(".diffDetailsPath")) || "";
    const cardId = card instanceof HTMLElement ? card.id || "" : "";
    const cardNumber = card instanceof HTMLElement ? normalizePositiveInteger(card.dataset.cardNumber) : 0;
    const lineBadge = getDiffLineSearchResultBadge(mark);
    const matchText = mark.textContent || sourceText.slice(start, start + length);
    return {
      mark,
      cardId,
      cardNumber,
      side: lineBadge && lineBadge.side ? lineBadge.side : "",
      lineNumber: lineBadge && lineBadge.lineNumber ? lineBadge.lineNumber : "",
      matchText,
      occurrenceIndex: getNextPageSearchOccurrenceIndex(cardId, occurrenceCountsByCardId),
      title,
      meta,
      badges: buildSearchResultBadges(cardNumber, lineBadge),
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

  function buildSearchResultBadges(cardNumber, lineBadge) {
    const badges = [];
    if (cardNumber > 0) badges.push({ text: formatCardNumber(cardNumber), kind: "card" });
    if (lineBadge) badges.push(lineBadge);
    return badges;
  }

  function getDiffLineSearchResultBadge(mark) {
    const patchText = mark.closest(".patchDiffText");
    if (patchText instanceof HTMLElement && patchText.dataset.rowIndex) {
      const block = patchText.closest(".patchDiffBlock");
      const lineNo = block && block.querySelector(`.patchDiffLineNo[data-row-index="${patchText.dataset.rowIndex}"]`);
      const value = getElementText(lineNo);
      if (value) {
        const side = block instanceof HTMLElement && block.classList.contains("patchDiffBlock-left") ? "before" : "after";
        const sideLabel = side === "before" ? text("patchBefore", "Before") : text("patchAfter", "After");
        const fullLabel = `${sideLabel} L${value}`;
        return { text: fullLabel, compactText: `L${value}`, ariaLabel: fullLabel, kind: "line", side, lineNumber: value };
      }
    }
    return null;
  }

  function getNextPageSearchOccurrenceIndex(cardId, occurrenceCountsByCardId) {
    if (!cardId || !(occurrenceCountsByCardId instanceof Map)) return 0;
    const count = normalizeNonNegativeInteger(occurrenceCountsByCardId.get(cardId));
    occurrenceCountsByCardId.set(cardId, count + 1);
    return count;
  }

  function captureActivePageSearchResultAnchor() {
    const result = pageSearchResults[activePageSearchResultIndex];
    if (!result) return null;
    return {
      cardId: typeof result.cardId === "string" ? result.cardId : "",
      cardNumber: normalizePositiveInteger(result.cardNumber),
      side: typeof result.side === "string" ? result.side : "",
      lineNumber: typeof result.lineNumber === "string" ? result.lineNumber : "",
      matchText: typeof result.matchText === "string" ? result.matchText : "",
      occurrenceIndex: normalizeNonNegativeInteger(result.occurrenceIndex),
    };
  }

  function resolvePageSearchActiveIndex(anchor, previousIndex, preserveIndex) {
    if (!Array.isArray(pageSearchResults) || pageSearchResults.length === 0) return -1;
    if (anchor) {
      const exact = findExactPageSearchAnchorIndex(anchor);
      if (exact >= 0) return exact;
      const near = findNearestPageSearchAnchorIndex(anchor, previousIndex);
      if (near >= 0) return near;
    }
    if (preserveIndex && previousIndex >= 0) return Math.min(previousIndex, pageSearchResults.length - 1);
    return 0;
  }

  function findExactPageSearchAnchorIndex(anchor) {
    for (let index = 0; index < pageSearchResults.length; index += 1) {
      const result = pageSearchResults[index];
      if (!isSamePageSearchAnchorResult(result, anchor)) continue;
      return index;
    }
    return -1;
  }

  function isSamePageSearchAnchorResult(result, anchor) {
    if (!result || !anchor) return false;
    const sameCard =
      (anchor.cardId && result.cardId === anchor.cardId) ||
      (anchor.cardNumber > 0 && normalizePositiveInteger(result.cardNumber) === anchor.cardNumber);
    if (!sameCard) return false;
    if (anchor.side && result.side !== anchor.side) return false;
    if (anchor.lineNumber && result.lineNumber !== anchor.lineNumber) return false;
    if (anchor.matchText && result.matchText !== anchor.matchText) return false;
    return normalizeNonNegativeInteger(result.occurrenceIndex) === anchor.occurrenceIndex;
  }

  function findNearestPageSearchAnchorIndex(anchor, previousIndex) {
    let bestIndex = -1;
    let bestScore = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < pageSearchResults.length; index += 1) {
      const score = scorePageSearchAnchorCandidate(pageSearchResults[index], anchor, index, previousIndex);
      if (score >= bestScore) continue;
      bestScore = score;
      bestIndex = index;
    }
    return bestIndex;
  }

  function scorePageSearchAnchorCandidate(result, anchor, index, previousIndex) {
    if (!result || !anchor) return Number.MAX_SAFE_INTEGER;
    let score = 0;
    const resultCardNumber = normalizePositiveInteger(result.cardNumber);
    if (anchor.cardId && result.cardId === anchor.cardId) score -= 1000000;
    else if (anchor.cardNumber > 0 && resultCardNumber === anchor.cardNumber) score -= 500000;
    else if (anchor.cardNumber > 0 && resultCardNumber > 0) score += Math.abs(resultCardNumber - anchor.cardNumber) * 1000;
    else if (Number.isInteger(previousIndex) && previousIndex >= 0) score += Math.abs(index - previousIndex) * 1000;

    if (anchor.side) score += result.side === anchor.side ? -5000 : 5000;
    if (anchor.lineNumber) score += result.lineNumber === anchor.lineNumber ? -3000 : 3000;
    if (anchor.matchText) score += result.matchText === anchor.matchText ? -2000 : 2000;
    score += Math.abs(normalizeNonNegativeInteger(result.occurrenceIndex) - anchor.occurrenceIndex) * 10;
    if (Number.isInteger(previousIndex) && previousIndex >= 0) score += Math.abs(index - previousIndex);
    return score;
  }

  function renderPageSearchResults() {
    const resultsEl = document.getElementById("pageSearchResults");
    if (!(resultsEl instanceof HTMLElement)) return;
    resultsEl.textContent = "";

    const query = pageSearchQuery.trim();
    if (!query && pageSearchResults.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = text("pageSearchTypeToSearch", text("searchPlaceholder", "Search loaded diffs"));
      resultsEl.appendChild(empty);
      return;
    }

    if (pageSearchErrorText) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = pageSearchErrorText;
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
        commitCurrentPageSearchQuery();
        activatePageSearchResult(index, { reveal: true });
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocusedPageSearchResult(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          commitCurrentPageSearchQuery();
          activatePageSearchResult(index, { reveal: true });
        }
      });

      const header = el("div", { className: "pageSearchResultHeader" });
      const badges = Array.isArray(result.badges) ? result.badges : [];
      for (const badge of badges) {
        if (!badge || !badge.text) continue;
        const badgeKind = badge.kind === "card" ? "card" : "line";
        const sideClass = badgeKind === "line" && badge.side ? ` pageSearchResultLine-${badge.side}` : "";
        const lineBadge = el("span", { className: `pageSearchResultLine pageSearchResultLine-${badgeKind}${sideClass}` });
        if (badge.ariaLabel) {
          lineBadge.title = badge.ariaLabel;
          lineBadge.setAttribute("aria-label", badge.ariaLabel);
        }
        if (badgeKind === "line" && badge.compactText) {
          lineBadge.appendChild(el("span", { className: "pageSearchResultLineFull", textContent: badge.text }));
          lineBadge.appendChild(el("span", { className: "pageSearchResultLineCompact", textContent: badge.compactText }));
        } else {
          lineBadge.textContent = badge.text;
        }
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

  function renderPageSearchSuggestions() {
    const suggestionsEl = document.getElementById("pageSearchSuggestions");
    if (!(suggestionsEl instanceof HTMLElement)) return;
    suggestionsEl.textContent = "";
    if (!pageSearchShowingSuggestions) {
      suggestionsEl.hidden = true;
      return;
    }

    const suggestions = getVisiblePageSearchSuggestions();
    suggestionsEl.hidden = false;
    if (suggestions.length === 0) {
      const empty = el("div", { className: "pageSearchEmpty" });
      empty.textContent = text("pageSearchNoHistory", "No recent searches");
      suggestionsEl.appendChild(empty);
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
      const removeLabel = text("pageSearchRemoveHistory", "Remove from history");
      remove.title = removeLabel;
      remove.setAttribute("aria-label", removeLabel);
      remove.innerHTML = TRASH_ICON_SVG;
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePageSearchHistoryCandidate(entry);
      });
      item.appendChild(remove);
      suggestionsEl.appendChild(item);
    });
  }

  function showPageSearchSuggestions() {
    const input = document.getElementById("pageSearchInput");
    if (!(input instanceof HTMLInputElement) || !pageSearchOpen) return;
    const suggestions = getVisiblePageSearchSuggestions();
    const query = input.value.trim();
    pageSearchShowingSuggestions = suggestions.length > 0 || !query;
    activePageSearchSuggestionIndex = pageSearchShowingSuggestions ? 0 : -1;
    renderPageSearchSuggestions();
  }

  function hidePageSearchSuggestions() {
    pageSearchShowingSuggestions = false;
    activePageSearchSuggestionIndex = -1;
    renderPageSearchSuggestions();
  }

  function updatePageSearchSuggestionsAfterInput(input) {
    const suggestions = getVisiblePageSearchSuggestions();
    const query = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (query && suggestions.length === 0) {
      hidePageSearchSuggestions();
      return;
    }
    activePageSearchSuggestionIndex = suggestions.length > 0 ? 0 : -1;
    renderPageSearchSuggestions();
  }

  function isPageSearchSuggestionInteractionTarget(target) {
    if (!(target instanceof Element)) return false;
    const input = document.getElementById("pageSearchInput");
    const suggestionsEl = document.getElementById("pageSearchSuggestions");
    if (input instanceof HTMLElement && input.contains(target)) return true;
    if (suggestionsEl instanceof HTMLElement && suggestionsEl.contains(target)) return true;
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
    const input = document.getElementById("pageSearchInput");
    if (!(input instanceof HTMLInputElement)) return false;
    const safeIndex = Math.max(0, Math.min(index, suggestions.length - 1));
    const entry = suggestions[safeIndex];
    if (!entry) return false;
    input.value = String(entry.queryInput || "");
    pageSearchQuery = input.value;
    persistPageSearchState();
    hidePageSearchSuggestions();
    refreshPageSearchResults({ preserveIndex: false, reveal: false });
    commitCurrentPageSearchQuery();
    suppressNextPageSearchFocusSuggestions = true;
    input.focus();
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

  function getVisiblePageSearchSuggestions() {
    const input = document.getElementById("pageSearchInput");
    const normalized = input instanceof HTMLInputElement ? input.value.trim().toLowerCase() : "";
    const entries = Array.isArray(pageSearchHistoryCandidates) ? pageSearchHistoryCandidates : [];
    if (!normalized) return entries;
    return entries.filter((entry) => String(entry.queryInput || "").toLowerCase().includes(normalized));
  }

  function clearPageSearchForEmptyInput() {
    pageSearchQuery = "";
    pageSearchErrorText = "";
    clearPageSearchHighlights();
    renderPageSearchResults();
    updatePageSearchStatus();
  }

  function commitCurrentPageSearchQuery() {
    const input = document.getElementById("pageSearchInput");
    const queryInput = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!queryInput) return;
    if (!compilePageSearchQuery(queryInput, pageSearchCaseSensitive)) return;
    if (
      lastCommittedPageSearchHistory &&
      lastCommittedPageSearchHistory.queryInput === queryInput &&
      hasPageSearchHistoryCandidate(queryInput)
    ) {
      return;
    }
    lastCommittedPageSearchHistory = { queryInput };
    vscode.postMessage({ type: "savePageSearchHistory", queryInput });
  }

  function hasPageSearchHistoryCandidate(queryInput) {
    const query = String(queryInput || "").trim();
    if (!query) return false;
    return pageSearchHistoryCandidates.some((entry) => {
      if (!entry) return false;
      const candidate = String(entry.queryInput || "").trim();
      return candidate === query;
    });
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

  function compilePageSearchQuery(rawInput, caseSensitive) {
    const core = getPageSearchCore();
    return core ? core.compileQuery(rawInput, caseSensitive === true) : null;
  }

  function getPageSearchInvalidMessage(rawInput) {
    const core = getPageSearchCore();
    if (core && core.getInvalidKind(rawInput) === "regex") return text("pageSearchInvalidRegex", "Invalid regular expression");
    return text("pageSearchInvalidQuery", "Invalid search query");
  }

  function getPageSearchCore() {
    const core = window.CHV_PAGE_SEARCH;
    return core && typeof core.compileQuery === "function" && typeof core.getInvalidKind === "function" ? core : null;
  }

  function navigatePageSearchResults(delta) {
    if (!pageSearchOpen) {
      openPageSearch();
      return;
    }
    commitCurrentPageSearchQuery();
    if (!flushPageSearchRefresh({ preserveIndex: true, reveal: false })) {
      refreshPageSearchResults({ preserveIndex: true, reveal: false });
    }
    if (pageSearchResults.length === 0) return;
    const current = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    const next = Math.max(0, Math.min(pageSearchResults.length - 1, current + delta));
    if (next === current) return;
    activatePageSearchResult(next, { reveal: true });
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
    const result = pageSearchResults[safeIndex];
    if (result && result.mark) result.mark.classList.add("pageSearchMatch-active");
    renderPageSearchResults();
    scrollActivePageSearchResultIntoList();
    if (options.focusResult === true) focusPageSearchResultItem(safeIndex);
    updatePageSearchStatus();
    if (reveal && result && result.mark) {
      result.mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
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
    const resultsEl = document.getElementById("pageSearchResults");
    if (!(resultsEl instanceof HTMLElement)) return;
    const item = resultsEl.querySelector(`[data-search-index="${String(index)}"]`);
    if (item instanceof HTMLElement) item.focus({ preventScroll: true });
  }

  function scrollActivePageSearchResultIntoList() {
    const resultsEl = document.getElementById("pageSearchResults");
    if (!(resultsEl instanceof HTMLElement)) return;
    const active = resultsEl.querySelector(".pageSearchResult-active");
    if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function updatePageSearchStatus() {
    const countEl = document.getElementById("pageSearchCount");
    if (!(countEl instanceof HTMLElement)) return;
    const total = pageSearchResults.length;
    const prev = document.getElementById("btnPageSearchPrev");
    const next = document.getElementById("btnPageSearchNext");
    const currentIndex = activePageSearchResultIndex >= 0 ? activePageSearchResultIndex : 0;
    if (prev instanceof HTMLButtonElement) prev.disabled = total <= 1 || currentIndex <= 0;
    if (next instanceof HTMLButtonElement) next.disabled = total <= 1 || currentIndex >= total - 1;
    if (total === 0) {
      countEl.textContent = "0/0";
      return;
    }
    const current = currentIndex + 1;
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

  function restoreScrollAnchor(anchor, fallbackScrollTop, onRestored, debugScope) {
    requestAnimationFrame(() => {
      const method = restoreCardAnchor(anchor);
      if (!method) {
        const fallback = Number.isFinite(Number(anchor && anchor.scrollTop)) ? anchor.scrollTop : fallbackScrollTop;
        getScrollRoot().scrollTo(0, Math.max(0, Number(fallback || 0)));
      }
      debugWebview(debugScope || "scrollAnchor", "restored", { method: method || "scrollTop" });
      updateDateGuideCurrent();
      if (typeof onRestored === "function") onRestored();
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

  function getCardNumberOrFallback(card, fallbackIndex) {
    const mixedNumber = getMixedTimelineCardNumber(card);
    if (mixedNumber > 0) return mixedNumber;
    return normalizePositiveInteger(Number(fallbackIndex) + 1);
  }

  function getMixedTimelineCardNumber(card) {
    const index = card ? getModelCardIndexById(card.id) : -1;
    return index >= 0 ? index + 1 : 0;
  }

  function rebuildModelCardIndex() {
    const nextIndexById = new Map();
    const nextCardById = new Map();
    const cards = model && Array.isArray(model.cards) ? model.cards : [];
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const id = card && typeof card.id === "string" ? card.id : "";
      if (!id) continue;
      nextIndexById.set(id, index);
      nextCardById.set(id, card);
    }
    modelCardIndexById = nextIndexById;
    modelCardById = nextCardById;
  }

  function getModelCardIndexById(cardId) {
    const id = typeof cardId === "string" ? cardId : "";
    if (!id) return -1;
    const index = modelCardIndexById.get(id);
    return Number.isInteger(index) && index >= 0 ? index : -1;
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
    const anchor = captureVisibleCardAnchor();
    const anchorCard = findModelCardById(anchor && anchor.cardId);
    sourceFilter = next;
    persistSourceFilter();
    const visibleCards = getVisibleCards(model && Array.isArray(model.cards) ? model.cards : []);
    const restoreAnchor = resolveSourceFilterScrollAnchor(anchor, anchorCard, visibleCards);
    render();
    restoreScrollAnchor(restoreAnchor, anchor ? anchor.scrollTop : 0, persistRestoreState, "sourceFilterAnchor");
  }

  function resolveSourceFilterScrollAnchor(anchor, anchorCard, visibleCards) {
    const base = anchor && typeof anchor === "object" ? anchor : { scrollTop: 0 };
    const cards = Array.isArray(visibleCards) ? visibleCards : [];
    if (cards.length === 0) return base;
    if (anchorCard && isSourceVisible(anchorCard.source)) return base;

    const fallback = findNearestVisibleCard(anchorCard, cards, base.cardIndex);
    if (!fallback) return base;
    return {
      ...base,
      cardId: fallback.card.id || "",
      cardIndex: fallback.index,
    };
  }

  function findNearestVisibleCard(anchorCard, visibleCards, fallbackIndex) {
    const cards = Array.isArray(visibleCards) ? visibleCards : [];
    if (cards.length === 0) return null;
    const anchorTime = anchorCard ? parseTimestampMs(anchorCard.timestampIso) : NaN;
    const anchorModelIndex = anchorCard ? getModelCardIndexById(anchorCard.id) : -1;
    const canUseTimeDistance =
      Number.isFinite(anchorTime) && cards.some((card) => Number.isFinite(parseTimestampMs(card && card.timestampIso)));
    const safeFallbackIndex = Number.isInteger(Number(fallbackIndex))
      ? Math.max(0, Math.min(cards.length - 1, Math.floor(Number(fallbackIndex))))
      : 0;
    let best = null;

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const cardTime = parseTimestampMs(card && card.timestampIso);
      const timeDistance = canUseTimeDistance
        ? Number.isFinite(cardTime)
          ? Math.abs(cardTime - anchorTime)
          : Number.MAX_SAFE_INTEGER
        : 0;
      const modelIndex = getModelCardIndexById(card && card.id);
      const modelDistance =
        anchorModelIndex >= 0 && modelIndex >= 0 ? Math.abs(modelIndex - anchorModelIndex) : Math.abs(index - safeFallbackIndex);
      const fallbackDistance = Math.abs(index - safeFallbackIndex);
      const candidate = { card, index, timeDistance, modelDistance, fallbackDistance };
      if (
        !best ||
        candidate.timeDistance < best.timeDistance ||
        (candidate.timeDistance === best.timeDistance && candidate.modelDistance < best.modelDistance) ||
        (candidate.timeDistance === best.timeDistance &&
          candidate.modelDistance === best.modelDistance &&
          candidate.fallbackDistance < best.fallbackDistance)
      ) {
        best = candidate;
      }
    }

    return best ? { card: best.card, index: best.index } : null;
  }

  function findModelCardById(cardId) {
    const id = typeof cardId === "string" ? cardId : "";
    if (!id) return null;
    return modelCardById.get(id) || null;
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

  function getVisibleAddedCount(message) {
    const count = Number(message && message.addedCount);
    if (!Number.isFinite(count) || count <= 0) return 0;
    const totalCount = Math.floor(count);
    const sourceCounts = message && message.addedSourceCounts;
    if (!sourceCounts || typeof sourceCounts !== "object") return totalCount;
    const codexCount = normalizePositiveInteger(sourceCounts.codex);
    const claudeCount = normalizePositiveInteger(sourceCounts.claude);
    let visibleCount = 0;
    if (isSourceVisible("codex")) visibleCount += codexCount;
    if (isSourceVisible("claude")) visibleCount += claudeCount;
    return Math.min(totalCount, visibleCount);
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

  function persistPageSearchState() {
    webviewState = { ...webviewState, pageSearchCaseSensitive };
    if (typeof vscode.setState === "function") vscode.setState(webviewState);
  }

  function persistRestoreState() {
    if (typeof vscode.setState !== "function") return;
    if (!model || !model.target || typeof model.target !== "object") return;
    const cards = Array.isArray(model.cards) ? model.cards : [];
    webviewState = {
      ...webviewState,
      restore: {
        version: 1,
        target: model.target,
        cardCount: cards.length,
        scrollAnchor: captureVisibleCardAnchor(),
      },
    };
    vscode.setState(webviewState);
  }

  function handleScrollRootScroll() {
    schedulePersistRestorePosition();
    if (timeGuideEnabled && dateGuide) dateGuide.handleScroll();
  }

  function schedulePersistRestorePosition() {
    if (restorePositionSaveTimer) window.clearTimeout(restorePositionSaveTimer);
    restorePositionSaveTimer = window.setTimeout(() => {
      restorePositionSaveTimer = 0;
      persistRestoreState();
    }, RESTORE_POSITION_SAVE_DEBOUNCE_MS);
  }

  function persistRestorePosition(options) {
    if (restorePositionSaveTimer && options && options.immediate) {
      window.clearTimeout(restorePositionSaveTimer);
      restorePositionSaveTimer = 0;
    }
    persistRestoreState();
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
      mode: "date",
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
        const cardNumber = getCardNumberOrFallback(card, index);
        return {
          actualTimestampMs,
          key: card.id,
          itemIndex: index,
          ordinal: cardNumber,
          ordinalLabel: formatCardNumber(cardNumber),
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
    const resolvedItems = items.filter((item) => Number.isFinite(item.timestampMs));
    reindexDateGuideItems(resolvedItems);
    return resolvedItems;
  }

  function reindexDateGuideItems(items) {
    if (!Array.isArray(items)) return;
    for (let index = 0; index < items.length; index += 1) {
      items[index].itemIndex = index;
    }
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
      const nextWidth = normalizePageSearchPanelWidth(
        pageSearchResizeState.startWidth + (pageSearchResizeState.startX - event.clientX),
      );
      if (nextWidth == null) return;
      pageSearchPanelWidth = nextWidth;
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
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const availableWidth = Math.max(1, window.innerWidth - PAGE_SEARCH_HORIZONTAL_MARGIN);
    const minimumWidth = Math.min(MIN_PAGE_SEARCH_WIDTH, availableWidth);
    return Math.max(minimumWidth, Math.min(Math.round(numeric), availableWidth));
  }

  function applyPageSearchPanelWidth() {
    const bar = document.getElementById("pageSearchBar");
    if (!(bar instanceof HTMLElement)) return;
    const preferredWidth = Number(pageSearchPanelWidth);
    if (!Number.isFinite(preferredWidth) || preferredWidth <= 0) {
      bar.style.removeProperty("--chv-page-search-width");
      return;
    }
    bar.style.setProperty("--chv-page-search-width", `${Math.max(MIN_PAGE_SEARCH_WIDTH, Math.round(preferredWidth))}px`);
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

  function restoreScroll(scrollTop, onRestored) {
    requestAnimationFrame(() => {
      getScrollRoot().scrollTo(0, Math.max(0, Number(scrollTop || 0)));
      updateDateGuideCurrent();
      if (typeof onRestored === "function") onRestored();
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

  function renderCardNumberBadge(cardNumber) {
    const safeNumber = normalizePositiveInteger(cardNumber);
    const label = formatTemplate(text("cardNumberLabel", "Card {0}"), safeNumber);
    const badge = el("span", { className: "cardNumberBadge", textContent: formatCardNumber(safeNumber) });
    badge.dataset.pageSearchIgnore = "true";
    badge.title = label;
    badge.setAttribute("aria-label", label);
    return badge;
  }

  function formatCardNumber(cardNumber) {
    const safeNumber = normalizePositiveInteger(cardNumber);
    return safeNumber > 0 ? `#${safeNumber}` : "";
  }

  function normalizePositiveInteger(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
  }

  function normalizeNonNegativeInteger(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
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

  initializePageSearchPanel();

  vscode.postMessage({
    type: "ready",
    cardCount:
      webviewState && webviewState.restore && Number.isFinite(Number(webviewState.restore.cardCount))
        ? Number(webviewState.restore.cardCount)
        : undefined,
  });
})();
