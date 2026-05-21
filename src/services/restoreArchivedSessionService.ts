import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { SessionSummary } from "../sessions/sessionTypes";
import { findSessionFiles } from "../sessions/sessionDiscovery";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { pad2, toYmdInTimeZone } from "../utils/dateUtils";
import { normalizeCacheKey, pathExists } from "../utils/fsUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import type { HistoryService } from "./historyService";
import type { DebugLogger } from "./logger";
import { formatDebugFields, safeDebugBasename, sanitizeDebugError } from "./debugLogUtils";

const OPENAI_CODEX_EXTENSION_ID = "openai.chatgpt";
const OFFICIAL_RESTORE_TIMEOUT_MS = 10_000;
const OFFICIAL_ARCHIVE_TIMEOUT_MS = 10_000;

export type RestoreArchivedSessionProvider = "existingActive" | "official" | "filesystem";
export type ArchiveSessionProvider = "existingArchived" | "official";

export type RestoreArchivedSessionResult =
  | {
      kind: "alreadyActive";
      archivedFsPath: string;
      activeFsPath: string;
      summary: SessionSummary;
      provider: "existingActive";
      undoable: false;
    }
  | {
      kind: "restored";
      archivedFsPath: string;
      activeFsPath: string;
      summary: SessionSummary;
      provider: "official" | "filesystem";
      undoable: boolean;
    };

export interface RestoreArchivedSessionOptions {
  preferOfficialProvider?: boolean;
  extensionVersion?: string;
  logger?: DebugLogger;
}

export type ArchiveSessionResult =
  | {
      kind: "alreadyArchived";
      activeFsPath: string;
      archivedFsPath: string;
      summary: SessionSummary;
      provider: "existingArchived";
      undoable: false;
    }
  | {
      kind: "archived";
      activeFsPath: string;
      archivedFsPath: string;
      summary: SessionSummary;
      provider: "official";
      undoable: false;
    };

export interface ArchiveSessionOptions {
  extensionVersion?: string;
  logger?: DebugLogger;
}

interface OfficialUnarchiveResponse {
  thread: Record<string, unknown>;
}

export async function restoreArchivedSessionToActive(
  session: SessionSummary,
  historyService: HistoryService,
  config: CodexHistoryViewerConfig,
  options: RestoreArchivedSessionOptions = {},
): Promise<RestoreArchivedSessionResult> {
  if (session.source !== "codex" || session.storage.archiveState !== "archived") {
    throw new Error("Only archived Codex sessions can be restored.");
  }

  const existingActive = historyService.getIndex().byIdentityKey.get(session.identityKey);
  if (existingActive && existingActive.storage.archiveState === "active") {
    return {
      kind: "alreadyActive",
      archivedFsPath: session.fsPath,
      activeFsPath: existingActive.fsPath,
      summary: existingActive,
      provider: "existingActive",
      undoable: false,
    };
  }

  if (options.preferOfficialProvider !== false) {
    const official = await tryRestoreArchivedSessionViaOfficialProvider(session, config, options);
    if (official) return official;
  }

  return restoreArchivedSessionViaFilesystem(session, config);
}

export async function archiveSessionToArchived(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  options: ArchiveSessionOptions = {},
): Promise<ArchiveSessionResult> {
  if (session.source !== "codex") {
    throw new Error("Only Codex sessions can be archived.");
  }
  if (session.storage.archiveState === "archived") {
    return {
      kind: "alreadyArchived",
      activeFsPath: session.fsPath,
      archivedFsPath: session.fsPath,
      summary: session,
      provider: "existingArchived",
      undoable: false,
    };
  }
  if (!config.enableCodexArchivedSessions) {
    throw new Error("Codex archived sessions are not enabled.");
  }

  const result = await tryArchiveSessionViaOfficialProvider(session, config, options);
  if (!result) throw new Error("Official Codex archive provider is not available.");
  return result;
}

