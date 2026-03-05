import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import { resolveUiLanguage, t } from "../i18n";
import { safeDisplayPath, singleLineSnippet } from "../utils/textUtils";
import { SearchRootNode, SearchSessionNode, type SearchHit } from "../tree/treeNodes";
import { getDateScopeValue, sanitizeDateScope, type DateScope } from "../types/dateScope";
import { normalizeCacheKey } from "../utils/fsUtils";
import { type IndexedSearchRole, SearchIndexService } from "./searchIndexService";
import type { SessionAnnotationStore } from "./sessionAnnotationStore";

type SearchMode = "plain" | "exact" | "regex";

interface LocatedMatch {
  hitAt: number;
  hitLen: number;
}

interface CompiledSearchQuery {
  mode: SearchMode;
  displayQuery: string;
  locate: (text: string) => LocatedMatch | null;
  locateAll: (text: string, maxMatches: number) => LocatedMatch[];
}

interface PlainCondition {
  text: string;
  normalized: string;
  negated: boolean;
}

interface PlainClause {
  conditions: PlainCondition[];
}

export interface SearchRequest {
  queryInput: string;
  roleFilter: IndexedSearchRole[];
}

export interface SearchFlowResult {
  root: SearchRootNode;
  sessions: SearchSessionNode[];
  request: SearchRequest;
}

const uiText = (ja: string, en: string): string => (resolveUiLanguage() === "ja" ? ja : en);

// Runs search using user input or a preset request.
export async function runSearchFlow(
  index: HistoryIndex,
  config: CodexHistoryViewerConfig,
  searchIndexService: SearchIndexService,
  annotationStore: SessionAnnotationStore,
  scope?: DateScope,
  projectCwd?: string | null,
  sourceFilter?: SessionSourceFilter,
  options?: { request?: SearchRequest; defaultRoleFilter?: readonly IndexedSearchRole[]; tagFilter?: readonly string[] },
): Promise<SearchFlowResult | null> {
  if (index.sessions.length === 0) {
    void vscode.window.showInformationMessage(t("app.noSessionsFound"));
    return null;
  }

  const effectiveScope = sanitizeDateScope(scope);
  const effectiveSourceFilter = sanitizeSessionSourceFilter(sourceFilter);
  const tagFilter = sanitizeTagFilter(options?.tagFilter ?? []);
  const request = options?.request;

  let queryInput = "";
  let roleFilter = new Set<IndexedSearchRole>(["user", "assistant"]);
  if (request) {
    queryInput = typeof request.queryInput === "string" ? request.queryInput.trim() : "";
    if (!queryInput) {
      void vscode.window.showErrorMessage(uiText("保存済み検索リクエストが空です。", "Saved search request is empty."));
      return null;
    }
    roleFilter = sanitizeRoleFilter(request.roleFilter);
  } else {
    const entered = await vscode.window.showInputBox({
      prompt: `${t("search.input.query")} (supports /regex/, re:, exact:, AND/OR/NOT)`,
      validateInput: (v) => (v.trim().length === 0 ? t("search.invalidFormat") : undefined),
    });
    if (!entered) return null;
    queryInput = entered.trim();
    roleFilter = sanitizeRoleFilter(options?.defaultRoleFilter ?? ["user", "assistant"]);
  }

  const compiled = compileSearchQuery(queryInput, config.searchCaseSensitive);
  if (!compiled) {
    void vscode.window.showErrorMessage(
      uiText("検索クエリの形式が不正です。正規表現または論理式を確認してください。", "Invalid search query format. Check regex or boolean expression."),
    );
    return null;
  }

  const project = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
  const candidates = index.sessions.filter(
    (s) =>
      matchScope(s, effectiveScope) &&
      matchProject(s, project) &&
      matchSource(s, effectiveSourceFilter) &&
      matchAnnotationTags(s, tagFilter, annotationStore),
  );

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("app.searching"), cancellable: true },
    async (progress, token) => {
      try {
        // Synchronize index delta before searching, and remove index entries for deleted files.
        await searchIndexService.ensureUpToDate({
          index,
          codexSessionsRoot: config.sessionsRoot,
          claudeSessionsRoot: config.claudeSessionsRoot,
          includeCodex: config.enableCodexSource,
          includeClaude: config.enableClaudeSource,
          token,
          progress,
        });
        return await searchSessions({
          sessions: candidates,
          compiled,
          maxResults: config.searchMaxResults,
          token,
          progress,
          searchIndexService,
          annotationStore,
          roleFilter,
        });
      } catch (err) {
        if (err instanceof vscode.CancellationError) return null;
        throw err;
      }
    },
  );

  if (!results) return null;

  const scopeParts: string[] = [];
  const datePart = effectiveScope.kind === "all" ? t("search.filter.all") : getDateScopeValue(effectiveScope);
  if (datePart) scopeParts.push(datePart);
  if (project) scopeParts.push(t("history.filter.projectLabel", safeDisplayPath(project, 50)));
  if (effectiveSourceFilter !== "all") {
    scopeParts.push(t("history.filter.sourceLabel", getSourceFilterLabel(effectiveSourceFilter)));
  }
  if (tagFilter.length > 0) scopeParts.push(`tags: ${tagFilter.map((tag) => `#${tag}`).join(",")}`);
  if (!isDefaultRoleFilter(roleFilter)) scopeParts.push(`roles: ${Array.from(roleFilter).join(",")}`);
  const scopeValue = scopeParts.join(" / ");

  const root = new SearchRootNode({
    query: compiled.displayQuery,
    scopeKind: effectiveScope.kind,
    scopeValue,
    totalHits: results.totalHits,
  });
  const sessionNodes = results.sessions.map((s) => new SearchSessionNode(s.session, s.hits));
  return {
    root,
    sessions: sessionNodes,
    request: {
      queryInput,
      roleFilter: Array.from(roleFilter),
    },
  };
}

