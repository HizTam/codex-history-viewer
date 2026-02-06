// Webview script. Communicates with the extension via postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const metaEl = document.getElementById("meta");
  const timelineEl = document.getElementById("timeline");
  const btnMarkdown = document.getElementById("btnMarkdown");
  const btnCopyResume = document.getElementById("btnCopyResume");
  const btnReload = document.getElementById("btnReload");
  const btnToggleDetails = document.getElementById("btnToggleDetails");

  const md = createMarkdownRenderer();
  const COPY_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 1.5H6A1.5 1.5 0 0 0 4.5 3H3.75A1.75 1.75 0 0 0 2 4.75v8.5C2 14.216 2.784 15 3.75 15h8.5c.966 0 1.75-.784 1.75-1.75v-8.5C14 3.784 13.216 3 12.25 3H11.5A1.5 1.5 0 0 0 10 1.5Zm-4 1H10a.5.5 0 0 1 .5.5V3H5.5V3a.5.5 0 0 1 .5-.5ZM3.75 4h8.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-8.5a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 3.75 4Z"/></svg>';
  const RELOAD_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75.75.75 0 0 0-1.5 0A4.25 4.25 0 1 1 8 3.75h2.06l-.8.8a.75.75 0 0 0 1.06 1.06l2.08-2.08a.75.75 0 0 0 0-1.06L10.32.39A.75.75 0 0 0 9.26 1.45l.8.8H8Z"/></svg>';
  const NAV_UP_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.2a.75.75 0 0 1 .53.22l4.1 4.1a.75.75 0 1 1-1.06 1.06L8 4.99 4.43 8.58a.75.75 0 1 1-1.06-1.06l4.1-4.1A.75.75 0 0 1 8 3.2Z"/></svg>';
  const NAV_DOWN_ICON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 12.8a.75.75 0 0 1-.53-.22l-4.1-4.1a.75.75 0 0 1 1.06-1.06L8 11.01l3.57-3.59a.75.75 0 0 1 1.06 1.06l-4.1 4.1A.75.75 0 0 1 8 12.8Z"/></svg>';

  /** @type {any} */
  let model = null;
  /** @type {any} */
  let i18n = {};
  /** @type {{ timeZone?: string }} */
  let dateTime = {};
  let showDetails = false;
  let selectedMessageIndex = null;
  let messageNavMap = new Map();

  // Initial button labels (overwritten after receiving sessionData).
  btnMarkdown.textContent = "Markdown";
  btnCopyResume.textContent = "Copy prompt";
  // Reload is icon-only (tooltip is set via i18n).
  btnReload.innerHTML = RELOAD_ICON_SVG;
  btnToggleDetails.textContent = "Details";

  btnMarkdown.addEventListener("click", () => {
    vscode.postMessage({
      type: "openMarkdown",
      revealMessageIndex: typeof selectedMessageIndex === "number" ? selectedMessageIndex : undefined,
    });
  });
  btnCopyResume.addEventListener("click", () => {
    vscode.postMessage({ type: "copyResumePrompt" });
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

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "sessionData") {
      const restoreScrollY = typeof msg.restoreScrollY === "number" ? msg.restoreScrollY : undefined;
      const restoreSelectedMessageIndex =
        typeof msg.restoreSelectedMessageIndex === "number" ? msg.restoreSelectedMessageIndex : undefined;
      const isRestore = typeof restoreScrollY === "number" || typeof restoreSelectedMessageIndex === "number";

      const prevShowDetails = showDetails;
      const prevSelectedMessageIndex = selectedMessageIndex;

      model = msg.model || null;
      i18n = msg.i18n || {};
      dateTime = msg.dateTime || {};
      selectedMessageIndex = isRestore
        ? typeof restoreSelectedMessageIndex === "number"
          ? restoreSelectedMessageIndex
          : prevSelectedMessageIndex
        : typeof msg.revealMessageIndex === "number"
          ? msg.revealMessageIndex
          : null;

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
    const markdownLabel = i18n.markdown || "Markdown";
    const markdownTooltip = i18n.markdownTooltip || markdownLabel;
    btnMarkdown.textContent = markdownLabel;
    btnMarkdown.title = markdownTooltip;
    btnMarkdown.setAttribute("aria-label", markdownTooltip);
    const copyResumeLabel = i18n.copyResume || "Copy prompt";
    // Show a descriptive tooltip so the button intent is clear.
    const copyResumeTooltip = i18n.copyResumeTooltip || copyResumeLabel;
    btnCopyResume.textContent = copyResumeLabel;
    btnCopyResume.title = copyResumeTooltip;
    btnCopyResume.setAttribute("aria-label", copyResumeTooltip);
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
    btnToggleDetails.textContent = detailsLabel;
    btnToggleDetails.title = detailsTooltip;
    btnToggleDetails.setAttribute("aria-label", detailsTooltip);
  }

  function render() {
    metaEl.textContent = "";
    timelineEl.textContent = "";
    if (!model) return;

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

  function renderItem(item) {
    if (item.type === "message") return renderMessage(item);
    // Toggling "Details" also toggles tool/note rendering.
    if (item.type === "tool") return showDetails ? renderTool(item) : null;
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

    if (role === "assistant") {
      const mdBlock = el("div", { className: "markdown" });
      renderMarkdownInto(mdBlock, textToRender);
      bubble.appendChild(mdBlock);
    } else {
      const blocks = splitFencedCode(textToRender);
      for (const b of blocks) {
        if (b.type === "text") {
          const textBlock = el("div", { className: "textBlock" });
          textBlock.textContent = b.text;
          bubble.appendChild(textBlock);
        } else if (b.type === "code") {
          bubble.appendChild(renderCodeBlock(b.lang, b.code));
        }
      }
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

  function renderTool(item) {
    const row = el("div", { className: "row tool" });
    const bubble = el("div", { className: "bubble tool" });

    const metaLine = el("div", { className: "metaLine" });
    const toolTag = el("span", { className: "tag" });
    toolTag.textContent = i18n.tool || "Tool";
    metaLine.appendChild(toolTag);
    const nameTag = el("span", { className: "tag" });
    nameTag.textContent = item.name || "function_call";
    metaLine.appendChild(nameTag);
    if (typeof item.callId === "string") {
      const idTag = el("span", { className: "tag" });
      idTag.textContent = item.callId;
      metaLine.appendChild(idTag);
    }
    if (typeof item.timestampIso === "string") {
      const ts = el("span", { className: "tag" });
      ts.textContent = formatIsoYmdHms(item.timestampIso);
      ts.title = item.timestampIso;
      metaLine.appendChild(ts);
    }
    bubble.appendChild(metaLine);

    if (typeof item.argumentsText === "string" && item.argumentsText.length > 0) {
      const details = el("details", {});
      details.open = item.argumentsText.length < 2000;
      const summary = el("summary", {});
      summary.textContent = i18n.arguments || "Arguments";
      details.appendChild(summary);
      details.appendChild(renderCodeBlock("json", item.argumentsText, { copyIcon: true }));
      bubble.appendChild(details);
    }

    if (typeof item.outputText === "string" && item.outputText.length > 0) {
      const details = el("details", {});
      details.open = item.outputText.length < 2000;
      const summary = el("summary", {});
      summary.textContent = i18n.output || "Output";
      details.appendChild(summary);
      details.appendChild(renderCodeBlock("", item.outputText, { copyIcon: true }));
      bubble.appendChild(details);
    }

    row.appendChild(bubble);
    return row;
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
    // Allow the tool details (Arguments/Output) copy button to be icon-only.
    const useIcon = !!(options && options.copyIcon);
    const btn = el("button", { type: "button", className: useIcon ? "codeCopyBtn iconBtn" : "codeCopyBtn" });
    const copyLabel = i18n.copy || "Copy";
    const copyCodeLabel = i18n.copyCodeTooltip || copyLabel;
    if (useIcon) btn.innerHTML = COPY_ICON_SVG;
    else btn.textContent = copyLabel;
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
    clearHighlights();
    const elTarget = document.getElementById(`msg-${messageIndex}`);
    if (!elTarget) return;
    elTarget.classList.add("highlight");
    elTarget.scrollIntoView({ block: "center" });
  }

  function revealMessage(messageIndex) {
    clearHighlights();
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

      const wrap = el("div", { className: "codeBlock" });
      const header = el("div", { className: "codeHeader" });
      const label = el("span", {});
      label.textContent = lang ? String(lang) : "";
      header.appendChild(label);
      const btn = el("button", { type: "button" });
      const copyLabel = i18n.copy || "Copy";
      const copyCodeLabel = i18n.copyCodeTooltip || copyLabel;
      btn.textContent = copyLabel;
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
      wrap.appendChild(pre);
    }
  }

  function inferMarkdownCodeLanguage(codeEl) {
    if (!codeEl) return "";
    const cls = String(codeEl.className || "");
    const m = cls.match(/(?:^|\\s)language-([a-z0-9_+-]+)(?:\\s|$)/i);
    return m ? m[1] : "";
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
})();
