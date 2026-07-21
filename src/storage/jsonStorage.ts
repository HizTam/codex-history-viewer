import * as vscode from "vscode";

// Safe JSON read/write helpers for global storage (UTF-8).

export type JsonReadFailureReason = "missing" | "parseError" | "readError";

export type JsonReadResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: JsonReadFailureReason;
      errorName?: string;
    };

export interface JsonDeleteResult {
  deleted: boolean;
  errorName?: string;
}

export interface JsonReadOrDropCorruptResult<T> {
  result: JsonReadResult<T>;
  deletion?: JsonDeleteResult;
}

export async function readJson<T>(uri: vscode.Uri): Promise<T | null> {
  const result = await readJsonDetailed<T>(uri);
  return result.ok ? result.value : null;
}

export async function readJsonDetailed<T>(uri: vscode.Uri): Promise<JsonReadResult<T>> {
  let buf: Uint8Array;
  try {
    buf = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    return {
      ok: false,
      reason: isFileNotFoundError(error) ? "missing" : "readError",
      ...formatJsonError(error),
    };
  }

  try {
    const text = new TextDecoder("utf-8").decode(buf);
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof SyntaxError ? "parseError" : "readError",
      ...formatJsonError(error),
    };
  }
}

export async function deleteJsonFileAfterParseError<T>(
  uri: vscode.Uri,
  result: JsonReadResult<T>,
): Promise<JsonDeleteResult> {
  if (result.ok || result.reason !== "parseError") return { deleted: false };
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
    return { deleted: true };
  } catch (error) {
    return { deleted: false, ...formatJsonError(error) };
  }
}

export async function readJsonOrDropCorrupt<T>(uri: vscode.Uri): Promise<JsonReadOrDropCorruptResult<T>> {
  const result = await readJsonDetailed<T>(uri);
  if (result.ok || result.reason !== "parseError") return { result };
  const deletion = await deleteJsonFileAfterParseError(uri, result);
  return { result, deletion };
}

export function formatJsonReadOrDropCorruptDebug<T>(
  prefix: string,
  outcome: JsonReadOrDropCorruptResult<T>,
): string | null {
  const { result, deletion } = outcome;
  if (result.ok || result.reason === "missing") return null;

  const parts = [`${prefix} ${result.reason}`];
  if (result.reason === "parseError") parts.push(`deleted=${deletion?.deleted ? 1 : 0}`);
  if (result.errorName) parts.push(`error=${result.errorName}`);
  if (deletion?.errorName) parts.push(`deleteError=${deletion.errorName}`);
  return parts.join(" ");
}

export async function writeJson<T>(
  uri: vscode.Uri,
  data: T,
  options?: { pretty?: boolean; beforeCommit?: () => void },
): Promise<void> {
  const pretty = options?.pretty ?? true;
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const buf = new TextEncoder().encode(text);
  const tmpUri = buildTempJsonUri(uri);
  try {
    await vscode.workspace.fs.writeFile(tmpUri, buf);
  } catch (error) {
    await deleteQuietly(tmpUri);
    throw error;
  }

  try {
    options?.beforeCommit?.();
  } catch (error) {
    await deleteQuietly(tmpUri);
    throw error;
  }

  try {
    await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
  } catch {
    try {
      options?.beforeCommit?.();
      await vscode.workspace.fs.writeFile(uri, buf);
    } finally {
      await deleteQuietly(tmpUri);
    }
  }
}

function buildTempJsonUri(uri: vscode.Uri): vscode.Uri {
  const pathValue = uri.path;
  const slash = pathValue.lastIndexOf("/");
  const dir = slash >= 0 ? pathValue.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? pathValue.slice(slash + 1) : pathValue;
  const lowerName = fileName.toLowerCase();
  const ext = lowerName.endsWith(".json") ? fileName.slice(fileName.length - 5) : "";
  const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return uri.with({ path: `${dir}${stem}.tmp-${suffix}${ext || ".json"}` });
}

async function deleteQuietly(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  } catch {
    // Best-effort cleanup only.
  }
}

export function isFileNotFoundError(error: unknown): boolean {
  const code = getErrorCode(error);
  const name = getErrorName(error);
  return code === "FileNotFound" || code === "ENOENT" || name === "FileNotFound";
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function formatJsonError(error: unknown): { errorName?: string } {
  if (error instanceof Error) {
    return { errorName: error.name };
  }
  if (typeof error === "string") return { errorName: "StringError" };
  return {};
}
