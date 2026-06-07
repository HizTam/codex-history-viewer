// Shared page-search parser and matcher for webviews.
(function () {
  const MAX_PAGE_SEARCH_MATCHES = 1000;

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

  window.CHV_PAGE_SEARCH = Object.freeze({
    compileQuery,
    getInvalidKind,
    isSlashRegexLike,
  });
})();