function sanitizeRoleFilter(input: readonly IndexedSearchRole[]): Set<IndexedSearchRole> {
  const valid = new Set<IndexedSearchRole>(["user", "assistant", "developer", "tool"]);
  const out = new Set<IndexedSearchRole>();
  for (const role of input) {
    if (valid.has(role)) out.add(role);
  }
  if (out.size === 0) {
    out.add("user");
    out.add("assistant");
  }
  return out;
}

function isDefaultRoleFilter(roleFilter: ReadonlySet<IndexedSearchRole>): boolean {
  return roleFilter.size === 2 && roleFilter.has("user") && roleFilter.has("assistant");
}

function matchScope(session: SessionSummary, scope: DateScope): boolean {
  const ymd = session.localDate;
  switch (scope.kind) {
    case "all":
      return true;
    case "year":
      return ymd.startsWith(`${scope.yyyy}-`);
    case "month":
      return ymd.startsWith(`${scope.ym}-`);
    case "day":
      return ymd === scope.ymd;
    default:
      return true;
  }
}

function matchProject(session: SessionSummary, projectCwd: string | null): boolean {
  if (!projectCwd) return true;
  const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
  if (!cwd) return false;
  return normalizeCacheKey(cwd) === normalizeCacheKey(projectCwd);
}

function matchSource(session: SessionSummary, sourceFilter: SessionSourceFilter): boolean {
  return sourceFilter === "all" ? true : session.source === sourceFilter;
}

function matchAnnotationTags(
  session: SessionSummary,
  tagFilter: readonly string[],
  annotationStore: SessionAnnotationStore,
): boolean {
  if (tagFilter.length === 0) return true;
  const annotation = annotationStore.get(session.fsPath);
  if (!annotation || annotation.tags.length === 0) return false;

  const tagKeys = new Set(annotation.tags.map((tag) => normalizeTagKey(tag)));
  return tagFilter.some((tag) => tagKeys.has(normalizeTagKey(tag)));
}

