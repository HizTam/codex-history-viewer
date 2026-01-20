import * as fs from "node:fs";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { normalizeWhitespace, safeDisplayPath, singleLineSnippet } from "../utils/textUtils";
import { SearchRootNode, SearchSessionNode, type SearchHit } from "../tree/treeNodes";
import { getDateScopeValue, sanitizeDateScope, type DateScope } from "../types/dateScope";
import { normalizeCacheKey } from "../utils/fsUtils";

// Search UI (free text) and streaming JSONL scanning.
// Date scoping is provided by the History view filter.

export async function runSearchFlow(
  index: HistoryIndex,
  config: CodexHistoryViewerConfig,
  scope?: DateScope,
  projectCwd?: string | null,
): Promise<{ root: SearchRootNode; sessions: SearchSessionNode[] } | null> {
  if (index.sessions.length === 0) {
    void vscode.window.showInformationMessage(t("app.noSessionsFound"));
    return null;
  }

  const effectiveScope = sanitizeDateScope(scope);
  const query = await vscode.window.showInputBox({
    prompt: t("search.input.query"),
    validateInput: (v) => (v.trim().length === 0 ? t("search.invalidFormat") : undefined),
  });
  if (!query) return null;

  const project = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
  const candidates = index.sessions.filter((s) => matchScope(s, effectiveScope) && matchProject(s, project));

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("app.searching"), cancellable: true },
    async (progress, token) => {
      return await searchSessions({
        sessions: candidates,
        query,
        maxResults: config.searchMaxResults,
        caseSensitive: config.searchCaseSensitive,
        token,
        progress,
      });
    },
  );

  if (!results) return null;

  // Reflect date/project filters in the scope label (search view root description).
  const scopeParts: string[] = [];
  const datePart = effectiveScope.kind === "all" ? t("search.filter.all") : getDateScopeValue(effectiveScope);
  if (datePart) scopeParts.push(datePart);
  if (project) scopeParts.push(t("history.filter.projectLabel", safeDisplayPath(project, 50)));
  const scopeValue = scopeParts.join(" / ");

  const root = new SearchRootNode({
    query,
    scopeKind: effectiveScope.kind,
    scopeValue,
    totalHits: results.totalHits,
  });
  const sessionNodes = results.sessions.map((s) => new SearchSessionNode(s.session, s.hits));
  return { root, sessions: sessionNodes };
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

async function searchSessions(params: {
  sessions: SessionSummary[];
  query: string;
  maxResults: number;
  caseSensitive: boolean;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
}): Promise<{ totalHits: number; sessions: Array<{ session: SessionSummary; hits: SearchHit[] }> } | null> {
  const { sessions, query, maxResults, caseSensitive, token, progress } = params;
  const normalizedNeedle = caseSensitive ? query : query.toLowerCase();

  const bySession = new Map<string, { session: SessionSummary; hits: SearchHit[] }>();
  let totalHits = 0;

  const total = sessions.length;
  for (let i = 0; i < sessions.length; i += 1) {
    if (token.isCancellationRequested) return null;
    const s = sessions[i]!;

    progress.report({ message: `${i + 1}/${total}` });

    let msgIndex = 0;
    const stream = fs.createReadStream(s.fsPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (token.isCancellationRequested) return null;
        if (totalHits >= maxResults) break;
        if (!line) continue;

        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.type !== "response_item") continue;
        if (obj?.payload?.type !== "message") continue;
        const role = obj?.payload?.role;
        if (role !== "user" && role !== "assistant") continue;

        const textRaw = extractTextFromContent(obj?.payload?.content);
        const text = normalizeWhitespace(textRaw);
        if (!text) continue;

        msgIndex += 1;

        const hay = caseSensitive ? text : text.toLowerCase();
        const hitAt = hay.indexOf(normalizedNeedle);
        if (hitAt < 0) continue;

        const snippet = singleLineSnippet(buildAround(text, hitAt, query.length), 160);
        const hit: SearchHit = { messageIndex: msgIndex, role, snippet };

        if (!bySession.has(s.cacheKey)) bySession.set(s.cacheKey, { session: s, hits: [] });
        bySession.get(s.cacheKey)!.hits.push(hit);
        totalHits += 1;
        if (totalHits >= maxResults) break;
      }
    } finally {
      rl.close();
      stream.close();
    }
  }

  const list = Array.from(bySession.values());
  // Sort by newest session; within a session, keep message order.
  list.sort((a, b) => {
    if (a.session.localDate !== b.session.localDate) return a.session.localDate < b.session.localDate ? 1 : -1;
    return a.session.timeLabel < b.session.timeLabel ? 1 : a.session.timeLabel > b.session.timeLabel ? -1 : 0;
  });
  for (const s of list) s.hits.sort((a, b) => a.messageIndex - b.messageIndex);

  return { totalHits, sessions: list };
}

function extractTextFromContent(content: unknown): string {
  // Concatenate payload.content[].text (ignore unknown shapes).
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as any).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function buildAround(text: string, hitAt: number, needleLen: number): string {
  // Build a snippet around the match position.
  const before = 40;
  const after = 80;
  const start = Math.max(0, hitAt - before);
  const end = Math.min(text.length, hitAt + needleLen + after);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${text.slice(start, end)}${tail}`;
}