async function restoreArchivedSessionViaFilesystem(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
): Promise<RestoreArchivedSessionResult> {
  const dateTime = resolveDateTimeSettings();
  const ymd = await resolveSessionCreationYmd(session, dateTime.timeZone);
  const destDir = path.join(config.sessionsRoot, String(ymd.year), pad2(ymd.month), pad2(ymd.day));
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destDir));

  const destPath = await resolveUniqueDestinationPath(path.join(destDir, path.basename(session.fsPath)));
  await moveSessionFileNoOverwrite(session.fsPath, destPath);
  await touchPathQuiet(destDir);
  await touchPathQuiet(config.sessionsRoot);

  const summary =
    (await buildSessionSummary({
      sessionsRoot: config.sessionsRoot,
      sourceRoot: config.sessionsRoot,
      storage: {
        rootKind: "codexSessions",
        archiveState: "active",
        rootPath: config.sessionsRoot,
      },
      fsPath: destPath,
      previewMaxMessages: config.previewMaxMessages,
      timeZone: dateTime.timeZone,
    })) ?? {
      ...session,
      fsPath: destPath,
      cacheKey: normalizeCacheKey(destPath),
      storage: {
        rootKind: "codexSessions",
        archiveState: "active",
        rootPath: config.sessionsRoot,
      },
      inferredYmd: ymd,
    };

  return {
    kind: "restored",
    archivedFsPath: session.fsPath,
    activeFsPath: destPath,
    summary,
    provider: "filesystem",
    undoable: true,
  };
}