async function searchSessions(params: {
  sessions: SessionSummary[];
  compiled: CompiledSearchQuery;
  maxResults: number;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  searchIndexService: SearchIndexService;
  annotationStore: SessionAnnotationStore;
  roleFilter: ReadonlySet<IndexedSearchRole>;
}): Promise<{ totalHits: number; sessions: Array<{ session: SessionSummary; hits: SearchHit[] }> } | null> {
  const { sessions, compiled, maxResults, token, progress, searchIndexService, annotationStore, roleFilter } = params;

  const bySession = new Map<string, { session: SessionSummary; hits: SearchHit[] }>();
  let totalHits = 0;

  const total = sessions.length;
  const maxPerMessage = 8;
  for (let i = 0; i < sessions.length; i += 1) {
    if (token.isCancellationRequested) return null;
    const s = sessions[i]!;
    progress.report({ message: `search ${i + 1}/${total}` });

    const messages = searchIndexService.getMessages(s.cacheKey);
    if (!messages || messages.length === 0) continue;

    for (const m of messages) {
      if (token.isCancellationRequested) return null;
      if (totalHits >= maxResults) break;
      if (!roleFilter.has(m.role)) continue;

      const matches = compiled.locateAll(m.text, maxPerMessage);
      if (matches.length === 0) continue;

      if (!bySession.has(s.cacheKey)) bySession.set(s.cacheKey, { session: s, hits: [] });
      const bucket = bySession.get(s.cacheKey)!;

      for (const located of matches) {
        if (totalHits >= maxResults) break;
        const snippet = singleLineSnippet(buildAround(m.text, located.hitAt, located.hitLen), 160);
        bucket.hits.push({
          messageIndex: m.messageIndex,
          role: m.role,
          source: m.source,
          snippet,
        });
        totalHits += 1;
      }
    }

    if (totalHits >= maxResults) continue;
    const annotation = annotationStore.get(s.fsPath);
    if (!annotation) continue;

    if (annotation.tags.length > 0) {
      for (const tag of annotation.tags) {
        if (token.isCancellationRequested) return null;
        if (totalHits >= maxResults) break;
        const tagText = `#${tag}`;
        const located = compiled.locate(tagText);
        if (!located) continue;
        if (!bySession.has(s.cacheKey)) bySession.set(s.cacheKey, { session: s, hits: [] });
        const bucket = bySession.get(s.cacheKey)!;
        bucket.hits.push({
          messageIndex: 0,
          role: "tool",
          source: "annotationTag",
          snippet: tagText,
        });
        totalHits += 1;
      }
    }

    if (totalHits >= maxResults) continue;
    const noteText = annotation.note.trim();
    if (!noteText) continue;
    const noteMatches = compiled.locateAll(noteText, 4);
    if (noteMatches.length === 0) continue;
    if (!bySession.has(s.cacheKey)) bySession.set(s.cacheKey, { session: s, hits: [] });
    const bucket = bySession.get(s.cacheKey)!;
    for (const located of noteMatches) {
      if (token.isCancellationRequested) return null;
      if (totalHits >= maxResults) break;
      bucket.hits.push({
        messageIndex: 0,
        role: "tool",
        source: "annotationNote",
        snippet: singleLineSnippet(buildAround(noteText, located.hitAt, located.hitLen), 160),
      });
      totalHits += 1;
    }
  }

  const list = Array.from(bySession.values());
  list.sort((a, b) => {
    if (a.session.localDate !== b.session.localDate) return a.session.localDate < b.session.localDate ? 1 : -1;
    return a.session.timeLabel < b.session.timeLabel ? 1 : a.session.timeLabel > b.session.timeLabel ? -1 : 0;
  });
  for (const s of list) s.hits.sort((a, b) => a.messageIndex - b.messageIndex);

  return { totalHits, sessions: list };
}

function buildAround(text: string, hitAt: number, needleLen: number): string {
  const before = 40;
  const after = 80;
  const safeNeedleLen = Math.max(1, needleLen);
  const start = Math.max(0, hitAt - before);
  const end = Math.min(text.length, hitAt + safeNeedleLen + after);
  const head = start > 0 ? "..." : "";
  const tail = end < text.length ? "..." : "";
  return `${head}${text.slice(start, end)}${tail}`;
}

