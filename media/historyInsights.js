// History Insights webview script.
(function () {
  if (typeof module === "object" && module && module.exports) {
    module.exports = {
      calculateIsoWeekLayout,
      calculateBreakdownShare,
      formatBreakdownPercentage,
      compareFilesByMode,
      calculateBreakdownColumnWidths,
      nextPreservedScrollTop,
      normalizePanelExpansion,
      normalizeDateRangeInput,
      normalizeFileSort,
      normalizeActivityMetric,
      composeFileRowColumns,
      calculateListboxPosition,
      shouldUseCompactHeader,
      calculateFiniteSelectionState,
      nextFilterIdsAfterRemoval,
      calculateArchiveSelectionTransition,
      hasFilterConditionChanges,
      resolveFilterApplyAction,
      shouldUseRefreshToast,
      resolveMetricPresentation,
      normalizeBreakdownMetric,
      selectBreakdownRows,
      resolveExpandedModelIds,
      nextExpandedModelIds,
      calculateScrollAnchorDelta,
      isMetricPayload,
      isQualityPayload,
      isBreakdownGroup,
      isModelBreakdownRow,
      normalizeUiLanguage,
    };
    return;
  }
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let i18n = {};
  let extensionIcon = "";
  let model = null;
  let stateView = null;
  let filters = null;
  let refreshProgress = null;
  const restored = typeof vscode.getState === "function" ? vscode.getState() || {} : {};
  let activityMetric = normalizeActivityMetric(restored.activityMetric);
  let breakdownMetric = normalizeBreakdownMetric(restored.breakdownMetric);
  let toolMetric = restored.toolMetric === "sessions" ? "sessions" : "calls";
  let activeSessionMetric = ["userRequests", "toolCalls", "reasoningTokens", "totalTokens", "changedLines"].includes(restored.activeSessionMetric)
    ? restored.activeSessionMetric
    : "userRequests";
  let fileSort = normalizeFileSort(restored.fileSort);
  let selectedFileId = sanitizeEntityId(restored.selectedFileId);
  let panelExpansion = normalizePanelExpansion(restored.panelExpansion);
  let expandedModelIds = initialExpandedModelIds(restored.expandedModelIds, restored.expandedModelId);
  let snapshotId = typeof restored.snapshotId === "string" ? restored.snapshotId : "";
  let preservedScrollTop = nextPreservedScrollTop(0, restored.scrollTop, true);
  let heatmapScrollLeft = nextPreservedScrollTop(0, restored.heatmapScrollLeft, true);
  let fileListScrollTop = 0;
  let activeFilterDropdown = null;
  let activeActivityDropdown = null;
  let activeBreakdownMetricDropdown = null;
  let filterOverlay = null;
  let filterDraft = null;
  let filterApplying = false;
  let applyToHistoryPreference = restored.applyToHistoryPreference === true;
  let applyToHistoryPreferenceRevision = 0;
  let applyToHistoryControl = null;
  let archiveSelectionBeforeClaude = null;
  let refreshRequested = false;
  let refreshToastTimer = null;
  let refreshToastMessage = "";
  const filterControlSyncers = new Map();
  let headerResizeObserver = null;

  window.addEventListener("message", (event) => {
    const message = event.data && typeof event.data === "object" ? event.data : {};
    if (message.i18n && typeof message.i18n === "object") i18n = message.i18n;
    if (typeof message.language === "string") document.documentElement.lang = normalizeUiLanguage(message.language);
    if (typeof message.extensionIcon === "string") extensionIcon = message.extensionIcon;
    if (message.filters) filters = normalizeFilters(message.filters);
    if (message.type === "i18n") {
      if (model) renderModel();
      else if (stateView) renderState(...stateView);
      return;
    }
    if (message.type === "bootstrap") {
      closeFilterOverlay(false);
      refreshRequested = false;
      clearRefreshToast();
      if (typeof message.snapshotId === "string") snapshotId = message.snapshotId;
      if (typeof message.applyToHistoryPreference === "boolean") {
        applyToHistoryPreference = message.applyToHistoryPreference;
      }
      persistState();
      renderState("preparing", "progress.loadCache", true);
      return;
    }
    if (message.type === "progress") {
      const progress = normalizeProgress(message.progress);
      if (shouldUseRefreshToast(Boolean(model), refreshRequested, model?.refreshing === true)) {
        refreshProgress = progress;
        updateRefreshToast();
        return;
      }
      renderState("preparing", `progress.${progress.phase}`, progress.cancellable, progress);
      return;
    }
    if (message.type === "model") {
      const next = normalizeModel(message.model);
      if (!next) {
        renderState("error", "", false, null, true);
        return;
      }
      model = next;
      expandedModelIds = resolveExpandedModelIds(expandedModelIds, model.models.rows);
      if (!model.files.some((file) => file.id === selectedFileId)) selectedFileId = "";
      refreshProgress = null;
      if (model.refreshing) {
        refreshRequested = true;
        updateRefreshToast();
      } else {
        refreshRequested = false;
        clearRefreshToast();
      }
      renderModel();
      return;
    }
    if (message.type === "applyToHistoryPreference" || message.type === "applyToHistoryPreferenceError") {
      const revision = Number(message.revision);
      if (!Number.isSafeInteger(revision) || revision < applyToHistoryPreferenceRevision) return;
      if (typeof message.enabled !== "boolean") return;
      applyToHistoryPreferenceRevision = revision;
      applyToHistoryPreference = message.enabled;
      persistState();
      syncApplyToHistoryControl();
      if (message.type === "applyToHistoryPreferenceError") showFilterApplyError("filterPreferenceError");
      return;
    }
    if (message.type === "filterApplyError") {
      filterApplying = false;
      if (message.reason === "stale") {
        closeFilterOverlay(false);
      } else {
        showFilterApplyError("filterApplyError");
      }
      return;
    }
    if (message.type === "cancelled") {
      if (shouldUseRefreshToast(Boolean(model), refreshRequested, model?.refreshing === true)) {
        model = { ...model, refreshing: false };
        refreshRequested = false;
        refreshProgress = null;
        clearRefreshToast();
        renderModel();
        return;
      }
      renderState("cancelled", "", false, null, false, true);
      return;
    }
    if (message.type === "staleContext") {
      renderState("staleContext", "", false, null, false, false, true);
      return;
    }
    if (message.type === "error") {
      if (shouldUseRefreshToast(Boolean(model), refreshRequested, model?.refreshing === true)) {
        model = { ...model, refreshing: false, stale: true };
        refreshRequested = false;
        refreshProgress = null;
        clearRefreshToast();
        renderModel();
        return;
      }
      renderState("error", "", false, null, true);
    }
  });

  function renderState(messageKey, detailKey, cancellable, progress, isError, isCancelled, isStale) {
    captureScrollPosition();
    model = null;
    stateView = [messageKey, detailKey, cancellable, progress, isError, isCancelled, isStale];
    refreshRequested = false;
    refreshProgress = null;
    clearRefreshToast();
    disconnectHeaderObserver();
    closeFilterOverlay(false);
    closeActivityMetricDropdown(false);
    closeBreakdownMetricDropdown(false);
    clear(app);
    const panel = el("section", { className: `statePanel${isError ? " errorPanel" : ""}`, role: "status" });
    panel.appendChild(titleRow());
    const message = el("p", { className: "stateMessage" });
    message.textContent = text(messageKey);
    panel.appendChild(message);
    if (detailKey) {
      const detail = el("p", { className: "muted" });
      detail.textContent = text(detailKey);
      panel.appendChild(detail);
    }
    if (progress && progress.total > 0) {
      const count = el("p", { className: "muted" });
      count.textContent = formatTemplate(text("progressCount"), progress.completed, progress.total);
      panel.appendChild(count);
    }
    const actions = el("div", { className: "stateActions" });
    if (cancellable) actions.appendChild(actionButton("cancel", () => vscode.postMessage({ type: "cancel" })));
    if (isError || isCancelled) actions.appendChild(actionButton("retry", () => vscode.postMessage({ type: "retry" }), true));
    if (isStale) actions.appendChild(actionButton("refreshCurrent", () => vscode.postMessage({ type: "refreshCurrent" }), true));
    if (isError || isCancelled || isStale) actions.appendChild(actionButton("backToHistory", () => vscode.postMessage({ type: "backToHistory" })));
    if (actions.childNodes.length > 0) panel.appendChild(actions);
    app.appendChild(panel);
  }

  function renderModel() {
    captureScrollPosition();
    stateView = null;
    disconnectHeaderObserver();
    closeFilterOverlay(false);
    closeActivityMetricDropdown(false);
    clear(app);
    if (!model) return;
    const header = el("header", { className: "insightsHeader" });
    const refreshCurrentButton = iconActionButton("refreshCurrent", "importHistory", () => {
      closeFilterOverlay(false);
      vscode.postMessage({ type: "refreshCurrent" });
    }, true);
    refreshCurrentButton.classList.add("headerPrimaryAction");
    refreshCurrentButton.title = text("refreshCurrentHint");
    refreshCurrentButton.setAttribute("aria-label", `${text("refreshCurrent")}. ${text("refreshCurrentHint")}`);
    refreshCurrentButton.disabled = model.refreshing;
    const summary = el("div", { className: "headerSummary" });
    const conditionSummary = buildConditionSummary(filters || normalizeFilters({}));
    const summaryText = `${conditionSummary} · ${text("lastUpdated")}: ${formatDateTime(model.generatedAtIso)}`;
    summary.textContent = summaryText;
    summary.title = summaryText;
    summary.setAttribute("aria-label", summaryText);
    const actions = el("div", { className: "headerActions" });
    const refreshButton = iconActionButton("refresh", "reload", () => {
      closeFilterOverlay(false);
      beginRefreshRequest();
      vscode.postMessage({ type: "refresh" });
    });
    refreshButton.title = text("refreshHint");
    refreshButton.setAttribute("aria-label", `${text("refresh")}. ${text("refreshHint")}`);
    refreshButton.disabled = model.refreshing;
    const filterButton = iconActionButton("filterOpen", "filter", () => toggleFilterOverlay(filterButton), false, true);
    filterButton.id = "insights-filter-button";
    filterButton.title = text("filterOpenHint");
    filterButton.setAttribute("aria-label", text("filterOpenHint"));
    filterButton.setAttribute("aria-haspopup", "dialog");
    filterButton.setAttribute("aria-expanded", "false");
    filterButton.setAttribute("aria-controls", "insights-filter-overlay");
    filterButton.disabled = model.refreshing;
    actions.append(refreshButton, filterButton);
    header.append(refreshCurrentButton, summary, actions);
    app.appendChild(header);
    installHeaderObserver(header);
    const shell = el("div", { className: "insightsShell" });
    if (model.stale) {
      const banner = el("div", { className: "refreshBanner stale", role: "status" });
      banner.textContent = text("showingPrevious");
      shell.appendChild(banner);
    }

    if (model.quality.targetSessions === 0) {
      const empty = el("section", { className: "emptyPanel" });
      const title = el("h2", {});
      title.textContent = text("emptyTitle");
      const hint = el("p", { className: "muted" });
      hint.textContent = text("emptyHint");
      empty.append(title, hint, actionButton("backToHistory", () => vscode.postMessage({ type: "backToHistory" })));
      shell.appendChild(empty);
      app.appendChild(shell);
      restoreScroll();
      return;
    }

    shell.appendChild(renderMetrics());
    shell.appendChild(renderActivity());
    shell.appendChild(renderFiles());
    shell.appendChild(renderTools());
    shell.appendChild(renderActiveSessions());
    shell.appendChild(renderUsageDetails());
    shell.appendChild(renderBreakdowns());
    shell.appendChild(renderQuality());
    app.appendChild(shell);
    restoreScroll();
  }

  function toggleFilterOverlay(trigger) {
    if (filterApplying) return;
    if (filterOverlay) {
      closeFilterOverlay(true);
      return;
    }
    if (!filters || model?.refreshing) return;
    closeActivityMetricDropdown(false);
    filterDraft = createFilterDraft(filters);
    filterApplying = false;
    archiveSelectionBeforeClaude = null;
    filterControlSyncers.clear();
    filterOverlay = renderFilterOverlay(trigger);
    app.appendChild(filterOverlay);
    trigger.setAttribute("aria-expanded", "true");
    syncFilterApplyState();
    requestAnimationFrame(() => filterOverlay?.querySelector(".filterCloseButton")?.focus({ preventScroll: true }));
  }

  function renderFilterOverlay(trigger) {
    const values = filters || normalizeFilters({});
    const section = el("section", { id: "insights-filter-overlay", className: "filterOverlay", role: "dialog", ariaLabel: text("filters") });
    const heading = el("div", { className: "filterOverlayHeading" });
    const title = el("h2", {});
    title.textContent = text("filters");
    const actions = el("div", { className: "filterOverlayActions" });
    const applyToHistory = el("button", { type: "button", className: "historyApplyToggle" });
    applyToHistory.dataset.baseDisabled = "false";
    applyToHistory.textContent = text("filterApplyToHistory");
    applyToHistoryControl = applyToHistory;
    applyToHistory.addEventListener("click", () => {
      if (!filterDraft || filterApplying) return;
      applyToHistoryPreference = !applyToHistoryPreference;
      applyToHistoryPreferenceRevision += 1;
      clearFilterApplyError();
      persistState();
      syncApplyToHistoryControl();
      syncFilterApplyState();
      vscode.postMessage({
        type: "setApplyToHistoryPreference",
        enabled: applyToHistoryPreference,
        revision: applyToHistoryPreferenceRevision,
      });
    });
    syncApplyToHistoryControl();
    const apply = actionButton("filterApply", () => applyFilterDraft(), true);
    apply.classList.add("filterApplyButton");
    const close = iconActionButton("filterClose", "close", () => {
      if (!filterApplying) closeFilterOverlay(true);
    }, false, true);
    close.classList.add("filterCloseButton");
    close.title = text("filterClose");
    close.setAttribute("aria-label", text("filterClose"));
    actions.append(applyToHistory, apply, close);
    heading.append(title, actions);
    const body = el("div", { className: "filterOverlayBody" });
    const error = el("div", { className: "filterApplyError", role: "alert" });
    error.hidden = true;
    const grid = el("div", { className: "filterGrid" });
    grid.append(
      renderFilterDropdown("source", "filterSource", values.options.source, values.canEditSource, true),
      renderDateRangeControl(),
      renderFilterDropdown("archiveLocation", "filterLocation", values.options.archiveLocation, values.canEditArchiveLocation, true),
      renderFilterDropdown("projects", "filterProject", values.options.projects, true, true),
      renderFilterDropdown("tags", "filterTags", values.options.tags, true, true),
    );
    body.append(error, grid);
    section.append(heading, body);
    body.addEventListener("scroll", () => closeActiveFilterDropdown(false), { passive: true });
    section.dataset.triggerId = trigger.id;
    syncFilterApplyState();
    return section;
  }

  function renderFilterDropdown(kind, labelKey, options, enabled, multiple) {
    const wrapper = el("div", { className: "filterControl" });
    const surface = el("div", { className: "filterControlSurface" });
    const finiteCheckSet = kind === "source" || kind === "archiveLocation";
    const button = el("button", { type: "button", className: "filterButton" });
    button.dataset.filterKind = kind;
    button.dataset.baseDisabled = String(!enabled);
    const name = el("span", { className: "filterLabel" });
    name.textContent = text(labelKey);
    const current = el("span", { className: "filterValue" });
    const chevron = el("span", { className: "filterChevron", ariaHidden: "true" });
    chevron.textContent = "⌄";
    button.append(name, current, chevron);
    const tokenList = el("div", { className: "filterTokenList", role: "group", ariaLabel: text(labelKey) });
    const selectionError = el("div", { className: "filterSelectionError", role: "alert" });
    selectionError.textContent = text("filterSelectionRequired");
    selectionError.hidden = true;
    surface.append(button, tokenList, selectionError);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    const menu = el("div", { id: `filter-menu-${kind}`, className: "filterDropdown", role: "dialog", ariaLabel: text(labelKey) });
    menu.hidden = true;
    button.setAttribute("aria-controls", menu.id);
    const selectedIds = new Set(getDraftIds(kind));
    let searchInput = null;
    if (kind === "projects") {
      const searchWrap = el("label", { className: "filterSearch" });
      const searchLabel = el("span", { className: "visuallyHidden" });
      searchLabel.textContent = text("filterSearchProject");
      searchInput = el("input", { type: "search", placeholder: text("filterSearchProject"), autocomplete: "off" });
      searchWrap.append(searchLabel, searchInput);
      menu.appendChild(searchWrap);
    }
    const list = el("div", { className: "filterOptionList", role: finiteCheckSet ? "group" : "listbox", ariaLabel: text(labelKey) });
    if (multiple && !finiteCheckSet) list.setAttribute("aria-multiselectable", "true");
    const optionButtons = [];
    const sectionHeadings = new Map();
    const syncOption = (optionButton, option) => {
      const selected = selectedIds.has(option.id);
      optionButton.setAttribute(finiteCheckSet ? "aria-checked" : "aria-selected", String(selected));
      optionButton.classList.toggle("selected", selected);
      const marker = optionButton.querySelector(".filterOptionMarker");
      if (marker) marker.textContent = selected ? "✓" : "";
    };
    let selectAllButton = null;
    let selectAllMarker = null;
    if (finiteCheckSet && options.length > 1) {
      selectAllButton = el("button", { type: "button", className: "filterOption filterSelectAllOption", role: "checkbox" });
      selectAllMarker = el("span", { className: "filterOptionMarker", ariaHidden: "true" });
      const selectAllLabel = el("span", { className: "filterOptionLabel" });
      selectAllLabel.textContent = text("filterSelectAll");
      selectAllButton.append(selectAllMarker, selectAllLabel);
      list.appendChild(selectAllButton);
    }
    options.forEach((option) => {
      if (kind === "projects" && option.kind !== "all" && option.section && !sectionHeadings.has(option.section)) {
        const sectionHeading = el("div", { className: "filterProjectSection", role: "presentation" });
        sectionHeading.textContent = text(`filterProjectSection${capitalize(option.section)}`);
        sectionHeadings.set(option.section, sectionHeading);
        list.appendChild(sectionHeading);
      }
      const optionButton = el("button", { type: "button", className: "filterOption", role: finiteCheckSet ? "checkbox" : "option" });
      optionButton.dataset.optionId = option.id;
      optionButton.dataset.searchLabel = `${option.label} ${option.searchText || ""}`.toLocaleLowerCase();
      optionButton.dataset.section = option.section || "";
      const marker = el("span", { className: "filterOptionMarker", ariaHidden: "true" });
      const optionLabel = el("span", { className: "filterOptionLabel" });
      optionLabel.textContent = option.label;
      const optionText = el("span", { className: "filterOptionText" });
      optionText.appendChild(optionLabel);
      if (option.description) {
        const optionDescription = el("span", { className: "filterOptionDescription" });
        optionDescription.textContent = option.description;
        optionText.appendChild(optionDescription);
      }
      optionButton.append(marker, optionText);
      if (option.current) {
        const currentBadge = el("span", { className: "filterCurrentBadge" });
        currentBadge.textContent = text("filterCurrentProject");
        optionButton.appendChild(currentBadge);
      }
      syncOption(optionButton, option);
      optionButton.addEventListener("click", () => {
        if (multiple) {
          if (kind === "projects") {
            const allOption = options.find((candidate) => candidate.kind === "all");
            if (option.kind === "all") {
              selectedIds.clear();
              selectedIds.add(option.id);
            } else {
              if (allOption) selectedIds.delete(allOption.id);
              if (selectedIds.has(option.id)) selectedIds.delete(option.id);
              else if (selectedIds.size < 32) selectedIds.add(option.id);
              if (selectedIds.size === 0 && allOption) selectedIds.add(allOption.id);
            }
          } else if (selectedIds.has(option.id)) {
            selectedIds.delete(option.id);
          } else {
            const maximum = kind === "tags" ? 12 : 2;
            if (selectedIds.size < maximum) selectedIds.add(option.id);
          }
          updateDraftSelection(kind, Array.from(selectedIds), options);
          return;
        }
        selectedIds.clear();
        selectedIds.add(option.id);
        setDraftIds(kind, [option.id]);
        syncAllFilterControls();
        closeActiveFilterDropdown(true);
      });
      optionButtons.push(optionButton);
      list.appendChild(optionButton);
    });
    if (selectAllButton) {
      selectAllButton.addEventListener("click", () => {
        const allSelected = options.length > 0 && options.every((option) => selectedIds.has(option.id));
        updateDraftSelection(kind, allSelected ? [] : options.map((option) => option.id), options);
      });
    }
    const noOptions = el("div", { className: "filterNoOptions muted", role: "status" });
    noOptions.textContent = text("filterNoOptions");
    noOptions.hidden = options.length > 0;
    menu.append(list, noOptions);
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim().toLocaleLowerCase();
        let visible = 0;
        optionButtons.forEach((optionButton) => {
          const matches = !query || optionButton.dataset.searchLabel.includes(query);
          optionButton.hidden = !matches;
          if (matches) visible += 1;
        });
        sectionHeadings.forEach((heading, section) => {
          heading.hidden = !optionButtons.some((optionButton) => optionButton.dataset.section === section && !optionButton.hidden);
        });
        noOptions.hidden = visible > 0;
      });
    }
    const openMenu = () => {
      if (activeFilterDropdown?.button === button) {
        closeActiveFilterDropdown(true);
        return;
      }
      closeActiveFilterDropdown(false);
      menu.hidden = false;
      wrapper.classList.add("open");
      button.setAttribute("aria-expanded", "true");
      activeFilterDropdown = { wrapper, button, menu };
      const target = searchInput || optionButtons.find((candidate) => candidate.getAttribute(finiteCheckSet ? "aria-checked" : "aria-selected") === "true") || selectAllButton || optionButtons[0];
      if (target) requestAnimationFrame(() => {
        positionFilterDropdown(button, menu);
        target.focus({ preventScroll: true });
        if (target !== searchInput) list.scrollTop = Math.max(0, target.offsetTop - (list.clientHeight / 2));
      });
    };
    const syncControl = () => {
      selectedIds.clear();
      getDraftIds(kind).forEach((id) => selectedIds.add(id));
      optionButtons.forEach((candidate, index) => syncOption(candidate, options[index]));
      if (selectAllButton && selectAllMarker) {
        const checked = calculateFiniteSelectionState(Array.from(selectedIds), options.map((option) => option.id));
        selectAllButton.setAttribute("aria-checked", checked);
        selectAllButton.classList.toggle("selected", checked === "true");
        selectAllButton.classList.toggle("mixed", checked === "mixed");
        selectAllMarker.textContent = checked === "true" ? "✓" : checked === "mixed" ? "−" : "";
      }
      current.textContent = filterDraftValue(kind, options, multiple);
      const selectedOptions = options.filter((option) => selectedIds.has(option.id));
      const fullSelection = kind === "archiveLocation" && isDraftClaudeSource()
        ? text("filterNotApplicable")
        : selectedOptions.length > 0
          ? selectedOptions.map((option) => option.label).join(", ")
          : kind === "tags"
            ? text("filterNoTagConstraint")
            : current.textContent;
      button.title = formatTemplate(text("filterEditHint"), text(labelKey), fullSelection);
      button.setAttribute("aria-label", button.title);
      const missingRequired = finiteCheckSet && !(kind === "archiveLocation" && isDraftClaudeSource()) && selectedOptions.length === 0;
      selectionError.hidden = !missingRequired;
      renderFilterTokens(kind, options, enabled, tokenList, openMenu);
    };
    menu.addEventListener("keydown", (event) => handleFilterMenuKeydown(event, [selectAllButton, ...optionButtons].filter(Boolean), button));
    button.addEventListener("click", openMenu);
    filterControlSyncers.set(kind, syncControl);
    syncControl();
    wrapper.append(surface, menu);
    return wrapper;
  }

  function renderFilterTokens(kind, options, enabled, tokenList, openMenu) {
    clear(tokenList);
    tokenList.classList.remove("hasMore");
    if (kind === "archiveLocation" && isDraftClaudeSource()) {
      tokenList.appendChild(filterToken(text("filterNotApplicable"), "", false));
      return;
    }
    const selected = new Set(getDraftIds(kind));
    const selectedOptions = options.filter((option) => selected.has(option.id));
    if (selectedOptions.length === 0) {
      const emptyLabel = kind === "tags"
        ? text("filterNoTagConstraint")
        : kind === "projects"
          ? text("filterAllProjects")
          : text("filterNone");
      tokenList.appendChild(filterToken(emptyLabel, "", false, kind === "source" || kind === "archiveLocation"));
      return;
    }
    const visibleOptions = selectedOptions.slice(0, 2);
    for (const option of visibleOptions) {
      const isUnrestrictedProject = kind === "projects" && option.kind === "all";
      const canRemove = enabled && !isUnrestrictedProject;
      const token = filterToken(option.label, option.description || "", canRemove);
      if (canRemove) {
        const remove = token.querySelector(".filterTokenRemove");
        remove?.addEventListener("click", (event) => {
          event.stopPropagation();
          const nextIds = nextFilterIdsAfterRemoval(kind, getDraftIds(kind), option.id, options);
          updateDraftSelection(kind, nextIds, options);
        });
      }
      tokenList.appendChild(token);
    }
    const remaining = selectedOptions.length - visibleOptions.length;
    if (remaining > 0) {
      tokenList.classList.add("hasMore");
      const more = el("button", { type: "button", className: "filterToken filterTokenMore" });
      more.textContent = `+${remaining}`;
      more.title = formatTemplate(text("filterMoreSelections"), remaining);
      more.setAttribute("aria-label", more.title);
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        openMenu();
      });
      tokenList.appendChild(more);
    }
  }

  function filterToken(label, description, removable, invalid) {
    const token = el("span", { className: `filterToken${invalid ? " invalid" : ""}` });
    const tokenLabel = el("span", { className: "filterTokenLabel" });
    tokenLabel.textContent = label;
    token.title = description ? `${label}\n${description}` : label;
    token.appendChild(tokenLabel);
    if (removable) {
      const remove = el("button", { type: "button", className: "filterTokenRemove" });
      remove.textContent = "×";
      remove.title = formatTemplate(text("filterRemoveSelection"), label);
      remove.setAttribute("aria-label", remove.title);
      token.appendChild(remove);
    }
    return token;
  }

  function updateDraftSelection(kind, ids, options) {
    const wasClaudeOnly = kind === "source" && isDraftClaudeSource();
    const order = new Map(options.map((option, index) => [option.id, index]));
    const orderedIds = ids.slice().sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
    setDraftIds(kind, orderedIds);
    if (kind === "source") syncDraftArchiveForSource(wasClaudeOnly);
    clearFilterApplyError();
    syncAllFilterControls();
  }

  function syncAllFilterControls() {
    filterControlSyncers.forEach((syncControl) => syncControl());
    syncFilterApplyState();
  }

  function renderDateRangeControl() {
    const control = el("div", { className: "dateRangeControl" });
    const title = el("div", { className: "filterLabel dateRangeTitle" });
    title.textContent = text("filterDate");
    const fields = el("div", { className: "dateRangeFields" });
    const fromLabel = el("label", { className: "dateField" });
    const fromText = el("span", {});
    fromText.textContent = text("filterFrom");
    const inputLanguage = normalizeUiLanguage(document.documentElement.lang);
    const fromInput = el("input", { type: "date", value: filterDraft?.from || "", lang: inputLanguage });
    fromInput.setAttribute("aria-label", text("filterFrom"));
    const toLabel = el("label", { className: "dateField" });
    const toText = el("span", {});
    toText.textContent = text("filterTo");
    const toInput = el("input", { type: "date", value: filterDraft?.to || "", lang: inputLanguage });
    toInput.setAttribute("aria-label", text("filterTo"));
    const error = el("div", { className: "dateRangeError", role: "alert" });
    error.hidden = true;
    const updateDraft = () => {
      if (!filterDraft) return;
      filterDraft.from = fromInput.value || null;
      filterDraft.to = toInput.value || null;
      const normalized = normalizeDateRangeInput(fromInput.value, toInput.value);
      error.textContent = normalized.valid ? "" : text(normalized.error === "order" ? "filterDateOrderError" : "filterDateInvalidError");
      error.hidden = normalized.valid;
      clearFilterApplyError();
      syncFilterApplyState();
    };
    fromInput.addEventListener("input", updateDraft);
    toInput.addEventListener("input", updateDraft);
    fromInput.disabled = filterApplying;
    toInput.disabled = filterApplying;
    fromLabel.append(fromText, fromInput);
    toLabel.append(toText, toInput);
    fields.append(fromLabel, toLabel);
    control.append(title, fields, error);
    return control;
  }

  function buildConditionSummary(value) {
    const range = value.dateRange || { from: null, to: null };
    const rangeText = range.from || range.to
      ? formatTemplate(text("filter.dateRangeValue"), range.from || text("filter.openStart"), range.to || text("filter.openEnd"))
      : text("filterAll");
    const project = value.projectsLabel || text("filterAll");
    return [
      formatTemplate(text("filter.source"), filterSourceValue(value.source)),
      formatTemplate(text("filter.date"), rangeText),
      formatTemplate(text("filter.location"), filterLocationValue(value)),
      formatTemplate(text("filter.project"), project),
      formatTemplate(text("filter.tags"), formatTemplate(text("filterTagCount"), value.tags.length)),
    ].join(" ・ ");
  }

  function createFilterDraft(value) {
    return {
      sourceIds: selectedOptionIds(value.options.source, 2),
      archiveLocationIds: selectedOptionIds(value.options.archiveLocation, 2),
      projectIds: selectedOptionIds(value.options.projects, 32),
      tagIds: selectedOptionIds(value.options.tags, 12),
      from: value.dateRange.from || null,
      to: value.dateRange.to || null,
    };
  }

  function selectedOptionIds(options, maximum) {
    return (Array.isArray(options) ? options : []).filter((option) => option.selected).slice(0, maximum).map((option) => option.id);
  }

  function getDraftIds(kind) {
    if (!filterDraft) return [];
    if (kind === "tags") return filterDraft.tagIds.slice();
    if (kind === "projects") return filterDraft.projectIds.slice();
    if (kind === "source") return filterDraft.sourceIds.slice();
    if (kind === "archiveLocation") return filterDraft.archiveLocationIds.slice();
    return [];
  }

  function setDraftIds(kind, ids) {
    if (!filterDraft) return;
    if (kind === "tags") {
      filterDraft.tagIds = ids.slice(0, 12);
      return;
    }
    if (kind === "projects") {
      filterDraft.projectIds = ids.slice(0, 32);
      return;
    }
    if (kind === "source") filterDraft.sourceIds = ids.slice(0, 2);
    if (kind === "archiveLocation") filterDraft.archiveLocationIds = ids.slice(0, 2);
  }

  function filterDraftValue(kind, options, multiple) {
    if (kind === "archiveLocation" && isDraftClaudeSource()) return text("filterNotApplicable");
    const selected = new Set(getDraftIds(kind));
    const selectedOptions = options.filter((option) => selected.has(option.id));
    const labels = selectedOptions.map((option) => option.label);
    if (kind === "projects" && labels.length > 1) {
      const memberCount = selectedOptions.reduce((sum, option) => sum + Math.max(1, nonNegativeInteger(option.memberCount)), 0);
      return formatTemplate(text("filterProjectGroupAndMemberCount"), labels.length, memberCount);
    }
    if ((kind === "source" || kind === "archiveLocation") && options.length > 1 && labels.length === options.length) {
      return text("filterAll");
    }
    if (kind === "tags" && labels.length === 0) return text("filterNoTagConstraint");
    if (multiple) return labels.length > 0 ? labels.join(", ") : text("filterNone");
    return labels[0] || text("filterNone");
  }

  function isFilterDraftValid() {
    if (!filterDraft) return false;
    if (!isValidFilterIdArray(filterDraft.sourceIds, 1, 2)) return false;
    if (!isValidFilterIdArray(filterDraft.archiveLocationIds, 1, 2)) return false;
    if (!Array.isArray(filterDraft.projectIds) || filterDraft.projectIds.length < 1 || filterDraft.projectIds.length > 32 || new Set(filterDraft.projectIds).size !== filterDraft.projectIds.length) return false;
    if (filterDraft.projectIds.some((id) => !/^[a-f0-9]{24}$/.test(String(id || "")))) return false;
    if (!Array.isArray(filterDraft.tagIds) || filterDraft.tagIds.length > 12 || new Set(filterDraft.tagIds).size !== filterDraft.tagIds.length) return false;
    if (filterDraft.tagIds.some((id) => !/^[a-f0-9]{24}$/.test(String(id || "")))) return false;
    return normalizeDateRangeInput(filterDraft.from || "", filterDraft.to || "").valid;
  }

  function isValidFilterIdArray(value, minimum, maximum) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return false;
    if (new Set(value).size !== value.length) return false;
    return value.every((id) => /^[a-f0-9]{24}$/.test(String(id || "")));
  }

  function isFilterConditionDraftChanged() {
    if (!filters || !filterDraft) return false;
    return hasFilterConditionChanges(filterDraft, createFilterDraft(filters));
  }

  function syncFilterApplyState() {
    if (!filterOverlay) return;
    const controls = filterOverlay.querySelectorAll("button, input");
    controls.forEach((control) => {
      if (control.classList.contains("filterApplyButton")) {
        control.disabled = filterApplying;
        return;
      }
      const sourceDisablesArchive = control.dataset.filterKind === "archiveLocation" && isDraftClaudeSource();
      control.disabled = filterApplying || control.dataset.baseDisabled === "true" || sourceDisablesArchive;
    });
    const trigger = document.getElementById("insights-filter-button");
    if (trigger) trigger.disabled = filterApplying || model?.refreshing === true;
    filterOverlay.classList.toggle("applying", filterApplying);
  }

  function syncApplyToHistoryControl() {
    const control = applyToHistoryControl;
    if (!control) return;
    const hint = text(applyToHistoryPreference
      ? "filterApplyToHistorySelectedHint"
      : "filterApplyToHistoryUnselectedHint");
    control.setAttribute("aria-pressed", String(applyToHistoryPreference));
    control.title = hint;
    control.setAttribute("aria-label", `${text("filterApplyToHistory")}. ${hint}`);
  }

  function isDraftClaudeSource() {
    if (!filters || !filterDraft) return false;
    const selected = filters.options.source.filter((option) => filterDraft.sourceIds.includes(option.id));
    return selected.length === 1 && selected[0]?.value === "claude";
  }

  function syncDraftArchiveForSource(wasClaudeOnly) {
    if (!filters || !filterDraft) return;
    const transition = calculateArchiveSelectionTransition(
      wasClaudeOnly,
      isDraftClaudeSource(),
      filterDraft.archiveLocationIds,
      archiveSelectionBeforeClaude,
      filters.options.archiveLocation.map((option) => option.id),
    );
    filterDraft.archiveLocationIds = transition.selectedIds;
    archiveSelectionBeforeClaude = transition.storedIds;
  }

  function applyFilterDraft() {
    if (!filterDraft) return;
    const action = resolveFilterApplyAction(
      isFilterDraftValid(),
      isFilterConditionDraftChanged(),
      applyToHistoryPreference,
      filterApplying,
    );
    if (action === "blocked") return;
    closeActiveFilterDropdown(false);
    clearFilterApplyError();
    if (action === "invalid") {
      showFilterApplyError("filterValidationError", true);
      return;
    }
    if (action === "close") {
      closeFilterOverlay(true);
      return;
    }
    filterApplying = true;
    syncFilterApplyState();
    vscode.postMessage({
      type: "applyFilters",
      snapshotId,
      ...filterDraft,
      sourceIds: filterDraft.sourceIds.slice(),
      archiveLocationIds: filterDraft.archiveLocationIds.slice(),
      projectIds: filterDraft.projectIds.slice(),
      tagIds: filterDraft.tagIds.slice(),
      applyToHistory: applyToHistoryPreference,
    });
  }

  function clearFilterApplyError() {
    const error = filterOverlay?.querySelector(".filterApplyError");
    if (!error) return;
    error.hidden = true;
    error.textContent = "";
  }

  function showFilterApplyError(key, focusInvalid) {
    if (!filterOverlay) {
      showTransientToast("filter-preference-error", text(key), true);
      return;
    }
    const error = filterOverlay.querySelector(".filterApplyError");
    if (error) {
      error.textContent = text(key);
      error.hidden = false;
      const body = filterOverlay.querySelector(".filterOverlayBody");
      if (body) body.scrollTop = 0;
    }
    syncFilterApplyState();
    if (focusInvalid) focusFirstInvalidFilterControl();
  }

  function focusFirstInvalidFilterControl() {
    if (!filterOverlay) return;
    const selectionErrors = Array.from(filterOverlay.querySelectorAll(".filterSelectionError"));
    const selectionError = selectionErrors.find((candidate) => !candidate.hidden);
    const dateError = filterOverlay.querySelector(".dateRangeError:not([hidden])");
    const target = selectionError?.closest(".filterControl")?.querySelector(".filterButton")
      || dateError?.closest(".dateRangeControl")?.querySelector("input")
      || null;
    const body = filterOverlay.querySelector(".filterOverlayBody");
    if (!target || !body) return;
    const targetRect = target.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (targetRect.top < bodyRect.top) body.scrollTop -= bodyRect.top - targetRect.top + 8;
    else if (targetRect.bottom > bodyRect.bottom) body.scrollTop += targetRect.bottom - bodyRect.bottom + 8;
    target.focus({ preventScroll: true });
  }

  function closeFilterOverlay(returnFocus) {
    closeActiveFilterDropdown(false);
    const overlay = filterOverlay;
    filterOverlay = null;
    filterDraft = null;
    filterApplying = false;
    applyToHistoryControl = null;
    archiveSelectionBeforeClaude = null;
    filterControlSyncers.clear();
    overlay?.remove();
    const trigger = document.getElementById("insights-filter-button");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus) trigger.focus({ preventScroll: true });
    }
  }

  function positionFilterDropdown(trigger, menu) {
    const triggerRect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(triggerRect.width, 240), Math.max(0, window.innerWidth - 16));
    menu.style.width = `${width}px`;
    const menuRect = menu.getBoundingClientRect();
    const position = calculateListboxPosition(triggerRect, { width, height: menuRect.height }, { width: window.innerWidth, height: window.innerHeight }, 8);
    menu.style.width = `${position.width}px`;
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    menu.style.maxHeight = `${position.maxHeight}px`;
    menu.dataset.placement = position.placement;
  }

  function calculateListboxPosition(triggerRect, menuSize, viewport, gap) {
    const margin = Math.max(0, Number(gap) || 0);
    const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
    const width = Math.min(Math.max(0, Number(menuSize?.width) || 0), Math.max(0, viewportWidth - margin * 2));
    const desiredHeight = Math.max(0, Number(menuSize?.height) || 0);
    const below = Math.max(0, viewportHeight - Number(triggerRect?.bottom || 0) - margin);
    const above = Math.max(0, Number(triggerRect?.top || 0) - margin);
    const placeAbove = below < Math.min(desiredHeight, 240) && above > below;
    const available = placeAbove ? above : below;
    const maxHeight = Math.max(0, Math.min(desiredHeight || available, available));
    const left = Math.min(
      Math.max(margin, Number(triggerRect?.left || 0)),
      Math.max(margin, viewportWidth - width - margin),
    );
    const top = placeAbove
      ? Math.max(margin, Number(triggerRect?.top || 0) - maxHeight - margin)
      : Math.min(viewportHeight - margin, Number(triggerRect?.bottom || 0) + margin);
    return { left, top, width, maxHeight, placement: placeAbove ? "top" : "bottom" };
  }

  function installHeaderObserver(header) {
    const update = () => {
      header.classList.remove("compact");
      const summary = header.querySelector(".headerSummary");
      const compact = shouldUseCompactHeader(
        header.clientWidth,
        header.scrollWidth,
        summary?.clientWidth,
        summary?.scrollWidth,
      );
      header.classList.toggle("compact", compact);
      document.documentElement.style.setProperty("--insights-header-height", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    };
    update();
    if (typeof ResizeObserver === "function") {
      headerResizeObserver = new ResizeObserver(update);
      headerResizeObserver.observe(header);
    } else {
      window.addEventListener("resize", update, { passive: true });
      headerResizeObserver = { disconnect: () => window.removeEventListener("resize", update) };
    }
  }

  function disconnectHeaderObserver() {
    headerResizeObserver?.disconnect();
    headerResizeObserver = null;
  }

  function shouldUseCompactHeader(clientWidth, scrollWidth, summaryClientWidth, summaryScrollWidth) {
    const headerOverflow = Number(scrollWidth) > Number(clientWidth) + 1;
    const summaryOverflow = Number(summaryScrollWidth) > Number(summaryClientWidth) + 1;
    return headerOverflow || summaryOverflow;
  }

  function calculateFiniteSelectionState(selectedIds, optionIds) {
    const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
    const available = Array.isArray(optionIds) ? optionIds : [];
    if (available.length === 0) return "false";
    const selectedCount = available.filter((id) => selected.has(id)).length;
    if (selectedCount === 0) return "false";
    return selectedCount === available.length ? "true" : "mixed";
  }

  function nextFilterIdsAfterRemoval(kind, selectedIds, removedId, options) {
    const current = Array.isArray(selectedIds) ? selectedIds : [];
    const nextIds = current.filter((id) => id !== removedId);
    if (kind === "projects" && nextIds.length === 0 && Array.isArray(options)) {
      const allOption = options.find((candidate) => candidate?.kind === "all" && typeof candidate.id === "string");
      if (allOption) nextIds.push(allOption.id);
    }
    return nextIds;
  }

  function calculateArchiveSelectionTransition(wasClaudeOnly, isClaudeOnly, currentIds, storedIds, availableIds) {
    const available = Array.isArray(availableIds) ? availableIds.slice() : [];
    const allowed = new Set(available);
    const current = (Array.isArray(currentIds) ? currentIds : []).filter((id) => allowed.has(id));
    const stored = Array.isArray(storedIds) ? storedIds.filter((id) => allowed.has(id)) : null;
    if (isClaudeOnly) {
      return {
        selectedIds: available,
        storedIds: wasClaudeOnly ? stored : current,
      };
    }
    if (wasClaudeOnly && stored) {
      return {
        selectedIds: stored.length > 0 ? stored : available,
        storedIds: null,
      };
    }
    return {
      selectedIds: current,
      storedIds: stored,
    };
  }

  function hasFilterConditionChanges(draft, baseline) {
    if (!draft || typeof draft !== "object" || !baseline || typeof baseline !== "object") return false;
    const keys = ["sourceIds", "archiveLocationIds", "projectIds", "tagIds", "from", "to"];
    return keys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]));
  }

  function resolveFilterApplyAction(valid, changed, applyToHistory, applying) {
    if (applying) return "blocked";
    if (!valid) return "invalid";
    if (!changed && !applyToHistory) return "close";
    return "submit";
  }

  function handleFilterMenuKeydown(event, optionButtons, trigger) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeActiveFilterDropdown(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const visible = optionButtons.filter((button) => !button.hidden);
    if (visible.length === 0) return;
    event.preventDefault();
    const current = visible.indexOf(document.activeElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visible.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, current < 0 ? visible.length - 1 : current - 1)
          : Math.min(visible.length - 1, current + 1);
    (visible[next] || trigger).focus();
  }

  function renderMetrics() {
    const section = el("section", { className: "metricGrid", ariaLabel: text("title") });
    const values = [
      ["sessions", model.metrics.sessions],
      ["userRequests", model.metrics.userRequests],
      ["inputTokens", model.metrics.inputTokens],
      ["outputTokens", model.metrics.outputTokens],
      ["reasoningOutputTokens", model.metrics.reasoningOutputTokens],
      ["totalTokens", model.metrics.totalTokens],
      ["distinctFiles", model.metrics.distinctFiles],
      ["linesAdded", model.metrics.linesAdded],
      ["linesRemoved", model.metrics.linesRemoved],
      ["changeEvents", model.metrics.changeEvents],
    ];
    values.forEach(([key, metric]) => {
      const card = el("article", { className: `metricCard ${metric.availability}` });
      const label = el("div", { className: "metricLabel" });
      label.textContent = text(key);
      const value = el("div", { className: "metricValue" });
      const presentation = appendMetricPresentation(value, metric, false);
      const valueLength = presentation.valueText.length;
      value.classList.toggle("longValue", valueLength > 14);
      value.classList.toggle("veryLongValue", valueLength > 18);
      value.title = presentation.valueText;
      const coverage = el("div", { className: "metricCoverage muted" });
      coverage.textContent = `${metric.availableSessions}/${metric.totalSessions}`;
      if (presentation.kind === "partial") {
        coverage.appendChild(createMetricLowerBoundBadge(presentation.valueText));
      }
      card.append(label, value, coverage);
      section.appendChild(card);
    });
    return section;
  }

  function renderActivity() {
    const { section } = createCollapsiblePanel("activity", "activity", "accentGreen");
    const toolbar = el("div", { className: "panelToolbar" });
    const switcher = renderActivityMetricDropdown();
    toolbar.appendChild(switcher);
    section.appendChild(toolbar);
    const orderedDays = model.days.slice().sort((left, right) => left.ymd.localeCompare(right.ymd));
    if (orderedDays.length === 0) return section;
    const max = Math.max(1, ...orderedDays.map((day) => activityValue(day)));
    const heatmapScroller = el("div", { className: "heatmapScroller" });
    const heatmapCanvas = el("div", { className: "heatmapCanvas" });
    const headerAxis = el("div", { className: "heatmapHeaderAxis", ariaHidden: "true" });
    ["activityYear", "activityMonth", "activityDay"].forEach((key) => {
      const value = el("span", {});
      value.textContent = text(key);
      headerAxis.appendChild(value);
    });
    const weekdayLabels = el("div", { className: "weekdayLabels", ariaHidden: "true" });
    buildWeekdayLabels().forEach((label) => {
      const value = el("span", {});
      value.textContent = label;
      weekdayLabels.appendChild(value);
    });
    const grid = el("div", { className: "heatmap", role: "group", ariaLabel: text("activity") });
    const layout = calculateIsoWeekLayout(orderedDays.map((day) => day.ymd));
    const weekStarts = layout.weekStarts.map(parseYmdUtc).filter(Boolean);
    if (weekStarts.length === 0) return section;
    const heatmapHeaders = buildHeatmapHeaders(weekStarts);
    orderedDays.forEach((day) => {
      const dateValue = parseYmdUtc(day.ymd);
      if (!dateValue) return;
      const value = activityValue(day);
      const dayMetric = activityMetricValue(day);
      const displayValue = metricAccessibleText(dayMetric);
      const coverageText = formatActivityCoverage(dayMetric);
      const button = el("button", { type: "button", className: "heatCell" });
      const placement = layout.placements[day.ymd];
      if (!placement) return;
      button.style.gridColumn = String(placement.week + 1);
      button.style.gridRow = String(placement.weekday + 1);
      button.style.setProperty("--activity-level", value <= 0 ? "0%" : `${Math.round(Math.max(0.08, value / max) * 72)}%`);
      button.setAttribute("aria-label", `${day.ymd}: ${displayValue}. ${coverageText}. ${text("showInHistory")}`);
      button.title = `${formatFullDate(dateValue)}: ${displayValue} · ${coverageText}`;
      const date = el("span", { className: "heatDate" });
      date.textContent = day.ymd;
      const count = el("span", { className: "heatValue" });
      appendMetricPresentation(count, dayMetric);
      button.append(date, count);
      button.addEventListener("click", () => vscode.postMessage({ type: "showDay", ymd: day.ymd }));
      grid.appendChild(button);
    });
    heatmapCanvas.append(headerAxis, heatmapHeaders, weekdayLabels, grid);
    heatmapScroller.appendChild(heatmapCanvas);
    heatmapScroller.addEventListener("scroll", () => {
      heatmapScrollLeft = Math.max(0, heatmapScroller.scrollLeft);
      debouncePersistState();
    }, { passive: true });
    section.appendChild(heatmapScroller);
    requestAnimationFrame(() => {
      heatmapScroller.scrollLeft = Math.max(0, heatmapScrollLeft);
    });
    return section;
  }

  function renderActivityMetricDropdown() {
    const groups = [
      { label: "activityGroupUsage", values: ["sessions", "requests", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"] },
      { label: "activityGroupFileChanges", values: ["files", "linesAdded", "linesRemoved", "changedLines"] },
    ];
    const control = el("div", { className: "activityMetricControl" });
    const controlLabel = el("span", { className: "controlLabel activityMetricControlLabel" });
    controlLabel.textContent = text("activityMetric");
    const wrapper = el("div", { className: "activityMetricDropdown" });
    const trigger = el("button", { type: "button", className: "activityMetricTrigger" });
    const triggerValue = el("span", { className: "activityMetricTriggerValue" });
    triggerValue.textContent = activityMetricLabel(activityMetric);
    const triggerCoverage = el("span", { className: "activityMetricTriggerCoverage" });
    triggerCoverage.textContent = formatActivityCoverage(activityMetricSummary(activityMetric));
    triggerCoverage.title = triggerCoverage.textContent;
    const chevron = el("span", { className: "activityMetricChevron", ariaHidden: "true" });
    chevron.textContent = "⌄";
    trigger.append(triggerValue, triggerCoverage, chevron);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", `${text("activityMetric")}: ${activityMetricLabel(activityMetric)}. ${triggerCoverage.textContent}`);
    const menu = el("div", { className: "activityMetricMenu", role: "listbox", ariaLabel: text("activityMetric") });
    menu.hidden = true;
    const optionButtons = [];
    groups.forEach((group) => {
      const heading = el("div", { className: "activityMetricGroupLabel", role: "presentation" });
      heading.textContent = text(group.label);
      menu.appendChild(heading);
      group.values.forEach((value) => {
        const button = el("button", { type: "button", className: "activityMetricOption", role: "option" });
        const selected = value === activityMetric;
        const marker = el("span", { className: "activityMetricMarker", ariaHidden: "true" });
        marker.textContent = selected ? "✓" : "";
        const label = el("span", { className: "activityMetricOptionLabel" });
        label.textContent = activityMetricLabel(value);
        const coverage = el("span", { className: "activityMetricCoverage" });
        coverage.textContent = formatActivityCoverage(activityMetricSummary(value));
        coverage.title = coverage.textContent;
        button.append(marker, label, coverage);
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-selected", String(selected));
        button.setAttribute("aria-label", `${label.textContent}. ${coverage.textContent}`);
        button.addEventListener("click", () => {
          activityMetric = normalizeActivityMetric(value);
          closeActivityMetricDropdown(true);
          persistState();
          renderModel();
        });
        optionButtons.push(button);
        menu.appendChild(button);
      });
    });
    menu.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = optionButtons.indexOf(document.activeElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? optionButtons.length - 1
          : event.key === "ArrowUp"
            ? Math.max(0, current < 0 ? optionButtons.length - 1 : current - 1)
            : Math.min(optionButtons.length - 1, current + 1);
      optionButtons[next]?.focus({ preventScroll: true });
    });
    trigger.addEventListener("click", () => {
      if (activeActivityDropdown?.trigger === trigger) {
        closeActivityMetricDropdown(true);
        return;
      }
      closeBreakdownMetricDropdown(false);
      closeActivityMetricDropdown(false);
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      activeActivityDropdown = { wrapper, trigger, menu };
      requestAnimationFrame(() => {
        const rect = trigger.getBoundingClientRect();
        const availableWidth = Math.max(0, window.innerWidth - 16);
        const width = Math.min(360, availableWidth, Math.max(rect.width, Math.min(320, availableWidth)));
        const position = calculateListboxPosition(rect, { width, height: menu.getBoundingClientRect().height }, { width: window.innerWidth, height: window.innerHeight }, 8);
        menu.style.left = `${position.left}px`;
        menu.style.top = `${position.top}px`;
        menu.style.width = `${position.width}px`;
        menu.style.maxHeight = `${position.maxHeight}px`;
        menu.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      });
    });
    wrapper.append(trigger, menu);
    control.append(controlLabel, wrapper);
    return control;
  }

  function activityMetricLabel(value) {
    const keys = {
      sessions: "activitySessions",
      requests: "activityRequests",
      inputTokens: "activityInputTokens",
      outputTokens: "activityOutputTokens",
      reasoningTokens: "activityReasoningTokens",
      totalTokens: "activityTotalTokens",
      files: "activityFiles",
      linesAdded: "activityLinesAdded",
      linesRemoved: "activityLinesRemoved",
      changedLines: "activityChangedLines",
    };
    return text(keys[value] || keys.sessions);
  }

  function activityMetricSummary(value) {
    if (value === "requests") return model.metrics.userRequests;
    if (value === "inputTokens") return model.metrics.inputTokens;
    if (value === "outputTokens") return model.metrics.outputTokens;
    if (value === "reasoningTokens") return model.metrics.reasoningOutputTokens;
    if (value === "totalTokens") return model.metrics.totalTokens;
    if (value === "files") return model.metrics.distinctFiles;
    if (value === "linesAdded") return model.metrics.linesAdded;
    if (value === "linesRemoved") return model.metrics.linesRemoved;
    if (value === "changedLines") {
      return model.days.reduce((summary, day) => ({
        availability: summary.availability === "unavailable" || day.changedLineCount.availability === "unavailable"
          ? "partial"
          : summary.availability === "partial" || day.changedLineCount.availability === "partial"
            ? "partial"
            : "available",
        availableSessions: summary.availableSessions + nonNegativeInteger(day.changedLineCount.availableSessions),
        totalSessions: summary.totalSessions + nonNegativeInteger(day.changedLineCount.totalSessions),
      }), { availability: "available", availableSessions: 0, totalSessions: 0 });
    }
    return model.metrics.sessions;
  }

  function formatActivityCoverage(metric) {
    const availableSessions = nonNegativeInteger(metric?.availableSessions);
    const totalSessions = nonNegativeInteger(metric?.totalSessions);
    const key = totalSessions > 0 && availableSessions === 0
      ? "activityCoverageUnavailable"
      : metric?.availability !== "available" || availableSessions < totalSessions
        ? "activityCoveragePartial"
        : "activityCoverage";
    return formatTemplate(
      text(key),
      formatNumber(availableSessions),
      formatNumber(totalSessions),
    );
  }

  function buildHeatmapHeaders(weekStarts) {
    const header = el("div", { className: "heatmapHeaders", ariaHidden: "true" });
    header.append(
      buildPeriodHeaderRow(weekStarts, (date) => String(date.getUTCFullYear()), (date) => formatYear(date), "yearRow"),
      buildPeriodHeaderRow(weekStarts, (date) => `${date.getUTCFullYear()}-${date.getUTCMonth()}`, (date) => formatMonth(date), "monthRow"),
    );
    const dayRow = el("div", { className: "heatmapHeaderRow dayRow" });
    weekStarts.forEach((date, index) => {
      const value = el("span", { className: "heatmapHeaderCell dayHeaderCell" });
      value.style.gridColumn = String(index + 1);
      value.textContent = new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: "UTC" }).format(date);
      value.title = formatFullDate(date);
      dayRow.appendChild(value);
    });
    header.appendChild(dayRow);
    return header;
  }

  function buildPeriodHeaderRow(weekStarts, keyOf, labelOf, className) {
    const row = el("div", { className: `heatmapHeaderRow ${className}` });
    let start = 0;
    while (start < weekStarts.length) {
      const key = keyOf(weekStarts[start]);
      let end = start + 1;
      while (end < weekStarts.length && keyOf(weekStarts[end]) === key) end += 1;
      const value = el("span", { className: "heatmapHeaderCell periodHeaderCell" });
      value.style.gridColumn = `${start + 1} / span ${end - start}`;
      value.textContent = labelOf(weekStarts[start]);
      row.appendChild(value);
      start = end;
    }
    return row;
  }

  function renderFiles() {
    const { section } = createCollapsiblePanel("files", "topFiles", "accentBlue filesPanel");
    const toolbar = el("div", { className: "panelToolbar filesToolbar" });
    const controls = el("div", { className: "fileControls" });
    const sortLabel = el("span", { className: "controlLabel" });
    sortLabel.textContent = text("fileSort");
    const sortSwitcher = segmentedControl(
      ["sessions", "events", "lines", "recent", "name"],
      fileSort.key,
      (value) => text(`fileSort${capitalize(value)}`),
      (value) => {
        fileSort = normalizeFileSort({ ...fileSort, key: value });
        persistState();
        renderModel();
      },
      "fileSortSwitcher",
    );
    sortSwitcher.setAttribute("aria-label", text("fileSort"));
    const directionButton = renderFileSortDirectionButton();
    controls.append(sortLabel, sortSwitcher, directionButton);
    toolbar.appendChild(controls);
    const actions = el("div", { className: "fileActions" });
    const historyButton = actionButton("openFileHistory", () => {
      if (selectedFileId) vscode.postMessage({ type: "openFileHistory", id: selectedFileId });
    });
    const openButton = actionButton("openFile", () => {
      if (selectedFileId) vscode.postMessage({ type: "openFile", id: selectedFileId });
    }, true);
    actions.append(historyButton, openButton);
    toolbar.appendChild(actions);
    section.appendChild(toolbar);
    if (model.files.length === 0) return section;
    const sortedFiles = model.files.slice().sort(compareFiles);
    if (!sortedFiles.some((file) => file.id === selectedFileId)) selectedFileId = "";
    const list = el("div", { className: "tableList fileList", role: "listbox", tabIndex: 0, ariaLabel: text("fileListLabel") });
    const rows = new Map();
    const selectedFile = () => sortedFiles.find((file) => file.id === selectedFileId);
    const syncSelection = (scroll) => {
      rows.forEach((row, id) => {
        const selected = id === selectedFileId;
        row.classList.toggle("selected", selected);
        row.setAttribute("aria-selected", String(selected));
        if (selected && scroll) row.scrollIntoView({ block: "nearest" });
      });
      const file = selectedFile();
      if (file) list.setAttribute("aria-activedescendant", `file-option-${file.id}`);
      else list.removeAttribute("aria-activedescendant");
      historyButton.disabled = !file || !file.canOpenFileHistory;
      openButton.disabled = !file || !file.canOpenFile;
      historyButton.title = !file ? text("fileSelectHint") : historyButton.disabled ? text("fileHistoryUnavailable") : text("openFileHistory");
      openButton.title = !file ? text("fileSelectHint") : openButton.disabled ? text("fileOpenUnavailable") : text("openFile");
    };
    const selectFile = (id, scroll) => {
      selectedFileId = sanitizeEntityId(id);
      persistState();
      syncSelection(scroll);
    };
    sortedFiles.forEach((file) => {
      const fileKind = normalizeFileKind(file.fileKind);
      const row = el("div", { id: `file-option-${file.id}`, className: `tableRow fileRow fileKind fileKind-${fileKind}`, role: "option" });
      row.setAttribute("aria-selected", "false");
      const icon = el("span", { className: "fileKindIcon", ariaHidden: "true" });
      const content = el("span", { className: "fileRowContent" });
      const main = el("div", { className: "fileRowMain" });
      const project = primaryFileProjectContext(file);
      const projectName = project.disambiguate && project.pathHint
        ? `${project.displayName} (${project.pathHint})`
        : project.displayName;
      const otherProjects = Math.max(0, nonNegativeInteger(file.projectContextCount) - 1);
      const otherProjectText = otherProjects > 0
        ? formatTemplate(text(otherProjects === 1 ? "fileOtherProject" : "fileOtherProjects"), otherProjects)
        : "";
      const columns = composeFileRowColumns(file.displayPath, projectName, otherProjectText);
      const filePath = el("span", { className: "rowMain filePath" });
      filePath.textContent = columns.pathText;
      filePath.title = columns.pathText;
      const projectLabel = el("span", { className: "fileProjectName muted" });
      projectLabel.textContent = columns.projectText;
      const projectHint = project.pathHint
        ? formatTemplate(text("fileProjectHint"), project.displayName, project.pathHint)
        : project.displayName;
      projectLabel.title = `${columns.projectText}\n${projectHint}`;
      main.append(filePath, projectLabel);
      const detail = el("div", { className: "rowDetail muted" });
      const lastChanged = validDateTime(file.lastTimestampIso);
      const lastChangedText = lastChanged ? formatDateTime(file.lastTimestampIso) : text("unknown");
      detail.textContent = `${text("fileSessions")}: ${formatNumber(file.sessionCount)} · ${text("fileEvents")}: ${formatNumber(file.changeEventCount)} · +${formatNumber(file.linesAdded)} / -${formatNumber(file.linesRemoved)} · ${text("fileLastChanged")}: ${lastChangedText}`;
      detail.title = lastChanged ? formatFullDateTime(file.lastTimestampIso) : text("unknown");
      content.append(main, detail);
      row.setAttribute("aria-label", formatTemplate(text("fileRowAria"), text(`fileKind.${fileKind}`), `${columns.pathText} · ${columns.projectText}`, detail.textContent));
      row.append(icon, content);
      row.addEventListener("click", () => {
        selectFile(file.id, false);
        list.focus();
      });
      row.addEventListener("dblclick", () => {
        selectFile(file.id, false);
        if (file.canOpenFile) vscode.postMessage({ type: "openFile", id: file.id });
      });
      rows.set(file.id, row);
      list.appendChild(row);
    });
    list.addEventListener("scroll", () => {
      fileListScrollTop = list.scrollTop;
    }, { passive: true });
    list.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Enter") {
        const file = selectedFile();
        if (file && file.canOpenFile) vscode.postMessage({ type: "openFile", id: file.id });
        return;
      }
      const currentIndex = sortedFiles.findIndex((file) => file.id === selectedFileId);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? sortedFiles.length - 1
          : event.key === "ArrowUp"
            ? Math.max(0, currentIndex < 0 ? sortedFiles.length - 1 : currentIndex - 1)
            : Math.min(sortedFiles.length - 1, currentIndex + 1);
      const next = sortedFiles[nextIndex];
      if (next) selectFile(next.id, true);
    });
    syncSelection(false);
    section.appendChild(list);
    requestAnimationFrame(() => {
      list.scrollTop = Math.max(0, fileListScrollTop);
    });
    return section;
  }

  function renderFileSortDirectionButton() {
    const ascending = fileSort.direction === "asc";
    const labelKey = ascending ? "fileSortAscending" : "fileSortDescending";
    const button = el("button", { type: "button", className: "sortDirectionButton" });
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ascending ? "M8 13V3m0 0L4.5 6.5M8 3l3.5 3.5" : "M8 3v10m0 0 3.5-3.5M8 13 4.5 9.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    icon.appendChild(path);
    const label = el("span", { className: "sortDirectionLabel" });
    label.textContent = text(labelKey);
    button.append(icon, label);
    button.title = formatTemplate(text("fileSortDirectionHint"), text(labelKey));
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      fileSort = { ...fileSort, direction: ascending ? "desc" : "asc" };
      persistState();
      renderModel();
    });
    return button;
  }

  function primaryFileProjectContext(file) {
    const project = Array.isArray(file.projectContexts) ? file.projectContexts[0] : null;
    return project || { displayName: text("fileProjectUnknown"), pathHint: "", disambiguate: false };
  }

  function composeFileRowColumns(displayPath, projectName, otherProjectText) {
    const pathText = String(displayPath || "");
    const projectText = [projectName, otherProjectText]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" · ");
    return { pathText, projectText };
  }

  function renderBreakdowns() {
    const { section } = createCollapsiblePanel("breakdown", "breakdown", "accentPurple");
    const toolbar = el("div", { className: "panelToolbar breakdownToolbar" });
    toolbar.appendChild(renderBreakdownMetricDropdown());
    section.appendChild(toolbar);
    const columns = el("div", { className: "breakdownGrid" });
    const groups = [model.sources, model.models, model.projects];
    const breakdownValues = groups.flatMap((group) => {
      const rows = selectBreakdownRows(group, breakdownMetric);
      const total = group.totals[breakdownMetric];
      return rows.map((row) => formatBreakdownValueParts(row.metrics[breakdownMetric], total));
    });
    breakdownValues.push(...model.models.rows.flatMap((row) =>
      row.effortRows.map((effort) => formatBreakdownValueParts(effort.value, row.effortTotalTokens)),
    ));
    const valueWidths = calculateBreakdownColumnWidths(breakdownValues);
    columns.style.setProperty("--breakdown-value-width", `${valueWidths.valueWidthCh}ch`);
    columns.style.setProperty("--breakdown-percentage-width", `${valueWidths.percentageWidthCh}ch`);
    columns.append(
      renderBarList("sources", model.sources),
      renderModelList(),
      renderProjectList(),
    );
    section.appendChild(columns);
    return section;
  }

  function renderUsageDetails() {
    const { section } = createCollapsiblePanel("usageDetails", "usageDetails", "accentPurple");
    const grid = el("div", { className: "usageDetailGrid" });
    grid.append(
      renderDetailMetricGroup("inputCacheDetails", model.usageDetails.inputCache),
      renderDetailMetricGroup("messageComposition", model.usageDetails.messages),
      renderDetailMetricGroup("turnStates", model.usageDetails.turns),
      renderFileKindGroup(),
    );
    section.appendChild(grid);
    return section;
  }

  function renderDetailMetricGroup(titleKey, rows) {
    const group = el("section", { className: "usageDetailGroup" });
    const title = el("h3", {});
    title.textContent = text(titleKey);
    const list = el("dl", { className: "usageDetailList" });
    rows.forEach((row) => {
      const term = el("dt", {});
      term.textContent = text(`detail.${row.key}`);
      const detail = el("dd", {});
      const presentation = resolveMetricPresentation(row.metric, text("unknown"), formatNumber);
      detail.textContent = presentation.kind === "partial" ? `≥ ${presentation.valueText}` : presentation.valueText;
      detail.title = row.metric.availability === "unavailable"
        ? text("unknown")
        : formatTemplate(text("activityCoverage"), row.metric.availableSessions, row.metric.totalSessions);
      list.append(term, detail);
    });
    group.append(title, list);
    return group;
  }

  function renderFileKindGroup() {
    const group = el("section", { className: "usageDetailGroup" });
    const title = el("h3", {});
    title.textContent = text("fileKindBreakdown");
    const list = el("div", { className: "fileKindDetailList" });
    model.usageDetails.fileKinds.forEach((row) => {
      const item = el("div", { className: "fileKindDetailRow" });
      const label = el("span", {});
      label.textContent = text(`fileKind.${row.kind}`);
      const value = el("span", { className: "fileKindDetailValue" });
      value.textContent = formatTemplate(
        text("fileKindBreakdownValue"),
        formatNumber(row.distinctFileCount),
        formatNumber(row.changeEventCount),
      );
      item.append(label, value);
      list.appendChild(item);
    });
    group.append(title, list);
    return group;
  }

  function renderTools() {
    const { section } = createCollapsiblePanel("tools", "tools", "accentBlue");
    const toolbar = el("div", { className: "panelToolbar" });
    toolbar.appendChild(simpleMetricSelect(
      "toolMetric",
      toolMetric,
      [["calls", "toolCalls"], ["sessions", "toolSessions"]],
      (value) => {
        toolMetric = value === "sessions" ? "sessions" : "calls";
        persistState();
        renderModel();
      },
    ));
    section.appendChild(toolbar);
    const rows = model.tools.rows
      .filter((row) => row[toolMetric] > 0)
      .sort((left, right) => right[toolMetric] - left[toolMetric] || left.label.localeCompare(right.label))
      .slice(0, 32);
    const total = model.tools.totals[toolMetric];
    const list = el("div", { className: "analyticsList" });
    rows.forEach((row) => {
      list.appendChild(renderSimpleBarRow(row.label === "unknown" ? text("unknown") : row.label, row[toolMetric], total));
    });
    section.appendChild(list);
    const omittedCount = Math.max(0, model.tools.positiveRowCounts[toolMetric] - rows.length);
    if (omittedCount > 0) {
      const omitted = el("p", { className: "breakdownOmitted muted" });
      omitted.textContent = formatTemplate(text("toolOmitted"), formatNumber(omittedCount));
      section.appendChild(omitted);
    }
    return section;
  }

  function renderActiveSessions() {
    const { section } = createCollapsiblePanel("activeSessions", "activeSessions", "accentGreen");
    const toolbar = el("div", { className: "panelToolbar" });
    toolbar.appendChild(simpleMetricSelect(
      "activeSessionMetric",
      activeSessionMetric,
      [
        ["userRequests", "activeSessionUserRequests"],
        ["toolCalls", "activeSessionToolCalls"],
        ["reasoningTokens", "activeSessionReasoningTokens"],
        ["totalTokens", "activeSessionTotalTokens"],
        ["changedLines", "activeSessionChangedLines"],
      ],
      (value) => {
        activeSessionMetric = ["userRequests", "toolCalls", "reasoningTokens", "totalTokens", "changedLines"].includes(value)
          ? value
          : "userRequests";
        persistState();
        renderModel();
      },
    ));
    section.appendChild(toolbar);
    const rows = model.activeSessions
      .filter((row) => row.metrics[activeSessionMetric].availability !== "unavailable")
      .sort((left, right) =>
        (right.metrics[activeSessionMetric].value ?? -1) - (left.metrics[activeSessionMetric].value ?? -1) ||
        String(right.lastActivityAtIso || "").localeCompare(String(left.lastActivityAtIso || "")) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id))
      .slice(0, 20);
    const list = el("div", { className: "activeSessionList" });
    rows.forEach((row) => {
      const button = el("button", { type: "button", className: "activeSessionRow" });
      const main = el("span", { className: "activeSessionMain" });
      const title = el("span", { className: "activeSessionTitle" });
      title.textContent = row.title;
      title.title = row.title;
      const meta = el("span", { className: "activeSessionMeta muted" });
      meta.textContent = [text(`source.${row.source}`), row.projectLabel, formatDateTime(row.lastActivityAtIso)].filter(Boolean).join(" · ");
      main.append(title, meta);
      const metric = row.metrics[activeSessionMetric];
      const value = el("span", { className: "activeSessionValue" });
      value.textContent = `${metric.availability === "partial" ? "≥ " : ""}${formatNumber(metric.value ?? 0)}`;
      button.title = text("activeSessionOpenHint");
      button.setAttribute("aria-label", `${text("activeSessionOpen")}: ${row.title}, ${value.textContent}`);
      button.addEventListener("click", () => vscode.postMessage({ type: "openSession", id: row.id }));
      button.append(main, value);
      list.appendChild(button);
    });
    section.appendChild(list);
    return section;
  }

  function simpleMetricSelect(labelKey, selectedValue, options, onChange) {
    const control = el("label", { className: "simpleMetricControl" });
    const label = el("span", { className: "controlLabel" });
    label.textContent = text(labelKey);
    const select = el("select", { className: "simpleMetricSelect" });
    options.forEach(([value, key]) => {
      const option = el("option", { value });
      option.textContent = text(key);
      option.selected = value === selectedValue;
      select.appendChild(option);
    });
    select.addEventListener("change", () => onChange(select.value));
    control.append(label, select);
    return control;
  }

  function renderSimpleBarRow(labelText, rowValue, total) {
    const row = el("div", { className: "barRow" });
    const label = el("span", { className: "barLabel" });
    label.textContent = labelText;
    label.title = labelText;
    const bar = el("span", { className: "barTrack" });
    const fill = el("span", { className: "barFill" });
    fill.style.width = `${calculateBreakdownShare(rowValue, total) * 100}%`;
    bar.appendChild(fill);
    const value = el("span", { className: "barValue" });
    value.textContent = formatNumber(rowValue);
    row.append(label, bar, value);
    return row;
  }

  function renderBreakdownMetricDropdown() {
    const values = ["sessions", "inputTokens", "outputTokens", "totalTokens"];
    const control = el("div", { className: "activityMetricControl breakdownMetricControl" });
    const controlLabel = el("span", { className: "controlLabel activityMetricControlLabel" });
    controlLabel.textContent = text("breakdownMetric");
    const wrapper = el("div", { className: "activityMetricDropdown breakdownMetricDropdown" });
    const trigger = el("button", { type: "button", className: "activityMetricTrigger breakdownMetricTrigger" });
    const triggerValue = el("span", { className: "activityMetricTriggerValue" });
    triggerValue.textContent = activityMetricLabel(breakdownMetric);
    const chevron = el("span", { className: "activityMetricChevron", ariaHidden: "true" });
    chevron.textContent = "⌄";
    trigger.append(triggerValue, chevron);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", `${text("breakdownMetric")}: ${triggerValue.textContent}`);
    const menu = el("div", { className: "activityMetricMenu breakdownMetricMenu", role: "listbox", ariaLabel: text("breakdownMetric") });
    menu.hidden = true;
    const optionButtons = values.map((value) => {
      const button = el("button", { type: "button", className: "activityMetricOption", role: "option" });
      const selected = value === breakdownMetric;
      const marker = el("span", { className: "activityMetricMarker", ariaHidden: "true" });
      marker.textContent = selected ? "✓" : "";
      const label = el("span", { className: "activityMetricOptionLabel" });
      label.textContent = activityMetricLabel(value);
      button.append(marker, label);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("aria-label", label.textContent);
      button.addEventListener("click", () => {
        breakdownMetric = normalizeBreakdownMetric(value);
        closeBreakdownMetricDropdown(true);
        persistState();
        renderModel();
      });
      menu.appendChild(button);
      return button;
    });
    menu.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = optionButtons.indexOf(document.activeElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? optionButtons.length - 1
          : event.key === "ArrowUp"
            ? Math.max(0, current < 0 ? optionButtons.length - 1 : current - 1)
            : Math.min(optionButtons.length - 1, current + 1);
      optionButtons[next]?.focus({ preventScroll: true });
    });
    trigger.addEventListener("click", () => {
      if (activeBreakdownMetricDropdown?.trigger === trigger) {
        closeBreakdownMetricDropdown(true);
        return;
      }
      closeActivityMetricDropdown(false);
      closeBreakdownMetricDropdown(false);
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      activeBreakdownMetricDropdown = { wrapper, trigger, menu };
      requestAnimationFrame(() => {
        const rect = trigger.getBoundingClientRect();
        const availableWidth = Math.max(0, window.innerWidth - 16);
        const width = Math.min(320, availableWidth, Math.max(rect.width, Math.min(280, availableWidth)));
        const position = calculateListboxPosition(rect, { width, height: menu.getBoundingClientRect().height }, { width: window.innerWidth, height: window.innerHeight }, 8);
        menu.style.left = `${position.left}px`;
        menu.style.top = `${position.top}px`;
        menu.style.width = `${position.width}px`;
        menu.style.maxHeight = `${position.maxHeight}px`;
        menu.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      });
    });
    wrapper.append(trigger, menu);
    control.append(controlLabel, wrapper);
    return control;
  }

  function renderBreakdownGroupHeader(titleKey) {
    const header = el("div", { className: "breakdownGroupHeader" });
    const title = el("h3", {});
    title.textContent = text(titleKey);
    const unit = el("span", { className: "breakdownGroupUnit muted" });
    unit.textContent = formatTemplate(text("breakdownGroupUnit"), activityMetricLabel(breakdownMetric));
    const fullText = `${title.textContent} ${unit.textContent}`;
    header.title = titleKey === "models" && breakdownMetric === "sessions"
      ? `${fullText}. ${text("modelSessionCountHint")}`
      : fullText;
    header.setAttribute("aria-label", header.title);
    header.append(title, unit);
    return header;
  }

  function renderBarList(titleKey, breakdownGroup) {
    const container = el("section", { className: "breakdownGroup" });
    const rows = selectBreakdownRows(breakdownGroup, breakdownMetric);
    container.appendChild(renderBreakdownGroupHeader(titleKey));
    const total = breakdownGroup.totals[breakdownMetric];
    rows.forEach((row) => {
      container.appendChild(renderBarRow(titleKey, row, total, false));
    });
    appendBreakdownOmitted(container, breakdownGroup, rows);
    return container;
  }

  function renderBarRow(titleKey, row, total, interactive) {
    const item = el(interactive ? "button" : "div", {
      className: `barRow${interactive ? " modelBarButton" : ""}${titleKey === "projects" ? " projectBarRow" : ""}`,
      ...(interactive ? { type: "button" } : {}),
    });
    const label = el("span", { className: "barLabel" });
    const fullLabel = String(row.label);
    const displayLabel = formatBreakdownLabel(titleKey, row.label);
    if (titleKey === "models") {
      const gutter = el("span", { className: "modelToggleGutter", ariaHidden: "true" });
      const labelText = el("span", { className: "barLabelText" });
      labelText.textContent = displayLabel;
      label.append(gutter, labelText);
    } else {
      label.textContent = displayLabel;
    }
    if (["models", "projects"].includes(titleKey) || fullLabel !== displayLabel) {
      label.title = fullLabel;
    }
    const bar = el("span", { className: "barTrack" });
    const fill = el("span", { className: "barFill" });
    const rowValue = titleKey === "modelEffort" ? row.value : row.metrics[breakdownMetric];
    const share = calculateBreakdownShare(rowValue, total);
    fill.style.width = `${share * 100}%`;
    fill.style.minWidth = nonNegativeInteger(rowValue) > 0 ? "2px" : "0";
    bar.appendChild(fill);
    const valueParts = formatBreakdownValueParts(rowValue, total);
    const value = el("span", { className: "barValue" });
    const accessibleValue = el("span", { className: "visuallyHidden" });
    accessibleValue.textContent = valueParts.accessibleText;
    const absoluteValue = el("span", { className: "barAbsoluteValue", ariaHidden: "true" });
    absoluteValue.textContent = valueParts.absoluteText;
    const percentage = el("span", { className: "barPercentage", ariaHidden: "true" });
    percentage.textContent = valueParts.percentageText;
    value.append(accessibleValue, absoluteValue, percentage);
    item.append(label, bar, value);
    return item;
  }

  function renderModelList() {
    const group = el("section", { className: "breakdownGroup modelBreakdownGroup" });
    group.appendChild(renderBreakdownGroupHeader("models"));
    const rows = selectBreakdownRows(model.models, breakdownMetric);
    const total = model.models.totals[breakdownMetric];
    rows.forEach((row) => {
      const entry = el("div", { className: "modelBreakdownEntry" });
      const expandable = row.effortRows.length > 0 && row.effortTotalTokens > 0;
      const item = renderBarRow("models", row, total, expandable);
      if (expandable) {
        const expanded = expandedModelIds.includes(row.id);
        item.id = `model-toggle-${row.id}`;
        item.setAttribute("aria-expanded", String(expanded));
        item.setAttribute("aria-controls", `model-effort-${row.id}`);
        const gutter = item.querySelector(".modelToggleGutter");
        const chevron = el("span", { className: "modelChevron", ariaHidden: "true" });
        chevron.textContent = expanded ? "⌄" : "›";
        gutter?.appendChild(chevron);
        const actionText = formatTemplate(text(expanded ? "modelEffortCollapse" : "modelEffortExpand"), row.label);
        item.title = String(row.label);
        item.setAttribute("aria-label", actionText);
        item.addEventListener("click", () => toggleExpandedModel(row.id, item));
      }
      entry.appendChild(item);
      if (expandable && expandedModelIds.includes(row.id)) entry.appendChild(renderModelEffortPanel(row));
      group.appendChild(entry);
    });
    appendBreakdownOmitted(group, model.models, rows);
    return group;
  }

  function renderModelEffortPanel(row) {
    const panel = el("section", {
      id: `model-effort-${row.id}`,
      className: "modelEffortPanel",
      ariaLabel: formatTemplate(text("modelEffortPanelLabel"), row.label),
    });
    const heading = el("h4", {});
    heading.textContent = text("modelEffortBreakdown");
    panel.appendChild(heading);
    if (breakdownMetric === "totalTokens" && row.effortTotalTokens !== row.metrics.totalTokens) {
      const coverage = el("p", { className: "modelEffortCoverage muted" });
      coverage.textContent = formatTemplate(
        text("modelEffortCoverage"),
        formatNumber(row.effortTotalTokens),
        formatNumber(row.metrics.totalTokens),
      );
      coverage.title = coverage.textContent;
      panel.appendChild(coverage);
    }
    row.effortRows.forEach((effort) => {
      const item = renderBarRow("modelEffort", effort, row.effortTotalTokens, false);
      item.classList.add("effortBarRow");
      panel.appendChild(item);
    });
    if (row.omittedEffortCount > 0) {
      const omitted = el("p", { className: "modelEffortOmitted muted" });
      omitted.textContent = formatTemplate(text("modelEffortOmitted"), formatNumber(row.omittedEffortCount));
      panel.appendChild(omitted);
    }
    return panel;
  }

  function toggleExpandedModel(modelId, trigger) {
    const next = nextExpandedModelIds(expandedModelIds, modelId, model.models.rows);
    if (next.length === expandedModelIds.length && next.every((id, index) => id === expandedModelIds[index])) return;
    const row = model.models.rows.find((candidate) => candidate.id === modelId);
    const entry = trigger.closest(".modelBreakdownEntry");
    if (!row || !entry) return;
    const beforeTop = trigger.getBoundingClientRect().top;
    expandedModelIds = next;
    persistState();
    const expanded = expandedModelIds.includes(modelId);
    trigger.setAttribute("aria-expanded", String(expanded));
    const chevron = trigger.querySelector(".modelChevron");
    if (chevron) chevron.textContent = expanded ? "⌄" : "›";
    const actionText = formatTemplate(text(expanded ? "modelEffortCollapse" : "modelEffortExpand"), row.label);
    trigger.setAttribute("aria-label", actionText);
    const currentPanel = entry.querySelector(`#model-effort-${modelId}`);
    if (expanded && !currentPanel) entry.appendChild(renderModelEffortPanel(row));
    if (!expanded && currentPanel) currentPanel.remove();
    requestAnimationFrame(() => {
      const delta = calculateScrollAnchorDelta(beforeTop, trigger.getBoundingClientRect().top);
      if (delta !== 0) window.scrollBy(0, delta);
      trigger.focus({ preventScroll: true });
      persistState();
    });
  }

  function formatBreakdownLabel(titleKey, rawLabel) {
    const label = String(rawLabel || "").slice(0, titleKey === "models" ? 512 : 80);
    if (titleKey === "sources") return text(`source.${label}`) || label;
    if (titleKey === "modelEffort") return label;
    return label === "unknown" ? text("unknown") : label;
  }

  function renderProjectList() {
    const rowsForMetric = selectBreakdownRows(model.projects, breakdownMetric);
    const group = renderBarList("projects", model.projects);
    const rows = Array.from(group.querySelectorAll(".barRow"));
    rows.forEach((row, index) => {
      const project = rowsForMetric[index];
      if (!project || !project.canDrillDown) return;
      const actions = el("span", { className: "rowActions projectRowActions" });
      const historyButton = iconActionButton(
        "showInHistory",
        "history",
        () => vscode.postMessage({ type: "showProject", id: project.id }),
        false,
        true,
      );
      const searchButton = iconActionButton(
        "searchProject",
        "search",
        () => vscode.postMessage({ type: "searchProject", id: project.id }),
        false,
        true,
      );
      historyButton.classList.add("projectRowAction");
      searchButton.classList.add("projectRowAction");
      actions.append(
        historyButton,
        searchButton,
      );
      row.appendChild(actions);
    });
    return group;
  }

  function appendBreakdownOmitted(container, breakdownGroup, visibleRows) {
    const visiblePositive = visibleRows.filter((row) => row.metrics[breakdownMetric] > 0).length;
    const omittedCount = Math.max(0, breakdownGroup.positiveRowCounts[breakdownMetric] - visiblePositive);
    if (omittedCount === 0) return;
    const omitted = el("p", { className: "breakdownOmitted muted" });
    omitted.textContent = formatTemplate(text("breakdownOmitted"), formatNumber(omittedCount));
    container.appendChild(omitted);
  }

  function renderQuality() {
    const { section, summary, chevron } = createCollapsiblePanel("quality", "dataQuality", "qualityPanel accentYellow");
    const coverage = model.quality.targetSessions > 0
      ? Math.max(0, Math.min(100, Math.round((model.quality.analyzedSessions / model.quality.targetSessions) * 100)))
      : 0;
    const badge = el("span", { className: "qualityBadge" });
    badge.textContent = formatTemplate(text("qualityCoverageBadge"), coverage);
    summary.classList.add("hasBadge");
    summary.insertBefore(badge, chevron);
    const callout = el("div", { className: "qualityCallout" });
    const info = el("span", { className: "qualityInfoMark", ariaHidden: "true" });
    info.textContent = "i";
    const explanations = el("div", { className: "qualityExplanations" });
    const qualityHint = el("p", {});
    qualityHint.textContent = text("qualityExplanation");
    const fileMetricHint = el("p", {});
    fileMetricHint.textContent = text("qualityFileExplanation");
    explanations.append(qualityHint, fileMetricHint);
    if (model.quality.numericOverflow) {
      const numericOverflowHint = el("p", {});
      numericOverflowHint.textContent = text("qualityNumericOverflow");
      explanations.appendChild(numericOverflowHint);
    }
    callout.append(info, explanations);
    section.appendChild(callout);
    const groups = el("div", { className: "qualityGroups" });
    groups.append(
      renderQualityGroup("qualityAnalysisGroup", [
        ["qualityTarget", model.quality.targetSessions], ["qualityAnalyzed", model.quality.analyzedSessions],
        ["qualityCacheHits", model.quality.cacheHitCount], ["qualityRebuilt", model.quality.rebuiltCount],
      ]),
      renderQualityGroup("qualityIssuesGroup", [
        ["qualityFailed", model.quality.failedSessions], ["qualityUnsupported", model.quality.unsupportedSessions],
        ["qualityPartial", model.quality.partialSessions],
      ]),
      renderQualityGroup("qualityAvailabilityGroup", [
        ["qualityToken", model.quality.tokenAvailableSessions], ["qualityFile", model.quality.fileChangeAvailableSessions],
        ["qualityModel", model.quality.modelAvailableSessions], ["qualityTool", model.quality.toolAvailableSessions],
      ]),
    );
    section.appendChild(groups);
    return section;
  }

  function renderQualityGroup(titleKey, values) {
    const group = el("section", { className: "qualityGroup" });
    const title = el("h3", {});
    title.textContent = text(titleKey);
    const list = el("dl", { className: "qualityList" });
    values.forEach(([key, value]) => {
      const term = el("dt", {});
      term.textContent = text(key);
      const detail = el("dd", {});
      detail.textContent = formatNumber(value);
      list.append(term, detail);
    });
    group.append(title, list);
    return group;
  }

  function titleRow() {
    const row = el("div", { className: "statePanelTitleRow" });
    if (extensionIcon) {
      const icon = el("span", { className: "statePanelIcon", ariaHidden: "true" });
      icon.style.setProperty("--state-panel-icon", `url("${extensionIcon}")`);
      row.appendChild(icon);
    }
    const title = el("h1", {});
    title.textContent = text("title");
    row.appendChild(title);
    return row;
  }

  function actionButton(key, handler, primary) {
    const button = el("button", { type: "button", className: primary ? "primaryBtn" : "" });
    button.textContent = text(key);
    button.addEventListener("click", handler);
    return button;
  }

  function createCollapsiblePanel(panelKey, titleKey, className) {
    const section = el("details", { className: `contentPanel collapsiblePanel ${className}` });
    section.open = panelExpansion[panelKey] === true;
    const summary = el("summary", { className: "collapsibleSummary" });
    const title = el("span", { className: "collapsibleTitle" });
    title.textContent = text(titleKey);
    const chevron = el("span", { className: "collapseChevron", ariaHidden: "true" });
    chevron.textContent = "›";
    summary.append(title, chevron);
    section.appendChild(summary);
    section.addEventListener("toggle", () => {
      panelExpansion = { ...panelExpansion, [panelKey]: section.open };
      persistState();
    });
    return { section, summary, chevron };
  }

  function iconActionButton(key, iconKind, handler, primary, iconOnly) {
    const button = el("button", { type: "button", className: `${primary ? "primaryBtn " : ""}iconActionButton${iconOnly ? " iconOnly" : ""}` });
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "actionIcon");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    const iconPaths = {
      reload: "M13.2 5.9A5.6 5.6 0 1 0 13 10.5M13.2 2.7v3.5H9.7",
      importHistory: "M3 2.5v11M6 8h7M10.5 4.5 14 8l-3.5 3.5",
      applyHistory: "M13 2.5v11M10 8H3m3.5-3.5L3 8l3.5 3.5",
      filter: "M2.2 3h11.6L9.4 8v4.2l-2.8 1.3V8L2.2 3Z",
      close: "M3.5 3.5l9 9m0-9-9 9",
      history: "M3.8 3.8A5.6 5.6 0 1 1 2.4 8M3.8 1.6v2.8H1M8 4.5V8l2.4 1.4",
      search: "M7 2.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2Zm3.3 8.3 3.3 3.3",
    };
    path.setAttribute("d", iconPaths[iconKind] || iconPaths.applyHistory);
    icon.appendChild(path);
    const label = el("span", { className: "actionLabel" });
    label.textContent = text(key);
    button.append(icon, label);
    if (iconOnly) {
      button.title = label.textContent;
      button.setAttribute("aria-label", label.textContent);
    }
    button.addEventListener("click", handler);
    return button;
  }

  function segmentedControl(values, selected, labelOf, onSelect, className) {
    const group = el("div", { className: `segmentedControl ${className || ""}`, role: "group" });
    values.forEach((value) => {
      const button = el("button", { type: "button", className: value === selected ? "selected" : "" });
      button.textContent = labelOf(value);
      button.setAttribute("aria-pressed", String(value === selected));
      button.addEventListener("click", () => {
        if (value !== selected) onSelect(value);
      });
      group.appendChild(button);
    });
    return group;
  }

  function compareFiles(left, right) {
    return compareFilesByMode(left, right, fileSort);
  }

  function compareFilesByMode(left, right, sortMode) {
    const normalizedSort = normalizeFileSort(sortMode);
    const lineCount = (file) =>
      addSafeValidatedIntegers(nonNegativeInteger(file.linesAdded), nonNegativeInteger(file.linesRemoved));
    const projectName = (file) => String(file.projectContexts?.[0]?.displayName || "");
    const finalTie = () => projectName(left).localeCompare(projectName(right)) ||
      String(left.displayPath || "").localeCompare(String(right.displayPath || "")) ||
      String(left.id || "").localeCompare(String(right.id || ""));
    const applyDirection = (comparison) => normalizedSort.direction === "asc" ? comparison : -comparison;
    let comparison = 0;
    if (normalizedSort.key === "recent") {
      const leftTime = validDateTime(left.lastTimestampIso);
      const rightTime = validDateTime(right.lastTimestampIso);
      if (leftTime === null && rightTime !== null) return 1;
      if (leftTime !== null && rightTime === null) return -1;
      if (leftTime !== null && rightTime !== null) comparison = leftTime - rightTime;
    } else if (normalizedSort.key === "name") {
      comparison = projectName(left).localeCompare(projectName(right)) || String(left.displayPath || "").localeCompare(String(right.displayPath || ""));
    } else if (normalizedSort.key === "events") {
      comparison = nonNegativeInteger(left.changeEventCount) - nonNegativeInteger(right.changeEventCount) ||
        nonNegativeInteger(left.sessionCount) - nonNegativeInteger(right.sessionCount);
    } else if (normalizedSort.key === "lines") {
      comparison = lineCount(left) - lineCount(right) ||
        nonNegativeInteger(left.changeEventCount) - nonNegativeInteger(right.changeEventCount);
    } else {
      comparison = nonNegativeInteger(left.sessionCount) - nonNegativeInteger(right.sessionCount) ||
        nonNegativeInteger(left.changeEventCount) - nonNegativeInteger(right.changeEventCount);
    }
    return applyDirection(comparison) || finalTie();
  }

  function calculateBreakdownColumnWidths(formattedValues) {
    const values = (Array.isArray(formattedValues) ? formattedValues : [])
      .filter((value) => value && typeof value === "object");
    const absoluteWidthCh = Math.min(16, Math.max(0, ...values.map((value) => displayWidthCh(value.absoluteText))));
    const percentageWidthCh = Math.min(10, Math.max(0, ...values.map((value) => displayWidthCh(value.percentageText))));
    const separatorWidthCh = absoluteWidthCh > 0 && percentageWidthCh > 0 ? 1 : 0;
    return {
      valueWidthCh: Math.min(27, Math.max(4, absoluteWidthCh + separatorWidthCh + percentageWidthCh)),
      percentageWidthCh,
    };
  }

  function displayWidthCh(value) {
    return Array.from(String(value ?? "")).reduce((width, character) => (
      /[\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(character) ? width + 2 : width + 1
    ), 0);
  }

  function calculateBreakdownShare(value, total) {
    const normalizedTotal = nonNegativeInteger(total);
    if (normalizedTotal === 0) return 0;
    return Math.min(1, nonNegativeInteger(value) / normalizedTotal);
  }

  function formatBreakdownValueParts(value, total) {
    const percentage = formatBreakdownPercentage(value, total, document.documentElement.lang);
    const absoluteText = formatNumber(value);
    return {
      absoluteText,
      percentageText: formatTemplate(text("breakdownPercentage"), percentage),
      accessibleText: formatTemplate(text("breakdownValue"), absoluteText, percentage),
    };
  }

  function formatBreakdownPercentage(value, total, language) {
    const share = calculateBreakdownShare(value, total);
    const formatter = new Intl.NumberFormat(normalizeUiLanguage(language), {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return share > 0 && share < 0.001
      ? `<${formatter.format(0.001)}`
      : formatter.format(share);
  }

  function activityValue(day) {
    return activityMetricValue(day).value || 0;
  }

  function activityMetricValue(day) {
    if (activityMetric === "requests") return day.userRequestCount;
    if (activityMetric === "inputTokens") return day.inputTokenCount;
    if (activityMetric === "outputTokens") return day.outputTokenCount;
    if (activityMetric === "reasoningTokens") return day.reasoningOutputTokenCount;
    if (activityMetric === "totalTokens") return day.totalTokenCount;
    if (activityMetric === "files") return day.distinctFileCount;
    if (activityMetric === "linesAdded") return day.linesAdded;
    if (activityMetric === "linesRemoved") return day.linesRemoved;
    if (activityMetric === "changedLines") return day.changedLineCount;
    return { value: day.sessionCount || 0, availability: "available", availableSessions: day.sessionCount || 0, totalSessions: day.sessionCount || 0 };
  }

  function shouldUseRefreshToast(hasModel, requested, hostRefreshing) {
    return hasModel === true && (requested === true || hostRefreshing === true);
  }

  function beginRefreshRequest() {
    if (!model || model.refreshing) return;
    refreshRequested = true;
    refreshProgress = null;
    model = { ...model, refreshing: true };
    updateRefreshToast();
    renderModel();
  }

  function updateRefreshToast() {
    if (!shouldUseRefreshToast(Boolean(model), refreshRequested, model?.refreshing === true)) {
      clearRefreshToast();
      return;
    }
    refreshToastMessage = buildRefreshToastText();
    const existing = document.querySelector('[data-insights-toast-key="refresh"]');
    if (existing) {
      if (existing.textContent !== refreshToastMessage) existing.textContent = refreshToastMessage;
      return;
    }
    if (refreshToastTimer !== null) return;
    refreshToastTimer = window.setTimeout(() => {
      refreshToastTimer = null;
      if (!refreshToastMessage || !shouldUseRefreshToast(Boolean(model), refreshRequested, model?.refreshing === true)) return;
      const container = ensureInsightsToastContainer();
      const toast = el("div", { className: "insightsToast", role: "status" });
      toast.dataset.insightsToastKey = "refresh";
      toast.setAttribute("aria-live", "polite");
      toast.textContent = refreshToastMessage;
      container.appendChild(toast);
    }, 300);
  }

  function clearRefreshToast() {
    if (refreshToastTimer !== null) {
      window.clearTimeout(refreshToastTimer);
      refreshToastTimer = null;
    }
    refreshToastMessage = "";
    document.querySelector('[data-insights-toast-key="refresh"]')?.remove();
    const container = document.querySelector(".insightsToastContainer");
    if (container && container.childElementCount === 0) container.remove();
  }

  function ensureInsightsToastContainer() {
    const existing = document.querySelector(".insightsToastContainer");
    if (existing) return existing;
    const container = el("div", { className: "insightsToastContainer", ariaLabel: text("notifications") });
    document.body.appendChild(container);
    return container;
  }

  function showTransientToast(key, message, isError) {
    const safeKey = String(key || "notification").replace(/[^a-z0-9-]/gi, "").slice(0, 48) || "notification";
    document.querySelector(`[data-insights-toast-key="${safeKey}"]`)?.remove();
    const toast = el("div", { className: `insightsToast${isError ? " error" : ""}`, role: isError ? "alert" : "status" });
    toast.dataset.insightsToastKey = safeKey;
    toast.textContent = String(message || "");
    ensureInsightsToastContainer().appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
      const container = document.querySelector(".insightsToastContainer");
      if (container && container.childElementCount === 0) container.remove();
    }, 5000);
  }

  function buildRefreshToastText() {
    const phase = refreshProgress ? text(`progress.${refreshProgress.phase}`) : text("checkingLatest");
    return refreshProgress && refreshProgress.total > 0
      ? `${phase} ${formatTemplate(text("progressCount"), refreshProgress.completed, refreshProgress.total)}`
      : phase;
  }

  function parseYmdUtc(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && formatYmdUtc(date) === value ? date : null;
  }

  function normalizeDateRangeInput(fromValue, toValue) {
    const fromText = typeof fromValue === "string" ? fromValue.trim() : "";
    const toText = typeof toValue === "string" ? toValue.trim() : "";
    if ((fromText && !parseYmdUtc(fromText)) || (toText && !parseYmdUtc(toText))) {
      return { valid: false, error: "invalid", from: null, to: null };
    }
    const from = fromText || null;
    const to = toText || null;
    if (from && to && from > to) return { valid: false, error: "order", from, to };
    return { valid: true, from, to };
  }

  function addUtcDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
  }

  function isoWeekdayIndex(date) {
    return (date.getUTCDay() + 6) % 7;
  }

  function calculateIsoWeekLayout(values) {
    const dates = Array.from(new Set((Array.isArray(values) ? values : []).filter((value) => parseYmdUtc(value))))
      .sort()
      .map(parseYmdUtc)
      .filter(Boolean);
    if (dates.length === 0) return { weekStarts: [], placements: {} };
    const weekStart = addUtcDays(dates[0], -isoWeekdayIndex(dates[0]));
    const lastWeekStart = addUtcDays(dates[dates.length - 1], -isoWeekdayIndex(dates[dates.length - 1]));
    const weekCount = Math.floor((lastWeekStart.getTime() - weekStart.getTime()) / 604800000) + 1;
    const weekStarts = Array.from({ length: Math.max(1, weekCount) }, (_value, index) => formatYmdUtc(addUtcDays(weekStart, index * 7)));
    const placements = {};
    dates.forEach((date) => {
      const ymd = formatYmdUtc(date);
      placements[ymd] = {
        week: Math.floor((date.getTime() - weekStart.getTime()) / 604800000),
        weekday: isoWeekdayIndex(date),
      };
    });
    return { weekStarts, placements };
  }

  function formatYmdUtc(date) {
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function buildWeekdayLabels() {
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_value, day) => formatter.format(new Date(Date.UTC(2023, 0, 2 + day))));
  }

  function formatYear(date) {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", timeZone: "UTC" }).format(date);
  }

  function formatMonth(date) {
    return new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(date);
  }

  function formatFullDate(date) {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(date);
  }

  function resolveMetricPresentation(metric, unknownLabel, formatter) {
    if (!metric || !["available", "partial"].includes(metric.availability) || typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0) {
      return { kind: "unavailable", valueText: String(unknownLabel ?? "") };
    }
    const format = typeof formatter === "function"
      ? formatter
      : (value) => String(Math.max(0, Math.floor(value)));
    return {
      kind: metric.availability === "partial" ? "partial" : "available",
      valueText: String(format(metric.value)),
    };
  }

  function metricAccessibleText(metric) {
    const presentation = resolveMetricPresentation(metric, text("unknown"), formatNumber);
    return presentation.kind === "partial"
      ? formatTemplate(text("lowerBoundAria"), presentation.valueText)
      : presentation.valueText;
  }

  function appendMetricPresentation(container, metric, showLowerBoundBadge = true) {
    const presentation = resolveMetricPresentation(metric, text("unknown"), formatNumber);
    if (presentation.kind === "partial") {
      if (showLowerBoundBadge) {
        container.appendChild(createMetricLowerBoundBadge(presentation.valueText));
      }
      const number = el("span", { className: "metricNumber" });
      number.textContent = presentation.valueText;
      container.appendChild(number);
      const accessible = formatTemplate(text("lowerBoundAria"), presentation.valueText);
      container.title = accessible;
      container.setAttribute("aria-label", accessible);
      return presentation;
    }
    container.textContent = presentation.valueText;
    return presentation;
  }

  function createMetricLowerBoundBadge(valueText) {
    const badge = el("span", { className: "metricLowerBoundBadge", ariaHidden: "true" });
    const accessible = formatTemplate(text("lowerBoundAria"), valueText);
    badge.textContent = "≥";
    badge.title = accessible;
    return badge;
  }

  function normalizeModel(value) {
    if (!value || typeof value !== "object" || value.version !== 1) return null;
    if (!value.metrics || !isQualityPayload(value.quality) ||
      typeof value.refreshing !== "boolean" || typeof value.stale !== "boolean") return null;
    if (!["sessions", "userRequests", "inputTokens", "outputTokens", "totalTokens", "distinctFiles", "linesAdded", "linesRemoved", "changeEvents", "reasoningOutputTokens"]
      .every((key) => isMetricPayload(value.metrics[key]))) return null;
    if (!safeArray(value.days, 40000) || !safeArray(value.files, 500)) return null;
    if (!isBreakdownGroup(value.sources, (row) => isBreakdownRow(row, 80), value.quality.numericOverflow) ||
      !isBreakdownGroup(
        value.models,
        (row) => isModelBreakdownRow(row, value.quality.numericOverflow),
        value.quality.numericOverflow,
      ) ||
      !isBreakdownGroup(
        value.projects,
        (row) => isBreakdownRow(row, 512) && typeof row.canDrillDown === "boolean",
        value.quality.numericOverflow,
      )) return null;
    if (!value.days.every((day) => day && /^\d{4}-\d{2}-\d{2}$/.test(String(day.ymd || "")) &&
      Number.isSafeInteger(day.sessionCount) && day.sessionCount >= 0 &&
      [day.userRequestCount, day.inputTokenCount, day.outputTokenCount, day.reasoningOutputTokenCount, day.totalTokenCount, day.distinctFileCount, day.linesAdded, day.linesRemoved, day.changedLineCount].every(isMetricPayload))) return null;
    if (!value.files.every((file) => file && /^[a-f0-9]{24}$/.test(String(file.id || "")) &&
      typeof file.canOpenFileHistory === "boolean" && typeof file.canOpenFile === "boolean" &&
      [file.projectContextCount, file.sessionCount, file.changeEventCount, file.linesAdded, file.linesRemoved]
        .every((metric) => Number.isSafeInteger(metric) && metric >= 0) &&
      safeArray(file.projectContexts, 3) &&
      file.projectContexts.every((context) =>
        context && Number.isSafeInteger(context.sessionCount) && context.sessionCount >= 0) &&
      file.projectContextCount >= file.projectContexts.length)) return null;
    if (!isToolGroup(value.tools) || !safeArray(value.activeSessions, 80) ||
      !value.activeSessions.every(isActiveSessionRow) || !isUsageDetails(value.usageDetails)) return null;
    value.files.forEach((file) => {
      file.fileKind = normalizeFileKind(file.fileKind);
      file.projectContexts = file.projectContexts.map((context) => ({
        displayName: typeof context?.displayName === "string" && context.displayName ? context.displayName.slice(0, 120) : text("fileProjectUnknown"),
        pathHint: typeof context?.pathHint === "string" ? context.pathHint.slice(0, 80) : "",
        sessionCount: nonNegativeInteger(context?.sessionCount),
        disambiguate: context?.disambiguate === true,
      }));
    });
    return value;
  }

  function normalizeFileKind(value) {
    return ["pdf", "word", "excel", "powerpoint", "text", "code", "archive", "image", "generic"].includes(value)
      ? value
      : "generic";
  }

  function isMetricPayload(value) {
    if (!value || typeof value !== "object") return false;
    if (!["available", "partial", "unavailable"].includes(value.availability)) return false;
    if (!Number.isSafeInteger(value.availableSessions) || value.availableSessions < 0) return false;
    if (!Number.isSafeInteger(value.totalSessions) || value.totalSessions < 0) return false;
    return value.value === undefined || (Number.isSafeInteger(value.value) && value.value >= 0);
  }

  function isQualityPayload(value) {
    if (!value || typeof value !== "object" || typeof value.numericOverflow !== "boolean") return false;
    return [
      value.targetSessions,
      value.analyzedSessions,
      value.cacheHitCount,
      value.rebuiltCount,
      value.failedSessions,
      value.unsupportedSessions,
      value.partialSessions,
      value.tokenAvailableSessions,
      value.fileChangeAvailableSessions,
      value.modelAvailableSessions,
      value.toolAvailableSessions,
    ].every((metric) => Number.isSafeInteger(metric) && metric >= 0);
  }

  function isBreakdownRow(value, maxLabelLength) {
    return Boolean(value && typeof value === "object" &&
      /^[a-f0-9]{24}$/.test(String(value.id || "")) &&
      typeof value.label === "string" && value.label.length > 0 && value.label.length <= maxLabelLength &&
      isBreakdownMetricValues(value.metrics));
  }

  function isToolGroup(value) {
    if (!value || typeof value !== "object" || !safeArray(value.rows, 128)) return false;
    if (![value.totals?.calls, value.totals?.sessions, value.positiveRowCounts?.calls, value.positiveRowCounts?.sessions]
      .every((metric) => Number.isSafeInteger(metric) && metric >= 0)) return false;
    const ids = new Set();
    return value.rows.every((row) => row && /^[a-f0-9]{24}$/.test(String(row.id || "")) &&
      typeof row.label === "string" && row.label.length > 0 && row.label.length <= 256 &&
      Number.isSafeInteger(row.calls) && row.calls >= 0 && Number.isSafeInteger(row.sessions) && row.sessions >= 0 &&
      !ids.has(row.id) && Boolean(ids.add(row.id)));
  }

  function isActiveSessionRow(value) {
    if (!value || typeof value !== "object" || !/^[a-f0-9]{24}$/.test(String(value.id || "")) ||
      typeof value.title !== "string" || value.title.length === 0 || value.title.length > 512 ||
      !["codex", "claude"].includes(value.source) || typeof value.projectLabel !== "string" ||
      value.projectLabel.length > 512 || !value.metrics) return false;
    return ["userRequests", "toolCalls", "reasoningTokens", "totalTokens", "changedLines"].every((metric) => {
      const item = value.metrics[metric];
      return item && ["available", "partial", "unavailable"].includes(item.availability) &&
        (item.value === undefined || (Number.isSafeInteger(item.value) && item.value >= 0));
    });
  }

  function isUsageDetails(value) {
    if (!value || typeof value !== "object") return false;
    const expected = {
      inputCache: ["cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"],
      messages: ["userMessages", "assistantMessages", "developerMessages", "toolCalls", "toolOutputs"],
      turns: ["turns", "completedTurns", "interruptedTurns", "rolledBackTurns"],
    };
    for (const [group, keys] of Object.entries(expected)) {
      if (!safeArray(value[group], keys.length) || value[group].length !== keys.length) return false;
      if (!value[group].every((row, index) => row && row.key === keys[index] && isMetricPayload(row.metric))) return false;
    }
    if (!safeArray(value.fileKinds, 9)) return false;
    const kinds = new Set();
    return value.fileKinds.every((row) =>
      row && ["pdf", "word", "excel", "powerpoint", "text", "code", "archive", "image", "generic"].includes(row.kind) &&
      !kinds.has(row.kind) && Boolean(kinds.add(row.kind)) &&
      Number.isSafeInteger(row.distinctFileCount) && row.distinctFileCount >= 0 &&
      Number.isSafeInteger(row.changeEventCount) && row.changeEventCount >= 0);
  }

  function isBreakdownMetricValues(value) {
    return Boolean(value && typeof value === "object" &&
      [value.sessions, value.inputTokens, value.outputTokens, value.totalTokens]
        .every((metric) => Number.isSafeInteger(metric) && metric >= 0));
  }

  function isBreakdownGroup(value, rowValidator, allowSaturatedTotals = false) {
    if (!value || typeof value !== "object" || !safeArray(value.rows, 128) ||
      !isBreakdownMetricValues(value.totals) || !isBreakdownMetricValues(value.positiveRowCounts)) return false;
    const ids = new Set();
    const candidateTotals = { sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const candidatePositiveCounts = { sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const row of value.rows) {
      if (!rowValidator(row) || ids.has(row.id)) return false;
      ids.add(row.id);
      for (const metric of ["sessions", "inputTokens", "outputTokens", "totalTokens"]) {
        if (candidateTotals[metric] > Number.MAX_SAFE_INTEGER - row.metrics[metric] &&
          !allowSaturatedTotals) return false;
        candidateTotals[metric] = addSafeValidatedIntegers(candidateTotals[metric], row.metrics[metric]);
        if (candidateTotals[metric] > value.totals[metric]) return false;
        if (row.metrics[metric] > 0) candidatePositiveCounts[metric] += 1;
        if (candidatePositiveCounts[metric] > value.positiveRowCounts[metric]) return false;
      }
    }
    return ["sessions", "inputTokens", "outputTokens", "totalTokens"].every((metric) =>
      (value.totals[metric] === 0) === (value.positiveRowCounts[metric] === 0) &&
      value.positiveRowCounts[metric] <= value.totals[metric] &&
      candidatePositiveCounts[metric] >= Math.min(32, value.positiveRowCounts[metric]),
    );
  }

  function isModelBreakdownRow(value, allowSaturatedTotals = false) {
    if (!isBreakdownRow(value, 512) || !safeArray(value.effortRows, 32) ||
      !Number.isSafeInteger(value.effortTotalTokens) || value.effortTotalTokens < 0 ||
      value.effortTotalTokens > value.metrics.totalTokens ||
      !Number.isSafeInteger(value.omittedEffortCount) || value.omittedEffortCount < 0) return false;
    const ids = new Set();
    const labels = new Set();
    let visibleTotal = 0;
    for (const effort of value.effortRows) {
      if (!effort || typeof effort !== "object" || !/^[a-f0-9]{24}$/.test(String(effort.id || "")) ||
        typeof effort.label !== "string" || effort.label.length === 0 || effort.label.length > 80 ||
        !Number.isSafeInteger(effort.value) || effort.value <= 0 || ids.has(effort.id) || labels.has(effort.label)) return false;
      ids.add(effort.id);
      labels.add(effort.label);
      if (visibleTotal > Number.MAX_SAFE_INTEGER - effort.value && !allowSaturatedTotals) return false;
      visibleTotal = addSafeValidatedIntegers(visibleTotal, effort.value);
    }
    if (value.effortRows.length === 0) return value.effortTotalTokens === 0 && value.omittedEffortCount === 0;
    return value.omittedEffortCount === 0
      ? visibleTotal === value.effortTotalTokens
      : visibleTotal < value.effortTotalTokens ||
        (allowSaturatedTotals &&
          visibleTotal === Number.MAX_SAFE_INTEGER &&
          value.effortTotalTokens === Number.MAX_SAFE_INTEGER);
  }

  function addSafeValidatedIntegers(left, right) {
    return left > Number.MAX_SAFE_INTEGER - right
      ? Number.MAX_SAFE_INTEGER
      : left + right;
  }

  function initialExpandedModelIds(value, legacyValue) {
    const candidates = Array.isArray(value) ? value : value === undefined ? [legacyValue] : [];
    const ids = [];
    for (const candidate of candidates) {
      const id = sanitizeEntityId(candidate);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= 32) break;
    }
    return ids;
  }

  function resolveExpandedModelIds(value, models, legacyValue) {
    const selected = new Set(initialExpandedModelIds(value, legacyValue));
    if (!Array.isArray(models)) return [];
    return models
      .filter((row) => selected.has(row?.id) && Array.isArray(row.effortRows) && row.effortRows.length > 0 && row.effortTotalTokens > 0)
      .map((row) => row.id)
      .slice(0, 32);
  }

  function nextExpandedModelIds(current, requested, models) {
    const currentIds = resolveExpandedModelIds(current, models);
    const requestedId = sanitizeEntityId(requested);
    const expandable = Array.isArray(models) && models.some((row) =>
      row?.id === requestedId && Array.isArray(row.effortRows) && row.effortRows.length > 0 && row.effortTotalTokens > 0,
    );
    if (!expandable) return currentIds;
    const next = currentIds.includes(requestedId)
      ? currentIds.filter((id) => id !== requestedId)
      : [...currentIds, requestedId];
    return resolveExpandedModelIds(next, models);
  }

  function normalizeBreakdownMetric(value) {
    return ["sessions", "inputTokens", "outputTokens", "totalTokens"].includes(value) ? value : "totalTokens";
  }

  function normalizeUiLanguage(value) {
    return String(value || "").trim().toLowerCase().startsWith("ja") ? "ja" : "en";
  }

  function selectBreakdownRows(group, metricValue) {
    const metric = normalizeBreakdownMetric(metricValue);
    if (!group || !Array.isArray(group.rows)) return [];
    return group.rows.slice()
      .sort((left, right) => nonNegativeInteger(right?.metrics?.[metric]) - nonNegativeInteger(left?.metrics?.[metric]) ||
        String(left?.label ?? "").localeCompare(String(right?.label ?? "")) ||
        String(left?.id ?? "").localeCompare(String(right?.id ?? "")))
      .slice(0, 32);
  }

  function calculateScrollAnchorDelta(beforeTop, afterTop) {
    const before = Number(beforeTop);
    const after = Number(afterTop);
    return Number.isFinite(before) && Number.isFinite(after) ? after - before : 0;
  }

  function normalizeFilters(value) {
    const raw = value && typeof value === "object" ? value : {};
    const source = raw.source === "codex" || raw.source === "claude" ? raw.source : "all";
    const archiveLocation = raw.archiveLocation === "all" || raw.archiveLocation === "archivedOnly" ? raw.archiveLocation : "activeOnly";
    const normalizedRange = normalizeDateRangeInput(raw.dateRange?.from ?? "", raw.dateRange?.to ?? "");
    const dateRange = normalizedRange.valid ? { from: normalizedRange.from, to: normalizedRange.to } : { from: null, to: null };
    const tags = safeArray(raw.tags, 12) ? raw.tags.filter((tag) => typeof tag === "string" && tag.length <= 256) : [];
    const rawOptions = raw.options && typeof raw.options === "object" ? raw.options : {};
    return {
      source,
      dateRange,
      archiveLocation,
      projectsLabel: typeof raw.projectsLabel === "string" ? raw.projectsLabel.slice(0, 512) : "",
      projectSelectionKind: raw.projectSelectionKind === "none" || raw.projectSelectionKind === "groups" ? raw.projectSelectionKind : "all",
      tags,
      canEditSource: raw.canEditSource === true,
      canEditArchiveLocation: raw.canEditArchiveLocation === true,
      options: {
        source: normalizeFilterOptions(rawOptions.source, 2),
        archiveLocation: normalizeFilterOptions(rawOptions.archiveLocation, 2),
        projects: normalizeFilterOptions(rawOptions.projects, 251),
        tags: normalizeFilterOptions(rawOptions.tags, 500),
      },
    };
  }

  function normalizeFilterOptions(value, maximum) {
    if (!safeArray(value, maximum)) return [];
    const seen = new Set();
    const options = [];
    value.forEach((candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const id = sanitizeEntityId(candidate.id);
      const label = typeof candidate.label === "string" ? candidate.label.slice(0, 512) : "";
      if (!id || !label || seen.has(id)) return;
      seen.add(id);
      options.push({
        id,
        label,
        selected: candidate.selected === true,
        kind: candidate.kind === "all" ? "all" : candidate.kind === "group" ? "group" : undefined,
        description: typeof candidate.description === "string" ? candidate.description.slice(0, 512) : "",
        searchText: typeof candidate.searchText === "string" ? candidate.searchText.slice(0, 2048) : "",
        memberCount: nonNegativeInteger(candidate.memberCount),
        current: candidate.current === true,
        value: typeof candidate.value === "string" ? candidate.value.slice(0, 128) : "",
        section: candidate.section === "current" || candidate.section === "related" || candidate.section === "projects" ? candidate.section : undefined,
      });
    });
    return options;
  }

  function filterSourceValue(source) {
    if (source === "codex") return text("source.codex");
    if (source === "claude") return text("source.claude");
    return text("filterAll");
  }

  function filterLocationValue(value) {
    if (value.source === "claude") return text("filterNotApplicable");
    if (value.archiveLocation === "all") return text("filterLocationAll");
    if (value.archiveLocation === "archivedOnly") return text("filterLocationArchived");
    return text("filterLocationActive");
  }

  function normalizeProgress(value) {
    const raw = value && typeof value === "object" ? value : {};
    const phases = new Set(["loadCache", "collectSessions", "analyzeSessions", "aggregate", "render"]);
    return {
      phase: phases.has(raw.phase) ? raw.phase : "loadCache",
      completed: nonNegativeInteger(raw.completed),
      total: nonNegativeInteger(raw.total),
      cancellable: raw.cancellable === true,
    };
  }

  function safeArray(value, max) {
    return Array.isArray(value) && value.length <= max;
  }

  function nonNegativeInteger(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(numeric)))
      : 0;
  }

  function normalizeActivityMetric(value) {
    if (value === "tokens") return "totalTokens";
    if (value === "lines") return "changedLines";
    return ["sessions", "requests", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "files", "linesAdded", "linesRemoved", "changedLines"].includes(value)
      ? value
      : "sessions";
  }

  function normalizeFileSort(value) {
    const keys = new Set(["sessions", "events", "lines", "recent", "name"]);
    if (typeof value === "string") {
      const key = keys.has(value) ? value : "sessions";
      return { key, direction: key === "name" ? "asc" : "desc" };
    }
    const raw = value && typeof value === "object" ? value : {};
    const key = keys.has(raw.key) ? raw.key : "sessions";
    const direction = raw.direction === "asc" || raw.direction === "desc"
      ? raw.direction
      : key === "name" ? "asc" : "desc";
    return { key, direction };
  }

  function normalizePanelExpansion(value) {
    const raw = value && typeof value === "object" ? value : {};
    return {
      activity: typeof raw.activity === "boolean" ? raw.activity : true,
      files: typeof raw.files === "boolean" ? raw.files : false,
      tools: typeof raw.tools === "boolean" ? raw.tools : false,
      activeSessions: typeof raw.activeSessions === "boolean" ? raw.activeSessions : false,
      usageDetails: typeof raw.usageDetails === "boolean" ? raw.usageDetails : false,
      breakdown: typeof raw.breakdown === "boolean" ? raw.breakdown : false,
      quality: typeof raw.quality === "boolean" ? raw.quality : false,
    };
  }

  function sanitizeEntityId(value) {
    const id = typeof value === "string" ? value.trim() : "";
    return /^[a-f0-9]{24}$/.test(id) ? id : "";
  }

  function text(key) {
    return typeof i18n[key] === "string" ? i18n[key] : "";
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(nonNegativeInteger(value));
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "";
  }

  function formatFullDateTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date) : text("unknown");
  }

  function validDateTime(value) {
    const timestamp = typeof value === "string" && value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function formatTemplate(template) {
    const args = Array.prototype.slice.call(arguments, 1);
    return String(template || "").replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)] ?? ""));
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function persistState() {
    captureScrollPosition();
    if (typeof vscode.setState === "function") vscode.setState({
      snapshotId,
      activityMetric,
      breakdownMetric,
      toolMetric,
      activeSessionMetric,
      fileSort,
      selectedFileId,
      panelExpansion,
      expandedModelIds,
      applyToHistoryPreference,
      scrollTop: preservedScrollTop,
      heatmapScrollLeft,
    });
  }

  function restoreScroll() {
    requestAnimationFrame(() => window.scrollTo(0, preservedScrollTop));
  }

  function captureScrollPosition() {
    const hasInsightsShell = Boolean(app?.querySelector(".insightsShell"));
    const heatmapScroller = app?.querySelector(".heatmapScroller");
    const fileList = app?.querySelector(".fileList");
    if (heatmapScroller) heatmapScrollLeft = Math.max(0, heatmapScroller.scrollLeft);
    if (fileList) fileListScrollTop = Math.max(0, fileList.scrollTop);
    const current = document.documentElement.scrollTop || document.body.scrollTop || window.scrollY || 0;
    preservedScrollTop = nextPreservedScrollTop(preservedScrollTop, current, hasInsightsShell);
  }

  function nextPreservedScrollTop(previous, current, canCaptureCurrent) {
    const fallback = Number.isFinite(Number(previous)) ? Math.max(0, Number(previous)) : 0;
    if (!canCaptureCurrent) return fallback;
    return Number.isFinite(Number(current)) ? Math.max(0, Number(current)) : fallback;
  }

  function closeActiveFilterDropdown(returnFocus) {
    const active = activeFilterDropdown;
    if (!active) return;
    activeFilterDropdown = null;
    active.menu.hidden = true;
    active.menu.style.left = "";
    active.menu.style.top = "";
    active.menu.style.width = "";
    active.menu.style.maxHeight = "";
    active.wrapper.classList.remove("open");
    active.button.setAttribute("aria-expanded", "false");
    if (returnFocus && active.button.isConnected) active.button.focus({ preventScroll: true });
  }

  function closeActivityMetricDropdown(returnFocus) {
    const active = activeActivityDropdown;
    if (!active) return;
    activeActivityDropdown = null;
    active.menu.hidden = true;
    active.menu.style.left = "";
    active.menu.style.top = "";
    active.menu.style.width = "";
    active.menu.style.maxHeight = "";
    active.trigger.setAttribute("aria-expanded", "false");
    if (returnFocus && active.trigger.isConnected) active.trigger.focus({ preventScroll: true });
  }

  function closeBreakdownMetricDropdown(returnFocus) {
    const active = activeBreakdownMetricDropdown;
    if (!active) return;
    activeBreakdownMetricDropdown = null;
    active.menu.hidden = true;
    active.menu.style.left = "";
    active.menu.style.top = "";
    active.menu.style.width = "";
    active.menu.style.maxHeight = "";
    active.trigger.setAttribute("aria-expanded", "false");
    if (returnFocus && active.trigger.isConnected) active.trigger.focus({ preventScroll: true });
  }

  window.addEventListener("pagehide", persistState);
  window.addEventListener("scroll", () => {
    closeActiveFilterDropdown(false);
    closeActivityMetricDropdown(false);
    closeBreakdownMetricDropdown(false);
    debouncePersistState();
  }, { passive: true });
  window.addEventListener("resize", () => {
    closeActiveFilterDropdown(false);
    closeActivityMetricDropdown(false);
    closeBreakdownMetricDropdown(false);
  }, { passive: true });
  document.addEventListener("pointerdown", (event) => {
    if (activeFilterDropdown && !activeFilterDropdown.wrapper.contains(event.target)) {
      closeActiveFilterDropdown(false);
    }
    if (activeActivityDropdown && !activeActivityDropdown.wrapper.contains(event.target) && !activeActivityDropdown.menu.contains(event.target)) {
      closeActivityMetricDropdown(false);
    }
    if (activeBreakdownMetricDropdown && !activeBreakdownMetricDropdown.wrapper.contains(event.target) && !activeBreakdownMetricDropdown.menu.contains(event.target)) {
      closeBreakdownMetricDropdown(false);
    }
    if (filterOverlay && !filterApplying && !filterOverlay.contains(event.target) && !document.getElementById("insights-filter-button")?.contains(event.target)) {
      closeFilterOverlay(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activeFilterDropdown) {
      event.preventDefault();
      closeActiveFilterDropdown(true);
      return;
    }
    if (activeActivityDropdown) {
      event.preventDefault();
      closeActivityMetricDropdown(true);
      return;
    }
    if (activeBreakdownMetricDropdown) {
      event.preventDefault();
      closeBreakdownMetricDropdown(true);
      return;
    }
    if (filterOverlay && !filterApplying) {
      event.preventDefault();
      closeFilterOverlay(true);
    }
  });

  const debouncePersistState = debounce(persistState, 300);

  function debounce(callback, delay) {
    let timer = 0;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(callback, delay);
    };
  }

  function el(tag, props) {
    const node = document.createElement(tag);
    const values = props || {};
    Object.keys(values).forEach((key) => {
      const value = values[key];
      if (key === "className") node.className = value;
      else if (key === "ariaLabel") node.setAttribute("aria-label", value);
      else if (key === "ariaHidden") node.setAttribute("aria-hidden", value);
      else if (key === "role") node.setAttribute("role", value);
      else if (key === "selected") node.selected = value === true;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  vscode.postMessage({ type: "ready" });
})();
