// Shared page-search parser, matcher, and logical text highlighter for webviews.
(function () {
  const MAX_PAGE_SEARCH_MATCHES = 1000;
  const PAGE_SEARCH_TEXT_UNIT_ATTRIBUTE = "data-page-search-text-unit";
  const PAGE_SEARCH_TEXT_UNIT_SELECTOR = `[${PAGE_SEARCH_TEXT_UNIT_ATTRIBUTE}="true"]`;
  const PAGE_SEARCH_TEXT_UNIT_MODES = new Set(["direct", "shiki-lines"]);
  // Keep external source text out of DOM attributes and release it with the rendered element.
  const pageSearchTextUnits = new WeakMap();

  function compileQuery(rawInput, caseSensitive) {
    const raw = String(rawInput || "").trim();
    if (!raw) return null;

    const slashRegexLike = isSlashRegexLike(raw);
    const slashRegex = parseSlashRegex(raw, caseSensitive);
    if (slashRegex) {
      const regex = makeRegex(slashRegex.body, addFlag(slashRegex.flags, "g"));
      if (!regex) return null;
      return {
        findAll: (text) => normalizeMatches(findRegexMatches(text, regex), text.length),
      };
    }
    if (slashRegexLike) return null;

    if (raw.toLowerCase().startsWith("re:")) {
      const body = raw.slice(3).trim();
      if (!body) return null;
      const flags = caseSensitive ? "" : "i";
      const regex = makeRegex(body, addFlag(flags, "g"));
      if (!regex) return null;
      return {
        findAll: (text) => normalizeMatches(findRegexMatches(text, regex), text.length),
      };
    }

    if (raw.toLowerCase().startsWith("exact:")) {
      const phrase = stripWrappingQuotes(raw.slice(6).trim());
      if (!phrase) return null;
      return {
        findAll: (text) => normalizeMatches(findNeedleMatches(text, phrase, caseSensitive), text.length),
      };
    }

    const clauses = parseBooleanClauses(raw, caseSensitive);
    if (!clauses || clauses.length === 0) return null;
    return {
      findAll: (text) => normalizeMatches(findBooleanMatches(text, clauses, caseSensitive), text.length),
    };
  }

  function getInvalidKind(rawInput) {
    const raw = String(rawInput || "").trim();
    const isRegexLike = raw.toLowerCase().startsWith("re:") || isSlashRegexLike(raw);
    return isRegexLike ? "regex" : "query";
  }

  function parseSlashRegex(raw, caseSensitive) {
    const match = raw.match(/^\/(.+)\/([a-z]*)$/i);
    if (!match) return null;
    const body = match[1] || "";
    const flags = caseSensitive ? match[2] || "" : addFlag(match[2] || "", "i");
    if (!makeRegex(body, flags)) return null;
    return { body, flags };
  }

  function isSlashRegexLike(raw) {
    return /^\/(.+)\/([a-z]*)$/i.test(String(raw || "").trim());
  }

  function makeRegex(body, flags) {
    try {
      return new RegExp(body, uniqueFlags(flags));
    } catch {
      return null;
    }
  }

  function uniqueFlags(flags) {
    return Array.from(new Set(String(flags || "").split("").filter(Boolean))).join("");
  }

  function addFlag(flags, flag) {
    return uniqueFlags(`${flags || ""}${flag}`);
  }

  function findRegexMatches(text, regex) {
    const out = [];
    regex.lastIndex = 0;
    while (out.length < MAX_PAGE_SEARCH_MATCHES) {
      const match = regex.exec(text);
      if (!match || typeof match.index !== "number") break;
      const value = typeof match[0] === "string" ? match[0] : "";
      out.push({ start: match.index, length: Math.max(1, value.length) });
      if (value.length === 0) regex.lastIndex += 1;
    }
    return out;
  }

  function findNeedleMatches(text, needle, caseSensitive) {
    const haystack = caseSensitive ? text : text.toLowerCase();
    const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
    return findNeedleMatchesInHaystack(haystack, normalizedNeedle, needle.length);
  }

  function parseBooleanClauses(raw, caseSensitive) {
    const orParts = raw
      .split(/\s+\bOR\b\s+/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (orParts.length === 0) return null;

    const clauses = [];
    for (const part of orParts) {
      const andParts = part
        .split(/\s+\bAND\b\s+/i)
        .map((token) => token.trim())
        .filter(Boolean);
      if (andParts.length === 0) return null;

      const conditions = [];
      let positiveCount = 0;
      for (const token of andParts) {
        const condition = parseConditionToken(token, caseSensitive);
        if (!condition) return null;
        conditions.push(condition);
        if (!condition.negated) positiveCount += 1;
      }
      if (positiveCount === 0) return null;
      clauses.push({ conditions });
    }
    return clauses;
  }

  function parseConditionToken(token, caseSensitive) {
    const negatedMatch = token.match(/^\bNOT\b\s+(.+)$/i);
    const negated = !!negatedMatch;
    const rawText = negated ? negatedMatch[1] || "" : token;
    const text = stripWrappingQuotes(rawText.trim());
    if (!text) return null;
    return {
      text,
      normalized: caseSensitive ? text : text.toLowerCase(),
      negated,
    };
  }

  function findBooleanMatches(text, clauses, caseSensitive) {
    const haystack = caseSensitive ? text : text.toLowerCase();
    for (const clause of clauses) {
      let passed = true;
      const matches = [];
      for (const condition of clause.conditions) {
        const found = findNeedleMatchesInHaystack(haystack, condition.normalized, condition.text.length);
        if ((condition.negated && found.length > 0) || (!condition.negated && found.length === 0)) {
          passed = false;
          break;
        }
        if (!condition.negated) matches.push(...found);
      }
      if (passed) return matches;
    }
    return [];
  }

  function findNeedleMatchesInHaystack(haystack, needle, originalLength) {
    const out = [];
    let offset = 0;
    while (out.length < MAX_PAGE_SEARCH_MATCHES) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      out.push({ start: index, length: Math.max(1, originalLength) });
      offset = index + Math.max(1, needle.length);
    }
    return out;
  }

  function normalizeMatches(matches, textLength) {
    const out = [];
    let cursor = 0;
    for (const match of matches
      .map((item) => ({
        start: Math.max(0, Math.min(textLength, Math.floor(Number(item.start)))),
        length: Math.max(1, Math.floor(Number(item.length))),
      }))
      .sort((a, b) => a.start - b.start || b.length - a.length)) {
      if (match.start < cursor) continue;
      const end = Math.min(textLength, match.start + match.length);
      if (end <= match.start) continue;
      out.push({ start: match.start, length: end - match.start });
      cursor = end;
    }
    return out;
  }

  function stripWrappingQuotes(input) {
    const value = String(input || "").trim();
    if (value.length >= 2) {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1).trim();
      }
    }
    return value;
  }

  function registerTextUnit(element, sourceText, options = {}) {
    if (!isHtmlElement(element)) return false;
    const source = String(sourceText ?? "");
    const mode = normalizeTextUnitMode(options && options.mode);
    if (!createTextUnitMapping(element, source, mode)) {
      pageSearchTextUnits.delete(element);
      element.removeAttribute(PAGE_SEARCH_TEXT_UNIT_ATTRIBUTE);
      return false;
    }
    pageSearchTextUnits.set(element, Object.freeze({ sourceText: source, mode }));
    element.setAttribute(PAGE_SEARCH_TEXT_UNIT_ATTRIBUTE, "true");
    return true;
  }

  function getTextUnit(element) {
    if (!isHtmlElement(element)) return null;
    return pageSearchTextUnits.get(element) || null;
  }

  function findTextUnit(element) {
    if (!isHtmlElement(element)) return null;
    let candidate = element.closest(PAGE_SEARCH_TEXT_UNIT_SELECTOR);
    while (isHtmlElement(candidate)) {
      if (pageSearchTextUnits.has(candidate)) return candidate;
      candidate = candidate.parentElement?.closest(PAGE_SEARCH_TEXT_UNIT_SELECTOR) || null;
    }
    return null;
  }

  function highlightTextUnit(element, matches) {
    const record = getTextUnit(element);
    if (!record || !Array.isArray(matches)) return null;
    const mapping = createTextUnitMapping(element, record.sourceText, record.mode);
    if (!mapping) return null;

    const plan = buildTextHighlightPlan(record.sourceText.length, mapping.spans, matches);
    if (!plan) return null;
    const groups = matches.map((match) => ({
      start: match.start,
      length: match.length,
      marks: [],
    }));
    if (plan.fragments.length === 0) return groups;

    const rangesBySpan = Array.from({ length: mapping.spans.length }, () => []);
    for (const item of plan.fragments) rangesBySpan[item.spanIndex].push(item);

    const replacements = [];
    try {
      for (let spanIndex = 0; spanIndex < mapping.spans.length; spanIndex += 1) {
        const ranges = rangesBySpan[spanIndex];
        if (ranges.length === 0) continue;
        const span = mapping.spans[spanIndex];
        const node = span.node;
        const parent = node && node.parentNode;
        if (!node || !parent || !element.contains(node)) return null;
        const nodeText = node.textContent || "";
        if (nodeText.length !== span.end - span.start) return null;

        const fragment = element.ownerDocument.createDocumentFragment();
        let cursor = 0;
        for (const range of ranges) {
          if (range.startOffset < cursor || range.endOffset > nodeText.length) return null;
          if (range.startOffset > cursor) {
            fragment.appendChild(element.ownerDocument.createTextNode(nodeText.slice(cursor, range.startOffset)));
          }
          const mark = element.ownerDocument.createElement("mark");
          mark.className = "pageSearchMatch pageSearchMatch-logical";
          mark.textContent = nodeText.slice(range.startOffset, range.endOffset);
          fragment.appendChild(mark);
          groups[range.matchIndex].marks.push(mark);
          cursor = range.endOffset;
        }
        if (cursor < nodeText.length) {
          fragment.appendChild(element.ownerDocument.createTextNode(nodeText.slice(cursor)));
        }
        replacements.push({ node, parent, fragment });
      }

      for (const replacement of replacements) {
        if (replacement.node.parentNode !== replacement.parent || !element.contains(replacement.node)) return null;
      }
      for (const replacement of replacements) {
        replacement.parent.replaceChild(replacement.fragment, replacement.node);
      }
      return groups;
    } catch {
      restoreLogicalHighlightMarks(element);
      return null;
    }
  }

  function buildTextHighlightPlan(sourceLength, rawSpans, rawMatches) {
    if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) return null;
    if (!Array.isArray(rawSpans) || !Array.isArray(rawMatches)) return null;

    const spans = [];
    let previousSpanEnd = 0;
    for (const rawSpan of rawSpans) {
      const start = Number(rawSpan && rawSpan.start);
      const end = Number(rawSpan && rawSpan.end);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
      if (start < previousSpanEnd || end <= start || end > sourceLength) return null;
      spans.push({ start, end });
      previousSpanEnd = end;
    }

    const matches = [];
    let previousMatchEnd = 0;
    for (const rawMatch of rawMatches) {
      const start = Number(rawMatch && rawMatch.start);
      const length = Number(rawMatch && rawMatch.length);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length <= 0) return null;
      const end = start + length;
      if (!Number.isSafeInteger(end) || start < previousMatchEnd || start < 0 || end > sourceLength) return null;
      matches.push({ start, end });
      previousMatchEnd = end;
    }

    const fragments = [];
    let firstPossibleSpan = 0;
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex];
      while (firstPossibleSpan < spans.length && spans[firstPossibleSpan].end <= match.start) {
        firstPossibleSpan += 1;
      }
      for (let spanIndex = firstPossibleSpan; spanIndex < spans.length; spanIndex += 1) {
        const span = spans[spanIndex];
        if (span.start >= match.end) break;
        const overlapStart = Math.max(span.start, match.start);
        const overlapEnd = Math.min(span.end, match.end);
        if (overlapEnd <= overlapStart) continue;
        fragments.push({
          matchIndex,
          spanIndex,
          startOffset: overlapStart - span.start,
          endOffset: overlapEnd - span.start,
        });
      }
    }
    return { fragments, matchCount: matches.length };
  }

  function createTextUnitMapping(element, sourceText, mode) {
    const direct = createDirectTextUnitMapping(element, sourceText);
    if (direct) return direct;
    return mode === "shiki-lines" ? createShikiLineTextUnitMapping(element, sourceText) : null;
  }

  function createDirectTextUnitMapping(element, sourceText) {
    if ((element.textContent || "") !== sourceText) return null;
    const spans = [];
    let offset = 0;
    for (const node of collectTextNodes(element)) {
      const length = (node.textContent || "").length;
      if (length > 0) spans.push({ node, start: offset, end: offset + length });
      offset += length;
    }
    return offset === sourceText.length ? { spans } : null;
  }

  function createShikiLineTextUnitMapping(element, sourceText) {
    const codeElement = element.querySelector("code");
    if (!isHtmlElement(codeElement)) return null;
    const lineElements = Array.from(codeElement.children);
    if (lineElements.some((line) => !isHtmlElement(line) || !line.classList.contains("line"))) return null;

    const sourceLines = splitSourceLines(sourceText);
    if (lineElements.length !== sourceLines.length) return null;
    const spans = [];
    for (let index = 0; index < sourceLines.length; index += 1) {
      const line = lineElements[index];
      const sourceLine = sourceLines[index];
      if ((line.textContent || "") !== sourceLine.text) return null;
      let offset = sourceLine.start;
      for (const node of collectTextNodes(line)) {
        const length = (node.textContent || "").length;
        if (length > 0) spans.push({ node, start: offset, end: offset + length });
        offset += length;
      }
      if (offset !== sourceLine.end) return null;
    }
    // Line separators intentionally remain unmapped virtual source ranges.
    return { spans };
  }

  function splitSourceLines(sourceText) {
    const lines = [];
    let lineStart = 0;
    let index = 0;
    while (index < sourceText.length) {
      const char = sourceText[index];
      if (char !== "\r" && char !== "\n") {
        index += 1;
        continue;
      }
      lines.push({ start: lineStart, end: index, text: sourceText.slice(lineStart, index) });
      if (char === "\r" && sourceText[index + 1] === "\n") index += 1;
      index += 1;
      lineStart = index;
    }
    lines.push({ start: lineStart, end: sourceText.length, text: sourceText.slice(lineStart) });
    return lines;
  }

  function collectTextNodes(element) {
    const out = [];
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  function clearHighlights(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : null;
    if (!scope) return false;
    const parents = new Set();
    for (const mark of Array.from(scope.querySelectorAll("mark.pageSearchMatch"))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent || ""), mark);
      parents.add(parent);
    }
    for (const parent of parents) {
      if (parent && typeof parent.normalize === "function") parent.normalize();
    }
    for (const element of Array.from(scope.querySelectorAll(".pageSearchLogicalMatch-active"))) {
      if (element && element.classList) element.classList.remove("pageSearchLogicalMatch-active");
    }
    return true;
  }

  function restoreLogicalHighlightMarks(element) {
    const parents = new Set();
    for (const mark of Array.from(element.querySelectorAll("mark.pageSearchMatch-logical"))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(element.ownerDocument.createTextNode(mark.textContent || ""), mark);
      parents.add(parent);
    }
    for (const parent of parents) {
      if (parent && typeof parent.normalize === "function") parent.normalize();
    }
  }

  function normalizeTextUnitMode(value) {
    const mode = typeof value === "string" ? value : "";
    return PAGE_SEARCH_TEXT_UNIT_MODES.has(mode) ? mode : "direct";
  }

  function isHtmlElement(value) {
    return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
  }

  window.CHV_PAGE_SEARCH = Object.freeze({
    buildTextHighlightPlan,
    clearHighlights,
    compileQuery,
    findTextUnit,
    getInvalidKind,
    getTextUnit,
    highlightTextUnit,
    isSlashRegexLike,
    registerTextUnit,
    splitSourceLines,
    textUnitSelector: PAGE_SEARCH_TEXT_UNIT_SELECTOR,
  });
})();