function compileSearchQuery(rawInput: string, caseSensitive: boolean): CompiledSearchQuery | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  const slashRegex = parseSlashRegex(raw, caseSensitive);
  if (slashRegex) {
    const firstRegex = makeRegex(slashRegex.body, removeFlag(slashRegex.flags, "g"));
    const allRegex = makeRegex(slashRegex.body, addFlag(slashRegex.flags, "g"));
    if (!firstRegex || !allRegex) return null;
    return {
      mode: "regex",
      displayQuery: raw,
      locate: (text) => locateByRegex(text, firstRegex),
      locateAll: (text, maxMatches) => locateAllByRegex(text, allRegex, maxMatches),
    };
  }

  if (raw.toLowerCase().startsWith("re:")) {
    const body = raw.slice(3).trim();
    if (!body) return null;
    const flags = caseSensitive ? "" : "i";
    const firstRegex = makeRegex(body, flags);
    const allRegex = makeRegex(body, addFlag(flags, "g"));
    if (!firstRegex || !allRegex) return null;
    return {
      mode: "regex",
      displayQuery: raw,
      locate: (text) => locateByRegex(text, firstRegex),
      locateAll: (text, maxMatches) => locateAllByRegex(text, allRegex, maxMatches),
    };
  }

  if (raw.toLowerCase().startsWith("exact:")) {
    const phrase = stripWrappingQuotes(raw.slice(6).trim());
    if (!phrase) return null;
    const needle = caseSensitive ? phrase : phrase.toLowerCase();
    return {
      mode: "exact",
      displayQuery: raw,
      locate: (text) => locateByNeedle(text, needle, caseSensitive, phrase.length),
      locateAll: (text, maxMatches) => locateAllByNeedle(text, needle, caseSensitive, phrase.length, maxMatches),
    };
  }

  const clauses = parseBooleanClauses(raw, caseSensitive);
  if (!clauses || clauses.length === 0) return null;
  return {
    mode: "plain",
    displayQuery: raw,
    locate: (text) => locateByClauses(text, clauses, caseSensitive),
    locateAll: (text, _maxMatches) => {
      const found = locateByClauses(text, clauses, caseSensitive);
      return found ? [found] : [];
    },
  };
}

function parseSlashRegex(raw: string, caseSensitive: boolean): { body: string; flags: string } | null {
  const m = raw.match(/^\/(.+)\/([a-z]*)$/i);
  if (!m) return null;

  const body = m[1] ?? "";
  const flagsRaw = m[2] ?? "";
  const flags = caseSensitive ? flagsRaw : addFlag(flagsRaw, "i");
  if (!makeRegex(body, flags)) return null;
  return { body, flags };
}

function makeRegex(body: string, flags: string): RegExp | null {
  try {
    return new RegExp(body, uniqueFlags(flags));
  } catch {
    return null;
  }
}

function uniqueFlags(flags: string): string {
  return Array.from(new Set(flags.split("").filter((f) => f.length > 0))).join("");
}

function addFlag(flags: string, flag: string): string {
  return uniqueFlags(`${flags}${flag}`);
}

function removeFlag(flags: string, flag: string): string {
  return uniqueFlags(flags.replace(new RegExp(flag, "g"), ""));
}

function locateByRegex(text: string, re: RegExp): LocatedMatch | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m || typeof m.index !== "number") return null;
  return { hitAt: m.index, hitLen: Math.max(1, m[0]?.length ?? 1) };
}

function locateAllByRegex(text: string, re: RegExp, maxMatches: number): LocatedMatch[] {
  re.lastIndex = 0;
  const out: LocatedMatch[] = [];
  const limit = Math.max(1, maxMatches);
  while (out.length < limit) {
    const m = re.exec(text);
    if (!m || typeof m.index !== "number") break;
    const matchText = typeof m[0] === "string" ? m[0] : "";
    out.push({ hitAt: m.index, hitLen: Math.max(1, matchText.length) });

    // Zero-length match guard to avoid infinite loops.
    if (matchText.length === 0) re.lastIndex += 1;
  }
  return out;
}

