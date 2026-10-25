import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";

export type RemoteServerStatus =
  | "ok" | "stopped" | "pending" | "unknown" | "stale" | "permission"
  | "unsupported" | "pythonMissing" | "failed";

export interface RemoteServerIdentity {
  pid: number;
  ppid: number;
  ticks: string;
  uid: number;
  executable: string;
  device: string;
  inode: string;
  args: string[];
  version: string;
  hostRelation: "currentHost" | "otherHost" | "unknownParent";
}

interface RemoteServerStopRequest {
  identity: RemoteServerIdentity;
  allowCurrentHost?: boolean;
}

export interface RemoteServerCandidate {
  identity: RemoteServerIdentity;
  startedAt: number;
  historyUpdatedAt: number | null;
}

export interface RemoteServerScan {
  status: "ok";
  candidates: RemoteServerCandidate[];
  partial: boolean;
  historyUpdatedAt: number | null;
  historyComplete: boolean;
}

const STATUSES = new Set<RemoteServerStatus>([
  "ok", "stopped", "pending", "unknown", "stale", "permission",
  "unsupported", "pythonMissing", "failed"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function timestamp(value: unknown): value is number | null {
  return value === null || (integer(value) && value <= 8640000000000000);
}

function isCandidate(value: unknown): value is RemoteServerCandidate {
  if (!isRecord(value) || !isRecord(value.identity)) {
    return false;
  }
  const item = value.identity;
  return integer(item.pid, 2) && integer(item.ppid) && integer(item.uid) &&
    typeof item.ticks === "string" && /^\d{1,25}$/.test(item.ticks) &&
    typeof item.device === "string" && /^\d{1,25}$/.test(item.device) &&
    typeof item.inode === "string" && /^\d{1,25}$/.test(item.inode) &&
    typeof item.executable === "string" && item.executable.length <= 4096 &&
    path.posix.isAbsolute(item.executable) && !item.executable.includes("\0") &&
    typeof item.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(item.version) &&
    (item.hostRelation === "otherHost" || item.hostRelation === "currentHost" || item.hostRelation === "unknownParent") &&
    Array.isArray(item.args) && item.args.length > 1 && item.args.length <= 32 &&
    item.args.every((arg: unknown) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0")) &&
    value.startedAt !== null && timestamp(value.startedAt) && timestamp(value.historyUpdatedAt);
}

export function parseRemoteServerScan(value: unknown): RemoteServerScan | undefined {
  if (!isRecord(value) || value.status !== "ok" || !Array.isArray(value.candidates) ||
      value.candidates.length > 100 || !value.candidates.every(isCandidate) ||
      typeof value.partial !== "boolean" || typeof value.historyComplete !== "boolean" ||
      !timestamp(value.historyUpdatedAt)) {
    return undefined;
  }
  const ids = new Set(value.candidates.map((item) => item.identity.pid));
  return ids.size === value.candidates.length ? value as unknown as RemoteServerScan : undefined;
}

export function remoteServerStatus(value: unknown): RemoteServerStatus {
  return isRecord(value) && typeof value.status === "string" && STATUSES.has(value.status as RemoteServerStatus)
    ? value.status as RemoteServerStatus : "failed";
}

export function remotePythonCandidates(searchPath: string | undefined): string[] {
  // Ignore relative/empty entries instead of treating them as the working directory.
  const directories = typeof searchPath === "string" && searchPath.length <= 32768
    ? searchPath.split(":").slice(0, 256) : [];
  const candidates = directories
    .filter((directory) => directory.length <= 4096 && !directory.includes("\0") && path.posix.isAbsolute(directory))
    .map((directory) => path.posix.join(directory, "python3"));
  return [...new Set([...candidates, "/usr/local/bin/python3", "/usr/bin/python3", "/bin/python3"])];
}

function withinDirectory(filename: string, directory: string): boolean {
  const relative = path.posix.relative(directory, filename);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
}

export class RemoteCodexAppServerService {
  public constructor(
    private readonly extensionPath: string,
    private readonly workspacePaths: () => readonly string[] = () => []
  ) {}

  public async run(
    operation: "scan" | "stop",
    data: { root: string } | RemoteServerStopRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    if (process.platform !== "linux" || signal.aborted) {
      return { status: "failed" };
    }
    const discovery = new AbortController();
    const cancelDiscovery = (): void => discovery.abort();
    signal.addEventListener("abort", cancelDiscovery, { once: true });
    const timer = setTimeout(cancelDiscovery, 10000);
    try {
      const cancelled = new Promise<{ status: RemoteServerStatus }>((resolve) => {
        discovery.signal.addEventListener("abort", () => resolve({ status: "failed" }), { once: true });
      });
      const selected = await Promise.race([this.findPython(discovery.signal), cancelled]);
      if (signal.aborted || discovery.signal.aborted) {
        return { status: "failed" };
      }
      if (!("python" in selected)) {
        return selected;
      }
      // Discovery probes cannot stop a server. Dispatch the requested operation exactly once.
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelDiscovery);
      return await this.invoke(selected.python, operation, data, signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelDiscovery);
    }
  }

  private async findPython(signal: AbortSignal): Promise<{ python: string } | { status: RemoteServerStatus }> {
    const excluded = new Set<string>();
    for (const folder of this.workspacePaths()) {
      if (!path.posix.isAbsolute(folder) || folder.includes("\0")) {
        continue;
      }
      excluded.add(path.posix.normalize(folder));
      try {
        excluded.add(await fs.realpath(folder));
      } catch {
        // Without a canonical workspace boundary, do not execute a PATH candidate.
        return { status: "failed" };
      }
    }
    const blocked = (filename: string): boolean => [...excluded].some((folder) => withinDirectory(filename, folder));
    const seen = new Set<string>();
    let failure: RemoteServerStatus = "pythonMissing";
    for (const candidate of remotePythonCandidates(process.env.PATH)) {
      if (signal.aborted) {
        return { status: "failed" };
      }
      if (blocked(candidate)) {
        continue;
      }
      let executable: string;
      try {
        executable = await fs.realpath(candidate);
        if (seen.has(executable) || blocked(executable) || !(await fs.stat(executable)).isFile()) {
          continue;
        }
        await fs.access(executable, constants.X_OK);
      } catch {
        // Missing, broken, or inaccessible candidates are not usable interpreters.
        continue;
      }
      seen.add(executable);
      const status = remoteServerStatus(await this.invoke(executable, "probe", {}, signal));
      if (status === "ok") {
        return { python: executable };
      }
      if (status !== "pythonMissing" && (failure === "pythonMissing" || status === "unsupported")) {
        failure = status;
      }
    }
    return { status: failure };
  }

  private invoke(
    python: string,
    operation: "probe" | "scan" | "stop",
    data: { root: string } | RemoteServerStopRequest | Record<string, never>,
    signal: AbortSignal
  ): Promise<unknown> {
    const request = JSON.stringify({ operation, hostPid: process.pid, ...data });
    if (process.platform !== "linux" || signal.aborted || Buffer.byteLength(request, "utf8") > 16384) {
      return Promise.resolve({ status: "failed" });
    }
    return new Promise((resolve) => {
      const child = spawn(python, [
        "-I", "-S", "-B", "-X", "utf8",
        path.join(this.extensionPath, "resources", "helpers", "remote_codex_app_server.py")
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: "/" });
      let output = "";
      let bytes = 0;
      let settled = false;
      const uncertain = { status: operation === "stop" ? "unknown" : "failed" };
      const finish = (result: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => {
        child.kill(); // This handle belongs only to our helper, never to the target server.
        finish(uncertain);
      };
      const timer = setTimeout(abort, operation === "stop" ? 55000 : operation === "probe" ? 3000 : 15000);
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > 1048576) {
          abort();
        } else {
          output += chunk;
        }
      });
      child.stderr.resume(); // Do not log process paths, command lines, or Python diagnostics.
      child.stdin.on("error", abort);
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({ status: error.code === "ENOENT" ? "pythonMissing" : "failed" });
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(uncertain);
          return;
        }
        try {
          finish(JSON.parse(output) as unknown);
        } catch {
          finish(uncertain);
        }
      });
      if (signal.aborted) {
        abort();
      } else {
        child.stdin.end(request, "utf8");
      }
    });
  }
}