async function tryRestoreArchivedSessionViaOfficialProvider(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  options: RestoreArchivedSessionOptions,
): Promise<RestoreArchivedSessionResult | null> {
  const threadId = resolveOfficialThreadId(session);
  if (!threadId) {
    options.logger?.debug(
      formatDebugFields("restoreArchived.official.skip", {
        reason: "missingThreadId",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  const codexHome = resolveCodexHomeForConfiguredRoots(config);
  if (!codexHome) {
    options.logger?.debug(
      formatDebugFields("restoreArchived.official.skip", {
        reason: "unsupportedRoots",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  const executablePath = await resolveOfficialCodexExecutablePath();
  if (!executablePath) {
    options.logger?.debug(
      formatDebugFields("restoreArchived.official.skip", {
        reason: "missingExecutable",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  try {
    const response = await sendOfficialUnarchiveRequest({
      executablePath,
      codexHome,
      threadId,
      extensionVersion: options.extensionVersion ?? "unknown",
      timeoutMs: OFFICIAL_RESTORE_TIMEOUT_MS,
    });
    const summary = await resolveOfficialRestoredSummary(session, config, response.thread);
    if (!summary) {
      const archivedStillExists = await pathExists(session.fsPath);
      if (archivedStillExists) throw new Error("Official provider did not expose the restored session path.");
      throw new Error("Official provider restored the thread, but the active session path could not be resolved.");
    }

    options.logger?.debug(
      formatDebugFields("restoreArchived.official.ok", {
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return {
      kind: "restored",
      archivedFsPath: session.fsPath,
      activeFsPath: summary.fsPath,
      summary,
      provider: "official",
      undoable: false,
    };
  } catch (err) {
    if (!(await pathExists(session.fsPath))) throw err;
    options.logger?.debug(
      formatDebugFields("restoreArchived.official.fallback", {
        reason: sanitizeDebugError(err),
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }
}

async function tryArchiveSessionViaOfficialProvider(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  options: ArchiveSessionOptions,
): Promise<ArchiveSessionResult | null> {
  const threadId = resolveOfficialThreadId(session);
  if (!threadId) {
    options.logger?.debug(
      formatDebugFields("archiveSession.official.skip", {
        reason: "missingThreadId",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  const codexHome = resolveCodexHomeForConfiguredRoots(config);
  if (!codexHome) {
    options.logger?.debug(
      formatDebugFields("archiveSession.official.skip", {
        reason: "unsupportedRoots",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  const executablePath = await resolveOfficialCodexExecutablePath();
  if (!executablePath) {
    options.logger?.debug(
      formatDebugFields("archiveSession.official.skip", {
        reason: "missingExecutable",
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return null;
  }

  try {
    await sendOfficialArchiveRequest({
      executablePath,
      codexHome,
      threadId,
      extensionVersion: options.extensionVersion ?? "unknown",
      timeoutMs: OFFICIAL_ARCHIVE_TIMEOUT_MS,
    });
    const summary = await resolveOfficialArchivedSummary(session, config);
    if (!summary) {
      const activeStillExists = await pathExists(session.fsPath);
      if (activeStillExists) throw new Error("Official provider did not expose the archived session path.");
      throw new Error("Official provider archived the thread, but the archived session path could not be resolved.");
    }

    options.logger?.debug(
      formatDebugFields("archiveSession.official.ok", {
        file: safeDebugBasename(session.fsPath),
      }),
    );
    return {
      kind: "archived",
      activeFsPath: session.fsPath,
      archivedFsPath: summary.fsPath,
      summary,
      provider: "official",
      undoable: false,
    };
  } catch (err) {
    options.logger?.debug(
      formatDebugFields("archiveSession.official.failed", {
        reason: sanitizeDebugError(err),
        file: safeDebugBasename(session.fsPath),
      }),
    );
    throw err;
  }
}

function resolveOfficialThreadId(session: SessionSummary): string | null {
  const threadId = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
  if (!threadId || threadId.length > 256) return null;
  if (/[\r\n\t]/.test(threadId)) return null;
  return threadId;
}

function resolveCodexHomeForConfiguredRoots(config: CodexHistoryViewerConfig): string | null {
  const sessionsRoot = path.resolve(config.sessionsRoot);
  const archivedRoot = path.resolve(config.codexArchivedSessionsRoot);
  if (path.basename(sessionsRoot).toLowerCase() !== "sessions") return null;
  if (path.basename(archivedRoot).toLowerCase() !== "archived_sessions") return null;

  const sessionsParent = path.dirname(sessionsRoot);
  const archivedParent = path.dirname(archivedRoot);
  if (normalizeCacheKey(sessionsParent) !== normalizeCacheKey(archivedParent)) return null;
  return sessionsParent;
}

async function resolveOfficialCodexExecutablePath(): Promise<string | null> {
  const configuredCliPath = (vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable") ?? "").trim();
  if (configuredCliPath && (await isReadableFile(configuredCliPath))) return configuredCliPath;

  const extension = vscode.extensions.getExtension(OPENAI_CODEX_EXTENSION_ID);
  if (!extension) return null;

  for (const candidate of getBundledCodexExecutableCandidates(extension.extensionPath)) {
    if (await isReadableFile(candidate)) return candidate;
  }
  return findAnyBundledCodexExecutable(extension.extensionPath);
}

function getBundledCodexExecutableCandidates(extensionPath: string): string[] {
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platformNames =
    process.platform === "win32"
      ? [`windows-${arch}`, "windows-x86_64"]
      : process.platform === "darwin"
        ? [`macos-${arch}`, `darwin-${arch}`, "macos-aarch64", "macos-x86_64", "darwin-aarch64", "darwin-x86_64"]
        : [`linux-${arch}`, "linux-x86_64"];
  return platformNames.map((platformName) => path.join(extensionPath, "bin", platformName, executableName));
}

async function findAnyBundledCodexExecutable(extensionPath: string): Promise<string | null> {
  const binRoot = path.join(extensionPath, "bin");
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(binRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(binRoot, entry.name, executableName);
    if (await isReadableFile(candidate)) return candidate;
  }
  return null;
}

async function isReadableFile(fsPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(fsPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sendOfficialUnarchiveRequest(params: {
  executablePath: string;
  codexHome: string;
  threadId: string;
  extensionVersion: string;
  timeoutMs: number;
}): Promise<OfficialUnarchiveResponse> {
  return sendOfficialThreadRequest({
    ...params,
    method: "thread/unarchive",
    requestParams: { threadId: params.threadId },
    parseResult: (result) => parseOfficialUnarchiveResponse(result, params.threadId),
  });
}

async function sendOfficialArchiveRequest(params: {
  executablePath: string;
  codexHome: string;
  threadId: string;
  extensionVersion: string;
  timeoutMs: number;
}): Promise<void> {
  await sendOfficialThreadRequest({
    ...params,
    method: "thread/archive",
    requestParams: { threadId: params.threadId },
    parseResult: parseOfficialArchiveResponse,
  });
}

async function sendOfficialThreadRequest<T>(params: {
  executablePath: string;
  codexHome: string;
  method: string;
  requestParams: Record<string, unknown>;
  parseResult: (result: unknown) => T;
  extensionVersion: string;
  timeoutMs: number;
}): Promise<T> {
  const child = spawn(params.executablePath, ["app-server", "--listen", "stdio://"], {
    cwd: params.codexHome,
    env: {
      ...process.env,
      CODEX_HOME: params.codexHome,
      NO_COLOR: "1",
    },
    windowsHide: true,
  });

  return new Promise<T>((resolve, reject) => {
    const initializeId = 1;
    const requestId = 2;
    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";

    const timer = setTimeout(() => {
      finish({ error: new Error("Official Codex provider timed out.") });
    }, params.timeoutMs);

    const finish = (result: { response?: T; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // Closing stdin is best-effort once the request has completed.
      }
      try {
        child.kill();
      } catch {
        // The process may have already exited.
      }
      if (result.error) reject(result.error);
      else resolve(result.response as T);
    };

    const send = (message: Record<string, unknown>): void => {
      if (settled) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    };

    const fail = (message: string): void => {
      const stderr = stderrTail.trim();
      finish({ error: new Error(stderr ? `${message}: ${stderr}` : message) });
    };

    const handleMessage = (message: unknown): void => {
      if (!isRecord(message)) return;

      if (message.id === initializeId) {
        const error = formatJsonRpcError(message.error);
        if (error) {
          fail(`Official Codex initialize failed: ${error}`);
          return;
        }

        const codexHome = isRecord(message.result) ? message.result.codexHome : undefined;
        if (
          typeof codexHome === "string" &&
          normalizeCacheKey(path.resolve(codexHome)) !== normalizeCacheKey(path.resolve(params.codexHome))
        ) {
          fail("Official Codex provider resolved a different CODEX_HOME");
          return;
        }

        send({
          id: requestId,
          method: params.method,
          params: params.requestParams,
        });
        return;
      }

      if (message.id === requestId) {
        const error = formatJsonRpcError(message.error);
        if (error) {
          fail(`Official Codex ${params.method} failed: ${error}`);
          return;
        }
        const response = params.parseResult(message.result);
        finish({ response });
        return;
      }

      if (typeof message.id !== "undefined" && typeof message.method === "string") {
        send({
          id: message.id,
          error: {
            code: -32601,
            message: "Unsupported request.",
          },
        });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let lineEnd = stdoutBuffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdoutBuffer.slice(0, lineEnd).trim();
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        if (line.startsWith("{")) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (err) {
            fail(`Official Codex returned invalid JSON: ${sanitizeDebugError(err)}`);
            return;
          }
          try {
            handleMessage(parsed);
          } catch (err) {
            fail(`Official Codex response handling failed: ${sanitizeDebugError(err)}`);
          }
        }
        lineEnd = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    child.once("error", (err) => {
      finish({ error: err instanceof Error ? err : new Error(String(err)) });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      fail(`Official Codex provider exited before completing the request (${signal ?? code ?? "unknown"})`);
    });

    send({
      id: initializeId,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-history-viewer",
          title: "Codex History Viewer",
          version: params.extensionVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
  });
}

function parseOfficialUnarchiveResponse(result: unknown, expectedThreadId: string): OfficialUnarchiveResponse {
  if (!isRecord(result) || !isRecord(result.thread)) {
    throw new Error("Official Codex unarchive response did not include a thread.");
  }
  const threadId = typeof result.thread.id === "string" ? result.thread.id : "";
  if (threadId && threadId !== expectedThreadId) {
    throw new Error("Official Codex unarchive response returned a different thread.");
  }
  return { thread: result.thread };
}

function parseOfficialArchiveResponse(result: unknown): void {
  if (!isRecord(result)) {
    throw new Error("Official Codex archive response was invalid.");
  }
}

function formatJsonRpcError(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = typeof error.code === "number" ? String(error.code) : "";
  return [code, message].filter(Boolean).join(" ") || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveOfficialRestoredSummary(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  thread: Record<string, unknown>,
): Promise<SessionSummary | null> {
  const dateTime = resolveDateTimeSettings();
  const threadPath = typeof thread.path === "string" ? thread.path : null;
  if (threadPath && isPathInsideRoot(threadPath, config.sessionsRoot) && (await pathExists(threadPath))) {
    return (
      (await buildActiveSummaryFromPath(session, config, threadPath, dateTime.timeZone, { acceptMatchingThread: true })) ??
      makeActiveFallbackSummary(session, config, threadPath)
    );
  }

  const expected = await getExpectedActivePaths(session, config, dateTime.timeZone);
  for (const candidate of expected) {
    const summary = await buildActiveSummaryFromPath(session, config, candidate, dateTime.timeZone, {
      acceptMatchingThread: false,
    });
    if (summary) return summary;
  }

  return findActiveSummaryByIdentity(session, config, dateTime.timeZone);
}

async function resolveOfficialArchivedSummary(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
): Promise<SessionSummary | null> {
  const dateTime = resolveDateTimeSettings();
  const expected = await getExpectedArchivedPaths(session, config, dateTime.timeZone);
  for (const candidate of expected) {
    const summary = await buildArchivedSummaryFromPath(session, config, candidate, dateTime.timeZone);
    if (summary) return summary;
  }

  return findArchivedSummaryByIdentity(session, config, dateTime.timeZone);
}

async function getExpectedActivePaths(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  timeZone: string,
): Promise<string[]> {
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const key = normalizeCacheKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(candidate);
  };

  const relFromArchive = path.relative(path.resolve(config.codexArchivedSessionsRoot), path.resolve(session.fsPath));
  if (relFromArchive && !relFromArchive.startsWith("..") && !path.isAbsolute(relFromArchive)) {
    add(path.join(config.sessionsRoot, relFromArchive));
  }

  const ymd = await resolveSessionCreationYmd(session, timeZone);
  add(path.join(config.sessionsRoot, String(ymd.year), pad2(ymd.month), pad2(ymd.day), path.basename(session.fsPath)));
  return results;
}

async function getExpectedArchivedPaths(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  timeZone: string,
): Promise<string[]> {
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const key = normalizeCacheKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(candidate);
  };

  const relFromActive = path.relative(path.resolve(config.sessionsRoot), path.resolve(session.fsPath));
  if (relFromActive && !relFromActive.startsWith("..") && !path.isAbsolute(relFromActive)) {
    add(path.join(config.codexArchivedSessionsRoot, relFromActive));
  }

  const ymd = await resolveSessionCreationYmd(session, timeZone);
  add(
    path.join(
      config.codexArchivedSessionsRoot,
      String(ymd.year),
      pad2(ymd.month),
      pad2(ymd.day),
      path.basename(session.fsPath),
    ),
  );
  return results;
}

async function findActiveSummaryByIdentity(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  timeZone: string,
): Promise<SessionSummary | null> {
  const files = await findSessionFiles({
    codexRoot: config.sessionsRoot,
    codexArchivedRoot: config.codexArchivedSessionsRoot,
    claudeRoot: config.claudeSessionsRoot,
    includeCodex: true,
    includeCodexArchived: false,
    includeClaude: false,
  });

  const basename = path.basename(session.fsPath);
  const threadId = typeof session.meta.id === "string" ? session.meta.id : "";
  files.sort(
    (a, b) =>
      scoreCandidateSessionPath(b.fsPath, basename, threadId) -
      scoreCandidateSessionPath(a.fsPath, basename, threadId),
  );

  for (const file of files) {
    const summary = await buildActiveSummaryFromPath(session, config, file.fsPath, timeZone, {
      acceptMatchingThread: false,
    });
    if (summary) return summary;
  }
  return null;
}

async function findArchivedSummaryByIdentity(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  timeZone: string,
): Promise<SessionSummary | null> {
  const files = await findSessionFiles({
    codexRoot: config.sessionsRoot,
    codexArchivedRoot: config.codexArchivedSessionsRoot,
    claudeRoot: config.claudeSessionsRoot,
    includeCodex: false,
    includeCodexArchived: true,
    includeClaude: false,
  });

  const basename = path.basename(session.fsPath);
  const threadId = typeof session.meta.id === "string" ? session.meta.id : "";
  files.sort(
    (a, b) =>
      scoreCandidateSessionPath(b.fsPath, basename, threadId) -
      scoreCandidateSessionPath(a.fsPath, basename, threadId),
  );

  for (const file of files) {
    const summary = await buildArchivedSummaryFromPath(session, config, file.fsPath, timeZone);
    if (summary) return summary;
  }
  return null;
}

function scoreCandidateSessionPath(fsPath: string, basename: string, threadId: string): number {
  let score = 0;
  if (path.basename(fsPath) === basename) score += 2;
  if (threadId && fsPath.includes(threadId)) score += 1;
  return score;
}

async function buildActiveSummaryFromPath(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  fsPath: string,
  timeZone: string,
  options: { acceptMatchingThread: boolean },
): Promise<SessionSummary | null> {
  if (!isPathInsideRoot(fsPath, config.sessionsRoot) || !(await pathExists(fsPath))) return null;
  const summary = await buildSessionSummary({
    sessionsRoot: config.sessionsRoot,
    sourceRoot: config.sessionsRoot,
    storage: {
      rootKind: "codexSessions",
      archiveState: "active",
      rootPath: config.sessionsRoot,
    },
    fsPath,
    previewMaxMessages: config.previewMaxMessages,
    timeZone,
  });
  if (!summary) return null;
  if (summary.identityKey === session.identityKey) return summary;
  if (options.acceptMatchingThread && session.meta.id && summary.meta.id === session.meta.id) return summary;
  return null;
}

async function buildArchivedSummaryFromPath(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  fsPath: string,
  timeZone: string,
): Promise<SessionSummary | null> {
  if (!isPathInsideRoot(fsPath, config.codexArchivedSessionsRoot) || !(await pathExists(fsPath))) return null;
  const summary = await buildSessionSummary({
    sessionsRoot: config.sessionsRoot,
    sourceRoot: config.codexArchivedSessionsRoot,
    storage: {
      rootKind: "codexArchivedSessions",
      archiveState: "archived",
      rootPath: config.codexArchivedSessionsRoot,
    },
    fsPath,
    previewMaxMessages: config.previewMaxMessages,
    timeZone,
  });
  if (!summary) return null;
  if (summary.identityKey === session.identityKey) return summary;
  if (session.meta.id && summary.meta.id === session.meta.id) return summary;
  return null;
}

function makeActiveFallbackSummary(
  session: SessionSummary,
  config: CodexHistoryViewerConfig,
  fsPath: string,
): SessionSummary {
  return {
    ...session,
    fsPath,
    cacheKey: normalizeCacheKey(fsPath),
    storage: {
      rootKind: "codexSessions",
      archiveState: "active",
      rootPath: config.sessionsRoot,
    },
  };
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const root = normalizeCacheKey(path.resolve(rootPath));
  const target = normalizeCacheKey(path.resolve(fsPath));
  if (target === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(rootWithSep);
}

export async function moveSessionFileNoOverwrite(srcPath: string, destPath: string): Promise<void> {
  const srcUri = vscode.Uri.file(srcPath);
  const destUri = vscode.Uri.file(destPath);
  if (normalizeCacheKey(srcPath) === normalizeCacheKey(destPath)) return;
  await assertDestinationMissing(destUri);

  try {
    await vscode.workspace.fs.rename(srcUri, destUri, { overwrite: false });
    return;
  } catch {
    await copyVerifyDelete(srcUri, destUri);
  }
}

async function copyVerifyDelete(srcUri: vscode.Uri, destUri: vscode.Uri): Promise<void> {
  const tempUri = vscode.Uri.file(`${destUri.fsPath}.tmp-${Date.now().toString(36)}`);
  try {
    await vscode.workspace.fs.copy(srcUri, tempUri, { overwrite: false });
    const [srcStat, tempStat] = await Promise.all([vscode.workspace.fs.stat(srcUri), vscode.workspace.fs.stat(tempUri)]);
    if (srcStat.size !== tempStat.size) {
      throw new Error("Copied session size does not match source.");
    }
    await assertDestinationMissing(destUri);
    await vscode.workspace.fs.rename(tempUri, destUri, { overwrite: false });
    await vscode.workspace.fs.delete(srcUri, { recursive: false, useTrash: false });
  } catch (err) {
    try {
      await vscode.workspace.fs.delete(tempUri, { recursive: false, useTrash: false });
    } catch {
      // Temporary cleanup failure should not hide the original move error.
    }
    throw err;
  }
}

async function assertDestinationMissing(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return;
  }
  throw new Error(`Destination already exists: ${uri.fsPath}`);
}

async function resolveUniqueDestinationPath(initialPath: string): Promise<string> {
  const parsed = path.parse(initialPath);
  for (let i = 0; i <= 999; i += 1) {
    const candidate =
      i === 0 ? initialPath : path.join(parsed.dir, `${parsed.name}-restored-${String(i)}${parsed.ext}`);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
    } catch {
      return candidate;
    }
  }
  throw new Error("Could not resolve a unique restore destination.");
}

async function resolveSessionCreationYmd(
  session: SessionSummary,
  timeZone: string,
): Promise<{ year: number; month: number; day: number }> {
  const startedMs = Date.parse(session.startedAtIso ?? session.meta.timestampIso ?? "");
  if (Number.isFinite(startedMs)) return toYmdInTimeZone(new Date(startedMs), timeZone);
  if (session.inferredYmd) return session.inferredYmd;
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(session.fsPath));
    return toYmdInTimeZone(new Date(stat.mtime), timeZone);
  } catch {
    return toYmdInTimeZone(new Date(), timeZone);
  }
}

async function touchPathQuiet(targetPath: string): Promise<void> {
  try {
    const now = new Date();
    await fsp.utimes(targetPath, now, now);
  } catch {
    // Some file systems do not allow directory mtime updates through VS Code FS.
  }
}