function locateByNeedle(text: string, needle: string, caseSensitive: boolean, hitLen: number): LocatedMatch | null {
  const hay = caseSensitive ? text : text.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  return { hitAt: idx, hitLen: Math.max(1, hitLen) };
}

function locateAllByNeedle(
  text: string,
  needle: string,
  caseSensitive: boolean,
  hitLen: number,
  maxMatches: number,
): LocatedMatch[] {
  const hay = caseSensitive ? text : text.toLowerCase();
  const out: LocatedMatch[] = [];
  const limit = Math.max(1, maxMatches);
  let offset = 0;
  while (out.length < limit) {
    const idx = hay.indexOf(needle, offset);
    if (idx < 0) break;
    out.push({ hitAt: idx, hitLen: Math.max(1, hitLen) });
    offset = idx + Math.max(1, needle.length);
  }
  return out;
}

function parseBooleanClauses(raw: string, caseSensitive: boolean): PlainClause[] | null {
  const orParts = raw
    .split(/\s+\bOR\b\s+/i)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (orParts.length === 0) return null;

  const clauses: PlainClause[] = [];
  for (const part of orParts) {
    const andParts = part
      .split(/\s+\bAND\b\s+/i)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (andParts.length === 0) return null;

    const conditions: PlainCondition[] = [];
    let positiveCount = 0;
    for (const token of andParts) {
      const parsed = parseConditionToken(token, caseSensitive);
      if (!parsed) return null;
      conditions.push(parsed);
      if (!parsed.negated) positiveCount += 1;
    }
    if (positiveCount === 0) return null;
    clauses.push({ conditions });
  }
  return clauses;
}

function parseConditionToken(token: string, caseSensitive: boolean): PlainCondition | null {
  const negatedMatch = token.match(/^\bNOT\b\s+(.+)$/i);
  const negated = !!negatedMatch;
  const textRaw = negated ? (negatedMatch?.[1] ?? "") : token;
  const text = stripWrappingQuotes(textRaw.trim());
  if (!text) return null;
  return {
    text,
    normalized: caseSensitive ? text : text.toLowerCase(),
    negated,
  };
}

function locateByClauses(
  text: string,
  clauses: PlainClause[],
  caseSensitive: boolean,
): LocatedMatch | null {
  const hay = caseSensitive ? text : text.toLowerCase();
  for (const clause of clauses) {
    let passed = true;
    let firstHitAt = Number.MAX_SAFE_INTEGER;
    let firstHitLen = 1;

    for (const c of clause.conditions) {
      const idx = hay.indexOf(c.normalized);
      const found = idx >= 0;
      if ((c.negated && found) || (!c.negated && !found)) {
        passed = false;
        break;
      }
      if (!c.negated && found && idx < firstHitAt) {
        firstHitAt = idx;
        firstHitLen = c.text.length;
      }
    }

    if (passed && Number.isFinite(firstHitAt) && firstHitAt !== Number.MAX_SAFE_INTEGER) {
      return { hitAt: firstHitAt, hitLen: Math.max(1, firstHitLen) };
    }
  }
  return null;
}

function stripWrappingQuotes(input: string): string {
  const s = input.trim();
  if (s.length >= 2 && ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function sanitizeTagFilter(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    const key = normalizeTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function normalizeTagKey(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function sanitizeSessionSourceFilter(sourceFilter: SessionSourceFilter | undefined): SessionSourceFilter {
  return sourceFilter === "codex" || sourceFilter === "claude" ? sourceFilter : "all";
}

function getSourceFilterLabel(sourceFilter: Exclude<SessionSourceFilter, "all">): string {
  return sourceFilter === "codex" ? t("history.filter.source.codex") : t("history.filter.source.claude");
}
