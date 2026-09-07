(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const persisted = vscode.getState();
  const pendingRequests = new Map();
  const settingStatuses = new Map();
  const settingDrafts = new Map();
  const ABOUT_TAB_IDS = ["version", "license", "thirdParty"];
  const HEADER_COMPACT_GUARD_PX = 8;
  const mobileNavigationMedia = window.matchMedia("(max-width: 760px)");
  let snapshot;
  let activePageId = readPersistedString("activePageId");
  let navigationCollapsed = Boolean(persisted && persisted.navigationCollapsed === true);
  let activeAboutTab = readPersistedAboutTab();
  let mobileNavigationOpen = false;
  let openMultiKey;
  let nextRequestId = 1;
  let globalStatus = "";
  let globalStatusIsError = false;
  let focusMemory;
  let headerResizeObserver;

  if (!app) {
    return;
  }

  headerResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => updateResponsiveHeader())
    : undefined;
  window.addEventListener("resize", updateResponsiveHeader);

  mobileNavigationMedia.addEventListener("change", (event) => {
    if (event.matches || !mobileNavigationOpen) {
      return;
    }
    mobileNavigationOpen = false;
    if (
      focusMemory &&
      focusMemory.kind === "navigation" &&
      (focusMemory.id === "mobile-menu" || focusMemory.id === "mobile-close")
    ) {
      focusMemory = { kind: "content", id: activePageId || "", action: "" };
    }
    render();
  });

  app.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    const kind = event.target.dataset.focusKind;
    if (!kind) {
      return;
    }
    focusMemory = {
      kind,
      id: event.target.dataset.focusId || "",
      action: event.target.dataset.focusAction || ""
    };
  });

  document.addEventListener("click", (event) => {
    if (!openMultiKey || !(event.target instanceof Element) || event.target.closest(".multi-select")) {
      return;
    }
    openMultiKey = undefined;
    render();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileNavigationOpen) {
      mobileNavigationOpen = false;
      focusMemory = { kind: "navigation", id: "mobile-menu", action: "" };
      render();
      return;
    }
    if (event.key === "Escape" && openMultiKey) {
      const settingKey = openMultiKey;
      openMultiKey = undefined;
      focusMemory = { kind: "setting", id: settingKey, action: "primary" };
      render();
      return;
    }
    if (event.key === "Tab" && isMobileNavigationModalOpen()) {
      const focusable = Array.from(
        app.querySelectorAll(".page-navigation button:not(:disabled)")
      ).filter((item) => item instanceof HTMLElement && item.offsetParent !== null);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    if (message.type === "snapshot" && isSnapshot(message.snapshot)) {
      applySnapshot(message.snapshot);
      return;
    }
    if (
      message.type === "updateSucceeded" &&
      isRequestId(message.requestId) &&
      typeof message.message === "string"
    ) {
      finishRequest(message.requestId, message.message, false);
      return;
    }
    if (
      message.type === "updateRejected" &&
      isRequestId(message.requestId) &&
      typeof message.message === "string" &&
      isSnapshot(message.snapshot)
    ) {
      applySnapshot(message.snapshot, false);
      finishRequest(message.requestId, message.message, true);
      return;
    }
    if (message.type === "browseCancelled" && isRequestId(message.requestId)) {
      finishRequest(message.requestId, "", false);
      return;
    }
    if (
      message.type === "actionCompleted" &&
      isRequestId(message.requestId) &&
      typeof message.message === "string"
    ) {
      finishRequest(message.requestId, message.message, false);
      return;
    }
    if (message.type === "actionFailed" && typeof message.message === "string") {
      if (isRequestId(message.requestId)) {
        finishRequest(message.requestId, message.message, true);
      } else {
        globalStatus = message.message;
        globalStatusIsError = true;
        render();
      }
    }
  });

  vscode.postMessage({ type: "ready" });

  function applySnapshot(nextSnapshot, shouldRender) {
    if (snapshot && nextSnapshot.revision < snapshot.revision) {
      return;
    }
    let activePageChanged = false;
    if (snapshot && snapshot.activeTargetId !== nextSnapshot.activeTargetId) {
      settingStatuses.clear();
      openMultiKey = undefined;
    }
    snapshot = nextSnapshot;
    globalStatus = "";
    globalStatusIsError = false;
    document.documentElement.lang = nextSnapshot.language;
    document.title = nextSnapshot.title;
    if (!nextSnapshot.pages.some((page) => page.id === activePageId)) {
      activePageId = nextSnapshot.pages[0] && nextSnapshot.pages[0].id;
      activePageChanged = true;
    }
    persistState();
    if (shouldRender !== false) {
      render(activePageChanged ? { scrollToTop: true } : undefined);
    }
  }

  function render(options) {
    if (!snapshot) {
      return;
    }
    const windowScrollPosition = {
      left: window.scrollX,
      top: window.scrollY
    };
    const contentScrollPosition = readScrollPosition(app.querySelector(".page-content"));
    const navigationScrollPosition = readScrollPosition(app.querySelector(".page-navigation"));
    const scrollToTop = Boolean(options && options.scrollToTop === true);
    headerResizeObserver?.disconnect();
    app.replaceChildren();
    app.classList.toggle("navigation-collapsed", navigationCollapsed);

    const activePage = snapshot.pages.find((page) => page.id === activePageId) || snapshot.pages[0];
    const header = createHeader(activePage);
    const layout = element("div", "settings-layout");
    layout.append(createNavigation(), createPageContent(activePage));
    app.append(header, layout);
    updateResponsiveHeader(header);
    headerResizeObserver?.observe(header);
    const titleBlock = header.querySelector(".title-block");
    if (titleBlock instanceof HTMLElement) {
      headerResizeObserver?.observe(titleBlock);
    }
    if (isMobileNavigationModalOpen()) {
      const backdrop = button("", "navigation-backdrop");
      backdrop.setAttribute("aria-label", snapshot.labels.closeNavigation);
      backdrop.addEventListener("click", () => {
        mobileNavigationOpen = false;
        focusMemory = { kind: "navigation", id: "mobile-menu", action: "" };
        render();
      });
      app.append(backdrop);
    }
    restoreFocus();
    restoreScrollPosition(app.querySelector(".page-content"), {
      left: scrollToTop ? 0 : contentScrollPosition.left,
      top: scrollToTop ? 0 : contentScrollPosition.top
    });
    restoreScrollPosition(app.querySelector(".page-navigation"), navigationScrollPosition);
    window.scrollTo(
      scrollToTop ? 0 : windowScrollPosition.left,
      scrollToTop ? 0 : windowScrollPosition.top
    );
  }

  function updateResponsiveHeader(candidate) {
    const header = candidate instanceof HTMLElement
      ? candidate
      : app.querySelector(".page-header");
    if (!(header instanceof HTMLElement)) {
      return;
    }
    header.classList.remove("compact-brand");
    const titleBlock = header.querySelector(".title-block");
    const fullTitle = header.querySelector(".page-title-full");
    const fullMetadata = header.querySelector(".page-metadata-full");
    if (
      !(titleBlock instanceof HTMLElement) ||
      !(fullTitle instanceof HTMLElement) ||
      !(fullMetadata instanceof HTMLElement) ||
      titleBlock.clientWidth <= 0
    ) {
      return;
    }
    const requiredWidth = Math.max(
      fullTitle.getBoundingClientRect().width,
      fullMetadata.getBoundingClientRect().width
    );
    header.classList.toggle(
      "compact-brand",
      requiredWidth + HEADER_COMPACT_GUARD_PX > titleBlock.clientWidth
    );
  }

  function readScrollPosition(target) {
    return target
      ? { left: target.scrollLeft, top: target.scrollTop }
      : { left: 0, top: 0 };
  }

  function restoreScrollPosition(target, position) {
    if (!target) {
      return;
    }
    target.scrollTo(position.left, position.top);
  }

  function createHeader(activePage) {
    const header = element("header", "page-header");
    const mobileMenu = iconButton("menu", snapshot.labels.openNavigation, "mobile-menu-button");
    setFocusIdentity(mobileMenu, "navigation", "mobile-menu");
    mobileMenu.addEventListener("click", () => {
      mobileNavigationOpen = true;
      focusMemory = { kind: "navigation", id: "mobile-close", action: "" };
      render();
    });

    const brand = element("div", "page-brand");
    const mark = createIcon("extension", "page-brand-icon");
    mark.setAttribute("aria-hidden", "true");
    const titleBlock = element("div", "title-block");
    const title = element("h1", "page-title");
    title.append(
      element("span", "page-title-full", snapshot.title),
      element("span", "page-title-compact", snapshot.compactTitle)
    );
    const metadata = element("div", "page-metadata");
    metadata.append(
      element("span", "page-metadata-full", snapshot.about.headerMetadata),
      element("span", "page-metadata-compact", snapshot.about.compactHeaderVersion)
    );
    titleBlock.append(title, metadata);
    brand.append(mark, titleBlock);
    header.append(mobileMenu, brand);

    if (activePage && activePage.kind === "settings") {
      header.append(createTargetSelector());
    }

    const status = element(
      "div",
      "global-status" + (globalStatusIsError ? " error" : ""),
      globalStatus
    );
    status.setAttribute("role", globalStatusIsError ? "alert" : "status");
    status.setAttribute("aria-live", "polite");
    header.append(status);
    return header;
  }

  function createTargetSelector() {
    const container = element("div", "target-selector");
    const id = "settings-target";
    const label = element("label", "target-label", snapshot.labels.target);
    label.htmlFor = id;
    const select = document.createElement("select");
    select.id = id;
    select.className = "select-control target-control";
    select.disabled = pendingRequests.size > 0;
    setFocusIdentity(select, "target", "target");
    for (const target of snapshot.targets) {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.label;
      option.selected = target.id === snapshot.activeTargetId;
      select.append(option);
    }
    select.addEventListener("change", () => {
      globalStatus = snapshot.labels.saving;
      globalStatusIsError = false;
      select.disabled = true;
      vscode.postMessage({ type: "selectTarget", targetId: select.value });
    });
    container.append(label, select);
    return container;
  }

  function createNavigation() {
    const mobileModalOpen = isMobileNavigationModalOpen();
    const navigation = element(
      "nav",
      "page-navigation" + (mobileModalOpen ? " mobile-open" : "")
    );
    navigation.setAttribute("aria-label", snapshot.labels.navigation);
    if (mobileModalOpen) {
      navigation.setAttribute("role", "dialog");
      navigation.setAttribute("aria-modal", "true");
    }

    const controls = element("div", "navigation-controls");
    const collapseLabel = navigationCollapsed
      ? snapshot.labels.expandNavigation
      : snapshot.labels.collapseNavigation;
    const collapse = iconButton(
      navigationCollapsed ? "panel-open" : "panel-close",
      collapseLabel,
      "navigation-toggle"
    );
    setFocusIdentity(collapse, "navigation", "collapse");
    collapse.addEventListener("click", () => {
      navigationCollapsed = !navigationCollapsed;
      persistState();
      render();
    });
    const mobileClose = iconButton("close", snapshot.labels.closeNavigation, "mobile-close-button");
    setFocusIdentity(mobileClose, "navigation", "mobile-close");
    mobileClose.addEventListener("click", () => {
      mobileNavigationOpen = false;
      focusMemory = { kind: "navigation", id: "mobile-menu", action: "" };
      render();
    });
    controls.append(collapse, mobileClose);
    navigation.append(controls);

    const groups = [
      ["settings", snapshot.labels.navigationSettings],
      ["management", snapshot.labels.navigationManagement],
      ["information", snapshot.labels.navigationInformation]
    ];
    for (const [groupId, groupLabel] of groups) {
      const pages = snapshot.pages.filter((page) => page.group === groupId);
      if (pages.length === 0) {
        continue;
      }
      const group = element("section", "navigation-group");
      group.append(element("div", "navigation-group-label", groupLabel));
      const list = element("div", "navigation-list");
      for (const page of pages) {
        const item = button("", "navigation-item");
        item.title = page.label;
        item.setAttribute("aria-label", page.label);
        setFocusIdentity(item, "page", page.id);
        const pageIcon = createIcon(page.icon, "navigation-item-icon");
        pageIcon.setAttribute("aria-hidden", "true");
        item.append(pageIcon, element("span", "navigation-item-label", page.label));
        if (typeof page.settingCount === "number") {
          item.append(element("span", "navigation-count", String(page.settingCount)));
        }
        if (page.id === activePageId) {
          item.classList.add("active");
          item.setAttribute("aria-current", "page");
        }
        item.addEventListener("click", () => {
          activePageId = page.id;
          mobileNavigationOpen = false;
          openMultiKey = undefined;
          globalStatus = "";
          globalStatusIsError = false;
          focusMemory = { kind: "content", id: page.id, action: "" };
          persistState();
          render({ scrollToTop: true });
        });
        list.append(item);
      }
      group.append(list);
      navigation.append(group);
    }
    return navigation;
  }

  function createPageContent(page) {
    const main = element(
      "main",
      "page-content" + (page && page.kind === "about" ? " about-page" : "")
    );
    if (!page) {
      return main;
    }
    main.tabIndex = -1;
    setFocusIdentity(main, "content", page.id);
    if (page.kind !== "about") {
      const headingBlock = element("div", "content-heading");
      headingBlock.append(element("h2", "content-title", page.label));
      if (typeof page.description === "string" && page.description.length > 0) {
        headingBlock.append(element("p", "content-description", page.description));
      }
      main.append(headingBlock);
    }
    if (page.kind === "maintenance") {
      main.append(createMaintenanceContent());
    } else if (page.kind === "about") {
      main.append(createAboutContent());
    } else {
      main.append(createSettingsContent(page));
    }
    return main;
  }

  function createSettingsContent(page) {
    const container = element("div", "settings-cards");
    const pageSettings = snapshot.settings.filter((setting) => setting.categoryId === page.id);
    const cards = new Map();
    for (const setting of pageSettings) {
      let card = cards.get(setting.card);
      if (!card) {
        card = element("section", "settings-card");
        card.append(element("h3", "card-title", setting.card));
        cards.set(setting.card, card);
        container.append(card);
      }
      card.append(createSettingRow(setting));
    }
    return container;
  }

  function createSettingRow(setting) {
    const row = element("div", "setting-row" + (setting.modified ? " modified" : ""));
    row.dataset.settingKey = setting.key;
    const header = element("div", "setting-header");
    const text = element("div", "setting-text");
    const labelLine = element("div", "setting-label-line");
    labelLine.append(element("div", "setting-label", setting.label));
    appendBadges(labelLine, setting);
    text.append(labelLine, element("p", "setting-description", setting.description));
    header.append(text);

    const controlArea = element("div", "setting-control-area");
    const disabled = Boolean(setting.disabledReason);
    controlArea.append(createControl(setting, disabled));
    const actionSlot = element("div", "setting-action-slot");
    if (setting.canReset) {
      const reset = iconButton("reset", snapshot.labels.resetSetting, "setting-icon-button");
      reset.dataset.settingKey = setting.key;
      reset.dataset.settingAction = "reset";
      setFocusIdentity(reset, "setting", setting.key, "reset");
      reset.disabled = isPending(setting.key);
      reset.addEventListener("click", () => {
        clearDraft(setting);
        postSettingRequest("resetSetting", setting);
      });
      actionSlot.append(reset);
    }
    controlArea.append(actionSlot);
    header.append(controlArea);
    row.append(header);

    if (setting.disabledReason) {
      row.append(element("p", "setting-disabled-reason", setting.disabledReason));
    }
    const statusValue = settingStatuses.get(setting.key);
    const status = element(
      "div",
      "setting-status" + (statusValue && statusValue.error ? " error" : ""),
      statusValue ? statusValue.message : isPending(setting.key) ? snapshot.labels.saving : ""
    );
    status.setAttribute("role", statusValue && statusValue.error ? "alert" : "status");
    status.setAttribute("aria-live", "polite");
    row.append(status);
    return row;
  }

  function appendBadges(container, setting) {
    if (setting.sourceBadge === "codex") {
      container.append(badge(snapshot.labels.codexBadge, "source codex"));
    } else if (setting.sourceBadge === "claude") {
      container.append(badge(snapshot.labels.claudeBadge, "source claude"));
    }
    if (setting.experimental) {
      container.append(badge(snapshot.labels.experimental, "experimental"));
    }
    if (setting.resourceImpact) {
      container.append(createResourceImpactIndicator());
    }
    if (setting.invalid) {
      container.append(badge(snapshot.labels.invalid, "invalid"));
    }
    if (setting.overriddenBy) {
      container.append(badge(snapshot.labels.overridden + ": " + setting.overriddenBy, "overridden"));
    }
  }

  function createControl(setting, dependencyDisabled) {
    const disabled = dependencyDisabled || isPending(setting.key);
    if (setting.control === "switch") {
      return createSwitch(setting, disabled);
    }
    if (setting.control === "select") {
      return createSelect(setting, disabled);
    }
    if (setting.control === "multi") {
      return createMultiSelect(setting, disabled);
    }
    if (setting.control === "number") {
      return createNumberInput(setting, disabled);
    }
    return createPathInput(setting, disabled);
  }

  function createSwitch(setting, disabled) {
    const wrapper = element("label", "switch-control");
    wrapper.setAttribute("aria-label", setting.label);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = setting.value === true;
    input.disabled = disabled;
    input.setAttribute("aria-label", setting.label);
    setFocusIdentity(input, "setting", setting.key, "primary");
    input.addEventListener("change", () => postUpdate(setting, input.checked));
    const slider = element("span", "switch-slider");
    slider.setAttribute("aria-hidden", "true");
    wrapper.append(input, slider);
    return wrapper;
  }

  function createSelect(setting, disabled) {
    const wrapper = element("div", "select-control-stack");
    const select = document.createElement("select");
    select.className = "select-control setting-select";
    select.setAttribute("aria-label", setting.label);
    setFocusIdentity(select, "setting", setting.key, "primary");
    select.disabled = disabled;
    for (const item of setting.options || []) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.title = item.description || "";
      option.selected = setting.value === item.value;
      select.append(option);
    }
    select.addEventListener("change", () => postUpdate(setting, select.value));
    wrapper.append(select);
    const selectedOption = (setting.options || []).find((item) => item.value === setting.value);
    if (selectedOption && selectedOption.description) {
      wrapper.append(element("span", "selected-option-description", selectedOption.description));
    }
    return wrapper;
  }

  function createMultiSelect(setting, disabled) {
    const root = element("div", "multi-select");
    const selected = Array.isArray(setting.value) ? setting.value : [];
    const selectedOptions = (setting.options || []).filter((item) => selected.includes(item.value));
    const triggerText = selectedOptions.map((item) => item.label).join(", ");
    const trigger = button("", "multi-trigger");
    trigger.disabled = disabled;
    trigger.setAttribute("aria-label", setting.label + ": " + triggerText);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", String(openMultiKey === setting.key));
    setFocusIdentity(trigger, "setting", setting.key, "primary");
    const tokens = element("span", "multi-trigger-tokens");
    for (const item of selectedOptions) {
      const token = element("span", "multi-token", item.label);
      token.title = item.description || item.label;
      tokens.append(token);
    }
    trigger.append(tokens, createIcon("chevron-down", "multi-trigger-chevron"));
    trigger.addEventListener("click", () => {
      openMultiKey = openMultiKey === setting.key ? undefined : setting.key;
      render();
    });
    trigger.addEventListener("keydown", (event) => {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        openMultiKey !== setting.key
      ) {
        const options = setting.options || [];
        if (options.length === 0) {
          return;
        }
        event.preventDefault();
        openMultiKey = setting.key;
        const optionIndex = event.key === "ArrowUp" ? options.length - 1 : 0;
        focusMemory = { kind: "setting", id: setting.key, action: "option:" + optionIndex };
        render();
      }
    });
    root.append(trigger);

    if (openMultiKey === setting.key && !disabled) {
      const popover = element("div", "multi-popover");
      popover.setAttribute("role", "listbox");
      popover.setAttribute("aria-label", setting.label);
      popover.setAttribute("aria-multiselectable", "true");
      const options = setting.options || [];
      options.forEach((item, index) => {
        const selectedItem = selected.includes(item.value);
        const option = button("", "multi-popover-option" + (selectedItem ? " selected" : ""));
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(selectedItem));
        option.title = item.description || "";
        setFocusIdentity(option, "setting", setting.key, "option:" + index);
        const optionCopy = element("span", "multi-option-copy");
        optionCopy.append(element("span", "multi-option-label", item.label));
        if (item.description) {
          optionCopy.append(element("span", "multi-option-description", item.description));
        }
        option.append(createIcon(selectedItem ? "check" : "blank", "multi-check"), optionCopy);
        option.addEventListener("click", () => {
          const next = selectedItem
            ? selected.filter((value) => value !== item.value)
            : selected.concat(item.value);
          if (next.length === 0) {
            settingStatuses.set(setting.key, {
              message: snapshot.labels.selectAtLeastOne,
              error: true
            });
            render();
            return;
          }
          postUpdate(setting, next);
        });
        option.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            openMultiKey = undefined;
            focusMemory = { kind: "setting", id: setting.key, action: "primary" };
            render();
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
          }
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = (index + direction + options.length) % options.length;
          focusMemory = { kind: "setting", id: setting.key, action: "option:" + nextIndex };
          restoreFocus();
        });
        popover.append(option);
      });
      root.append(popover);
    }
    return root;
  }

  function createNumberInput(setting, disabled) {
    const wrapper = element("div", "number-control");
    const input = document.createElement("input");
    input.type = "number";
    input.className = "text-control number-input";
    input.value = readDraft(setting) ?? String(setting.value);
    input.disabled = disabled;
    input.setAttribute("aria-label", setting.label);
    setFocusIdentity(input, "setting", setting.key, "primary");
    if (typeof setting.minimum === "number") {
      input.min = String(setting.minimum);
    }
    if (typeof setting.maximum === "number") {
      input.max = String(setting.maximum);
    }
    if (typeof setting.step === "number") {
      input.step = String(setting.step);
    }
    input.addEventListener("input", () => writeDraft(setting, input.value));
    input.addEventListener("keydown", (event) => handleDraftKeydown(event, setting, input));
    input.addEventListener("blur", (event) => {
      if (isDraftActionTarget(event.relatedTarget, setting.key)) {
        return;
      }
      if (input.value.trim() === String(setting.value)) {
        clearDraft(setting);
        return;
      }
      const value = Number(input.value);
      if (!Number.isSafeInteger(value)) {
        settingStatuses.set(setting.key, { message: snapshot.labels.invalidValue, error: true });
        render();
        return;
      }
      clearDraft(setting);
      postUpdate(setting, value);
    });
    wrapper.append(input);
    if (setting.unit) {
      wrapper.append(element("span", "setting-unit", setting.unit));
    }
    return wrapper;
  }

  function createPathInput(setting, disabled) {
    const wrapper = element("div", "path-control");
    const field = element("div", "path-field");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "text-control path-input";
    const original = typeof setting.value === "string" ? setting.value : "";
    input.value = readDraft(setting) ?? original;
    input.disabled = disabled;
    input.setAttribute("aria-label", setting.label);
    setFocusIdentity(input, "setting", setting.key, "primary");
    input.addEventListener("input", () => writeDraft(setting, input.value));
    input.addEventListener("keydown", (event) => handleDraftKeydown(event, setting, input, original));
    input.addEventListener("blur", (event) => {
      if (isDraftActionTarget(event.relatedTarget, setting.key)) {
        return;
      }
      if (input.value !== original) {
        clearDraft(setting);
        postUpdate(setting, input.value);
      } else {
        clearDraft(setting);
      }
    });
    const browse = iconButton("folder", snapshot.labels.browseFolder, "path-browse-button");
    browse.dataset.settingKey = setting.key;
    browse.dataset.settingAction = "browse";
    setFocusIdentity(browse, "setting", setting.key, "browse");
    browse.disabled = disabled;
    browse.addEventListener("click", () => {
      clearDraft(setting);
      postSettingRequest("browseFolder", setting);
    });
    field.append(input, browse);
    wrapper.append(field);
    return wrapper;
  }

  function handleDraftKeydown(event, setting, input, originalValue) {
    if (event.key === "Enter") {
      input.blur();
    } else if (event.key === "Escape") {
      clearDraft(setting);
      input.value = originalValue === undefined ? String(setting.value) : originalValue;
      input.blur();
    }
  }

  function createMaintenanceContent() {
    const container = element("div", "maintenance-cards");
    const actionPending = pendingRequests.size > 0;
    for (const cardModel of snapshot.maintenanceCards) {
      const card = element("section", "maintenance-card");
      card.append(element("h3", "card-title", cardModel.title));
      for (const action of cardModel.actions) {
        const row = element("div", "maintenance-row");
        const copy = element("div", "maintenance-copy");
        copy.append(
          element("div", "maintenance-label", action.label),
          element("p", "maintenance-description", action.description)
        );
        const actionButton = button(action.buttonLabel, "action-button " + action.tone);
        actionButton.disabled = actionPending;
        setFocusIdentity(actionButton, "maintenance", action.id);
        actionButton.addEventListener("click", () => postMaintenanceAction(action.id));
        row.append(copy, actionButton);
        card.append(row);
      }
      container.append(card);
    }
    return container;
  }

  function createAboutContent() {
    const about = snapshot.about;
    const container = element("div", "about-content");
    const card = element("section", "about-card");
    const tabs = element("div", "license-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.append(
      createAboutTab("version", about.versionTab),
      createAboutTab("license", about.licenseTab),
      createAboutTab("thirdParty", about.thirdPartyTab)
    );
    const panels = ABOUT_TAB_IDS.map((id) => createAboutPanel(about, id));
    card.append(tabs, ...panels);
    container.append(card);
    return container;
  }

  function createAboutPanel(about, id) {
    return id === "version"
      ? createAboutVersionPanel(about)
      : createLicenseDocumentPanel(about, id);
  }

  function createAboutVersionPanel(about) {
    const panel = element("section", "about-tab-panel about-version-panel");
    configureAboutPanel(panel, "version");
    const mark = createIcon("extension", "about-product-icon");
    mark.setAttribute("aria-hidden", "true");
    const copy = element("div", "about-product-copy");
    copy.append(
      element("h3", "about-product-name", about.displayName),
      element("div", "about-product-meta", about.versionLabel + " " + about.version),
      element("div", "about-product-meta", about.licenseLabel + " " + about.licenseName),
      element("div", "about-product-copyright", about.copyright)
    );
    const supportActions = element("div", "about-support-actions");
    const starButton = button(about.starLabel, "about-support-button");
    starButton.title = about.starTooltip;
    setFocusIdentity(starButton, "about-action", "repository");
    const starIcon = createIcon("star", "about-star-icon");
    starIcon.setAttribute("aria-hidden", "true");
    starButton.prepend(starIcon);
    starButton.addEventListener("click", () => {
      vscode.postMessage({ type: "openAboutResource", resourceId: "repository" });
    });
    const sponsorButton = button(about.sponsorLabel, "about-support-button");
    sponsorButton.title = about.sponsorTooltip;
    setFocusIdentity(sponsorButton, "about-action", "sponsor");
    const sponsorIcon = createIcon("heart", "about-sponsor-icon");
    sponsorIcon.setAttribute("aria-hidden", "true");
    sponsorButton.prepend(sponsorIcon);
    sponsorButton.addEventListener("click", () => {
      vscode.postMessage({ type: "openSponsor" });
    });
    supportActions.append(starButton, sponsorButton);
    const resources = element("nav", "about-resource-section");
    const resourcesHeading = element("h4", "about-resource-heading", about.resourcesLabel);
    resourcesHeading.id = "about-resource-heading";
    resources.setAttribute("aria-labelledby", resourcesHeading.id);
    const resourceLinks = element("div", "about-resource-links");
    resourceLinks.append(
      createAboutResourceButton(
        "securityPolicy",
        about.securityPolicyLabel,
        about.securityPolicyTooltip
      ),
      createAboutResourceButton(
        "reportVulnerability",
        about.reportVulnerabilityLabel,
        about.reportVulnerabilityTooltip
      ),
      createAboutResourceButton("changelog", about.changelogLabel, about.changelogTooltip),
      createAboutResourceButton(
        "commandReference",
        about.commandReferenceLabel,
        about.commandReferenceTooltip
      )
    );
    resources.append(resourcesHeading, resourceLinks);
    copy.append(supportActions, resources);
    panel.append(mark, copy);
    return panel;
  }

  function createAboutResourceButton(id, label, tooltip) {
    const result = button(label, "about-resource-button");
    result.title = tooltip;
    setFocusIdentity(result, "about-action", id);
    const icon = createIcon("external-link", "about-resource-icon");
    icon.setAttribute("aria-hidden", "true");
    result.append(icon);
    result.addEventListener("click", () => {
      vscode.postMessage({ type: "openAboutResource", resourceId: id });
    });
    return result;
  }

  function createLicenseDocumentPanel(about, id) {
    const text = element(
      "pre",
      "about-tab-panel license-document",
      id === "license" ? about.licenseText : about.thirdPartyText
    );
    configureAboutPanel(text, id);
    return text;
  }

  function configureAboutPanel(panel, id) {
    panel.id = "about-panel-" + id;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("tabindex", "0");
    panel.setAttribute("aria-labelledby", "about-tab-" + id);
    panel.hidden = activeAboutTab !== id;
  }

  function createAboutTab(id, label) {
    const tab = button(label, "license-tab" + (activeAboutTab === id ? " active" : ""));
    tab.id = "about-tab-" + id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "about-panel-" + id);
    tab.setAttribute("aria-selected", String(activeAboutTab === id));
    tab.tabIndex = activeAboutTab === id ? 0 : -1;
    setFocusIdentity(tab, "about-tab", id);
    tab.addEventListener("click", () => {
      activeAboutTab = id;
      persistState();
      render();
    });
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const currentIndex = ABOUT_TAB_IDS.indexOf(id);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? ABOUT_TAB_IDS.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + ABOUT_TAB_IDS.length) % ABOUT_TAB_IDS.length;
      activeAboutTab = ABOUT_TAB_IDS[nextIndex];
      focusMemory = { kind: "about-tab", id: activeAboutTab, action: "" };
      persistState();
      render();
    });
    return tab;
  }

  function postUpdate(setting, value) {
    settingStatuses.delete(setting.key);
    postSettingRequest("updateSetting", setting, { value });
  }

  function postSettingRequest(type, setting, extra) {
    if (!snapshot || isPending(setting.key)) {
      return undefined;
    }
    const requestId = allocateRequestId();
    pendingRequests.set(requestId, { key: setting.key });
    settingStatuses.delete(setting.key);
    vscode.postMessage(Object.assign({
      type,
      requestId,
      key: setting.key,
      targetId: snapshot.activeTargetId,
      valueToken: setting.valueToken,
      snapshotRevision: snapshot.revision
    }, extra || {}));
    render();
    return requestId;
  }

  function postMaintenanceAction(actionId) {
    if (!snapshot || pendingRequests.size > 0) {
      return;
    }
    const requestId = allocateRequestId();
    pendingRequests.set(requestId, { actionId });
    globalStatus = "";
    globalStatusIsError = false;
    vscode.postMessage({ type: "runMaintenanceAction", requestId, actionId });
    render();
  }

  function finishRequest(requestId, message, isError) {
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    if (pending && pending.key && message) {
      settingStatuses.set(pending.key, { message, error: isError });
    } else if (message) {
      globalStatus = message;
      globalStatusIsError = isError;
    } else if (pending && pending.actionId) {
      globalStatus = "";
      globalStatusIsError = false;
    }
    render();
  }

  function isPending(settingKey) {
    for (const pending of pendingRequests.values()) {
      if (pending.key === settingKey) {
        return true;
      }
    }
    return false;
  }

  function allocateRequestId() {
    for (let attempts = 0; attempts < Number.MAX_SAFE_INTEGER; attempts += 1) {
      const requestId = nextRequestId;
      nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
      if (!pendingRequests.has(requestId)) {
        return requestId;
      }
    }
    throw new Error("No request identifiers are available.");
  }

  function persistState() {
    vscode.setState({ activePageId, navigationCollapsed, activeAboutTab });
  }

  function badge(text, kind) {
    return element("span", "setting-badge " + kind, text);
  }

  function createResourceImpactIndicator() {
    const result = element("span", "setting-resource-indicator");
    result.title = snapshot.labels.resourceImpact;
    result.setAttribute("role", "img");
    result.setAttribute("aria-label", snapshot.labels.resourceImpact);
    const icon = createIcon("gauge", "setting-resource-icon");
    icon.setAttribute("aria-hidden", "true");
    result.append(icon);
    return result;
  }

  function iconButton(iconName, label, className) {
    const result = button("", className);
    result.title = label;
    result.setAttribute("aria-label", label);
    const icon = createIcon(iconName, "button-icon");
    icon.setAttribute("aria-hidden", "true");
    result.append(icon);
    return result;
  }

  function createIcon(name, className) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", name === "extension" ? "0 0 128 128" : "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", name === "extension" ? "10" : "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.classList.add(className || "icon");
    const definitions = {
      general: ["M4 7h16", "M7 7a2 2 0 1 0 0 .01", "M4 17h16", "M17 17a2 2 0 1 0 0 .01"],
      sources: ["M5 5h14v5H5z", "M5 14h14v5H5z", "M8 7.5h.01", "M8 16.5h.01"],
      history: ["M12 8v5l3 2", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3.5 4.5V8H7"],
      search: ["M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z", "M16 16l5 5"],
      session: ["M4 5h16v12H8l-4 4z", "M8 9h8", "M8 13h5"],
      resume: ["M4 12a8 8 0 1 0 2.3-5.7", "M4 4v5h5"],
      maintenance: ["M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.5 2.5-3-3z"],
      about: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7h.01"],
      menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
      close: ["M6 6l12 12", "M18 6L6 18"],
      "panel-close": ["M4 5h16v14H4z", "M9 5v14", "M14 9l-3 3 3 3"],
      "panel-open": ["M4 5h16v14H4z", "M9 5v14", "M11 9l3 3-3 3"],
      reset: ["M4 12a8 8 0 1 0 2.3-5.7", "M4 4v5h5"],
      folder: ["M3 6h7l2 2h9v10H3z"],
      gauge: ["M4 17a8 8 0 0 1 16 0", "M12 17l4-5", "M7 20h10"],
      star: ["M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2-4.5-4.4 6.2-.9z"],
      heart: ["M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"],
      "external-link": ["M14 5h5v5", "M10 14l9-9", "M19 13v6H5V5h6"],
      "chevron-down": ["M7 10l5 5 5-5"],
      check: ["M5 12l4 4L19 6"],
      blank: []
    };
    if (name === "extension") {
      const group = document.createElementNS(namespace, "g");
      group.setAttribute("transform", "translate(64 64) scale(1.1) translate(-64 -64)");
      appendSvgPath(group, "M108 64A44 44 0 1 1 64 20");
      appendSvgPath(group, "M44 50h40");
      appendSvgPath(group, "M44 64h40");
      appendSvgPath(group, "M44 78h30");
      svg.append(group);
      return svg;
    }
    for (const pathData of definitions[name] || definitions.about) {
      appendSvgPath(svg, pathData);
    }
    return svg;
  }

  function appendSvgPath(svg, pathData) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }

  function button(text, className) {
    const result = document.createElement("button");
    result.type = "button";
    result.className = className;
    result.textContent = text;
    return result;
  }

  function element(tagName, className, text) {
    const result = document.createElement(tagName);
    result.className = className;
    if (text !== undefined) {
      result.textContent = text;
    }
    return result;
  }

  function isRequestId(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function isMobileNavigationModalOpen() {
    return mobileNavigationOpen && mobileNavigationMedia.matches;
  }

  function setFocusIdentity(target, kind, id, action) {
    target.dataset.focusKind = kind;
    target.dataset.focusId = id;
    if (action) {
      target.dataset.focusAction = action;
    }
  }

  function restoreFocus() {
    if (!focusMemory) {
      return;
    }
    const candidates = Array.from(app.querySelectorAll("[data-focus-kind]"));
    const target = candidates.find((candidate) =>
      candidate.dataset.focusKind === focusMemory.kind &&
      (candidate.dataset.focusId || "") === focusMemory.id &&
      (candidate.dataset.focusAction || "") === focusMemory.action
    );
    if (target instanceof HTMLElement && !target.disabled) {
      target.focus({ preventScroll: true });
      return;
    }
    if (focusMemory.kind === "setting") {
      const row = Array.from(app.querySelectorAll(".setting-row")).find(
        (candidate) => candidate.dataset.settingKey === focusMemory.id
      );
      if (row instanceof HTMLElement) {
        row.tabIndex = -1;
        row.focus({ preventScroll: true });
      }
    }
  }

  function draftKey(setting) {
    return snapshot.activeTargetId + "\u0000" + setting.key;
  }

  function readDraft(setting) {
    const key = draftKey(setting);
    const draft = settingDrafts.get(key);
    if (!draft) {
      return undefined;
    }
    if (draft.valueToken !== setting.valueToken) {
      settingDrafts.delete(key);
      return undefined;
    }
    return draft.value;
  }

  function writeDraft(setting, value) {
    settingDrafts.set(draftKey(setting), { value, valueToken: setting.valueToken });
  }

  function clearDraft(setting) {
    settingDrafts.delete(draftKey(setting));
  }

  function isDraftActionTarget(target, settingKey) {
    return target instanceof HTMLElement &&
      target.dataset.settingKey === settingKey &&
      (target.dataset.settingAction === "reset" || target.dataset.settingAction === "browse");
  }

  function readPersistedString(key) {
    return persisted && typeof persisted[key] === "string" ? persisted[key] : undefined;
  }

  function readPersistedAboutTab() {
    const value = readPersistedString("activeAboutTab");
    return ABOUT_TAB_IDS.includes(value) ? value : "version";
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isAboutModel(value) {
    return isRecord(value) && [
      "displayName",
      "headerMetadata",
      "compactHeaderVersion",
      "versionLabel",
      "version",
      "licenseLabel",
      "licenseName",
      "copyright",
      "versionTab",
      "licenseTab",
      "thirdPartyTab",
      "starLabel",
      "starTooltip",
      "sponsorLabel",
      "sponsorTooltip",
      "resourcesLabel",
      "securityPolicyLabel",
      "securityPolicyTooltip",
      "reportVulnerabilityLabel",
      "reportVulnerabilityTooltip",
      "changelogLabel",
      "changelogTooltip",
      "commandReferenceLabel",
      "commandReferenceTooltip",
      "licenseText",
      "thirdPartyText"
    ].every((key) => typeof value[key] === "string");
  }

  function isSnapshot(value) {
    return isRecord(value) &&
      value.version === 2 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      (value.language === "ja" || value.language === "en") &&
      typeof value.title === "string" &&
      typeof value.compactTitle === "string" &&
      typeof value.activeTargetId === "string" &&
      Array.isArray(value.targets) &&
      Array.isArray(value.pages) &&
      Array.isArray(value.settings) &&
      Array.isArray(value.maintenanceCards) &&
      isAboutModel(value.about) &&
      isRecord(value.labels);
  }
})();
