import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { resolveUiLanguage, t } from "../i18n";
import { getConfig } from "../settings";
import {
  RemoteCodexAppServerService, parseRemoteServerScan, remoteServerStatus,
  type RemoteServerCandidate, type RemoteServerScan, type RemoteServerStatus
} from "../services/remoteCodexAppServerService";

interface RemoteCodexResult {
  message: string;
  failed: boolean;
}

type RemoteCodexActivity = { kind: "scanning" } | { kind: "stopping"; pid: number };
type RemoteCodexScanFailure = "pythonMissing" | "unsupported" | "permission" | "failed";
interface RemoteCodexStopOutcome {
  status: Exclude<RemoteServerStatus, "ok">;
  pid: number;
  currentHost: boolean;
}

export interface RemoteCodexModel {
  labels: Record<string, string>;
  disabledReason?: string;
  scanned: boolean;
  notice: string;
  historyUpdated: string;
  currentHostWarning?: string;
  busy: boolean;
  stale: boolean;
  activity?: string;
  stopResult?: RemoteCodexResult;
  scanError?: string;
  candidates: {
    token: string;
    title: string;
    connection: string;
    currentHost: boolean;
    stopLabel: string;
    details: { label: string; value: string }[];
    blockedReason?: string;
  }[];
}

export class RemoteCodexController {
  private readonly service: RemoteCodexAppServerService;
  private abort = new AbortController();
  private epoch = 0;
  private scannedAt = 0;
  private scan: RemoteServerScan | undefined;
  private readonly candidates = new Map<string, RemoteServerCandidate>();
  private candidatesValid = false;
  private operationActive = false;
  private activity: RemoteCodexActivity | undefined;
  private stopResult: RemoteCodexStopOutcome | undefined;
  private scanError: RemoteCodexScanFailure | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.service = new RemoteCodexAppServerService(
      context.extensionPath,
      () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
    );
  }

  public get isOperationActive(): boolean {
    return this.operationActive;
  }

  public reset(): void {
    this.invalidateCandidates();
    this.scan = undefined;
    this.scannedAt = 0;
    this.candidates.clear();
    this.activity = undefined;
    this.stopResult = undefined;
    this.scanError = undefined;
  }

  private invalidateCandidates(): void {
    // Retained display data never authorizes another stop after invalidation.
    this.candidatesValid = false;
    this.epoch += 1;
    this.abort.abort();
    this.abort = new AbortController();
  }

  private disabledReason(): string | undefined {
    if (vscode.env.remoteName !== "ssh-remote" || process.platform !== "linux" ||
        this.context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
      return t("settingsPanel.remoteCodex.environment");
    }
    if (!getConfig().enableCodexSource) {
      return t("settingsPanel.disabled.source.codex");
    }
    return vscode.workspace.isTrusted ? undefined : t("settingsPanel.remoteCodex.trust");
  }

  private date(value: number | null): string {
    return value === null ? t("settingsPanel.remoteCodex.unavailable") :
      new Intl.DateTimeFormat(resolveUiLanguage(), { dateStyle: "medium", timeStyle: "long" }).format(value);
  }

  public model(): RemoteCodexModel | undefined {
    if (vscode.env.remoteName !== "ssh-remote" || !getConfig().enableCodexSource) {
      return undefined;
    }
    return {
      labels: {
        section: t("settingsPanel.remoteCodex.section"),
        title: t("settingsPanel.remoteCodex.title"),
        caution: t("settingsPanel.remoteCodex.caution"),
        warning: t("settingsPanel.remoteCodex.warning"),
        scan: t("settingsPanel.remoteCodex.scan"),
        stop: t("settingsPanel.remoteCodex.stop"),
        candidates: t("settingsPanel.remoteCodex.candidates"),
        stale: t("settingsPanel.remoteCodex.previousResults"),
        empty: t("settingsPanel.remoteCodex.empty"),
        historyHint: t("settingsPanel.remoteCodex.historyHint"),
        dependency: t("settingsPanel.remoteCodex.dependency")
      },
      disabledReason: this.disabledReason(),
      scanned: this.scan !== undefined,
      notice: this.scan ? t(!this.candidatesValid ? "settingsPanel.remoteCodex.previousScan" :
        this.scan.partial ? "settingsPanel.remoteCodex.partial" : "settingsPanel.remoteCodex.scanned", this.date(this.scannedAt)) : "",
      historyUpdated: t("settingsPanel.remoteCodex.history", this.date(this.scan?.historyUpdatedAt ?? null)),
      busy: this.operationActive,
      stale: !this.candidatesValid,
      activity: this.activity ? this.activity.kind === "scanning" ? t("settingsPanel.remoteCodex.scanning")
        : t("settingsPanel.remoteCodex.stopping", this.activity.pid) : undefined,
      stopResult: this.stopResult ? this.projectStopResult(this.stopResult) : undefined,
      scanError: this.scanError ? this.scanFailureMessage(this.scanError) : undefined,
      currentHostWarning: [...this.candidates.values()].some((candidate) => candidate.identity.hostRelation === "currentHost")
        ? t("settingsPanel.remoteCodex.currentHost") : undefined,
      candidates: [...this.candidates].map(([token, candidate]) => ({
        token,
        title: t("settingsPanel.remoteCodex.process", candidate.identity.pid),
        connection: candidate.identity.hostRelation === "currentHost" ? t("settingsPanel.remoteCodex.connectionCurrent")
          : candidate.identity.hostRelation === "otherHost" ? t("settingsPanel.remoteCodex.connectionOther")
          : t("settingsPanel.remoteCodex.connectionUnknown"),
        currentHost: candidate.identity.hostRelation === "currentHost",
        stopLabel: t("settingsPanel.remoteCodex.stopProcess", candidate.identity.pid),
        details: [
          { label: t("settingsPanel.remoteCodex.started"), value: this.date(candidate.startedAt) },
          { label: t("settingsPanel.remoteCodex.associatedHistory"), value: this.date(candidate.historyUpdatedAt) },
          { label: t("settingsPanel.remoteCodex.parent"), value: String(candidate.identity.ppid) },
          { label: t("settingsPanel.remoteCodex.version"), value: candidate.identity.version }
        ],
        blockedReason: candidate.identity.hostRelation === "unknownParent" ? t("settingsPanel.remoteCodex.unknownParent") : undefined
      }))
    };
  }

  public async run(
    action: "scanRemoteCodex" | "stopRemoteCodex",
    token: unknown,
    isCurrent: () => boolean,
    onChange: () => Promise<void> = async () => {}
  ): Promise<RemoteCodexResult> {
    const disabled = this.disabledReason();
    if (disabled || !isCurrent()) {
      return { message: disabled ?? t("settingsPanel.remoteCodex.stale"), failed: true };
    }
    if (this.operationActive) {
      return { message: t("settingsPanel.remoteCodex.busy"), failed: true };
    }
    this.operationActive = true;
    try {
      return action === "scanRemoteCodex" ? await this.refreshCandidates(isCurrent, onChange)
        : await this.stopCandidate(token, isCurrent, onChange);
    } finally {
      this.operationActive = false;
      this.activity = undefined;
    }
  }

  private isCurrentOperation(epoch: number, root: string, isCurrent: () => boolean): boolean {
    return isCurrent() && epoch === this.epoch && !this.disabledReason() && root === getConfig().sessionsRoot;
  }

  private async refreshCandidates(isCurrent: () => boolean, onChange: () => Promise<void>): Promise<RemoteCodexResult> {
    this.invalidateCandidates();
    const epoch = this.epoch;
    const root = getConfig().sessionsRoot;
    this.activity = { kind: "scanning" };
    this.scanError = undefined;
    await onChange();
    const cancelled = (): RemoteCodexResult => ({ message: t("settingsPanel.remoteCodex.scanCancelled"), failed: true });
    if (!this.isCurrentOperation(epoch, root, isCurrent)) {
      return cancelled();
    }
    let result: unknown;
    try {
      result = await this.service.run("scan", { root }, this.abort.signal);
    } catch {
      result = { status: "failed" };
    }
    if (!this.isCurrentOperation(epoch, root, isCurrent)) {
      return cancelled();
    }
    const scan = parseRemoteServerScan(result);
    if (!scan) {
      const status = remoteServerStatus(result);
      this.scanError = status === "pythonMissing" || status === "unsupported" || status === "permission" ? status : "failed";
      return { message: this.scanFailureMessage(this.scanError), failed: true };
    }
    this.scan = scan;
    this.scannedAt = Date.now();
    this.candidates.clear();
    for (const candidate of scan.candidates) {
      this.candidates.set(randomBytes(24).toString("hex"), candidate);
    }
    this.candidatesValid = true;
    return { message: t("settingsPanel.remoteCodex.scanComplete"), failed: false };
  }

  private async stopCandidate(token: unknown, isCurrent: () => boolean, onChange: () => Promise<void>): Promise<RemoteCodexResult> {
    const candidate = typeof token === "string" ? this.candidates.get(token) : undefined;
    const epoch = this.epoch;
    const root = getConfig().sessionsRoot;
    if (!this.candidatesValid || !candidate || candidate.identity.hostRelation === "unknownParent" || Date.now() - this.scannedAt > 300000) {
      return this.result("stale");
    }
    const currentHost = candidate.identity.hostRelation === "currentHost";
    const stopLabel = t("settingsPanel.remoteCodex.confirmStop");
    const selection = await vscode.window.showWarningMessage(
      t(currentHost ? "settingsPanel.remoteCodex.confirmCurrentTitle" : "settingsPanel.remoteCodex.confirmTitle", candidate.identity.pid),
      {
        modal: true,
        detail: (currentHost ? `${t("settingsPanel.remoteCodex.currentHost")}\n\n` : "") +
          t("settingsPanel.remoteCodex.confirmDetail", this.date(candidate.startedAt), this.date(candidate.historyUpdatedAt))
      }, stopLabel
    );
    if (selection !== stopLabel) {
      return { message: t("settingsPanel.remoteCodex.cancelled"), failed: false };
    }
    if (!this.isCurrentOperation(epoch, root, isCurrent) ||
        Date.now() - this.scannedAt > 300000) {
      return this.result("stale");
    }
    // Consume all tokens before dispatch, including when the helper cannot report its result.
    this.invalidateCandidates();
    const stopEpoch = this.epoch;
    this.activity = { kind: "stopping", pid: candidate.identity.pid };
    this.stopResult = undefined;
    this.scanError = undefined;
    await onChange();
    if (!this.isCurrentOperation(stopEpoch, root, isCurrent)) {
      return this.result("stale");
    }
    // Only the host can authorize stopping its own server, after the native confirmation.
    let result: unknown;
    try {
      result = await this.service.run("stop", { identity: candidate.identity, allowCurrentHost: currentHost }, this.abort.signal);
    } catch {
      // A failed transport must not claim that no termination request was sent.
      result = { status: "unknown" };
    }
    const status = remoteServerStatus(result);
    const outcome: RemoteCodexStopOutcome = {
      status: status === "ok" ? "failed" : status, pid: candidate.identity.pid, currentHost
    };
    if (!this.isCurrentOperation(stopEpoch, root, isCurrent)) {
      return this.projectStopResult(outcome);
    }
    this.stopResult = outcome;
    // Inspect once after every attempted stop; never retry the termination request.
    const refreshed = await this.refreshCandidates(isCurrent, onChange);
    return {
      message: this.stopResult === outcome ? t("settingsPanel.remoteCodex.resultsReady") : this.projectStopResult(outcome).message,
      failed: outcome.status !== "stopped" || refreshed.failed
    };
  }

  private scanFailureMessage(status: RemoteCodexScanFailure): string {
    const messages = {
      pythonMissing: t("settingsPanel.remoteCodex.scanPythonMissing"),
      unsupported: t("settingsPanel.remoteCodex.scanUnsupported"),
      permission: t("settingsPanel.remoteCodex.scanPermission"),
      failed: t("settingsPanel.remoteCodex.scanFailed")
    };
    return messages[status];
  }

  private projectStopResult(outcome: RemoteCodexStopOutcome): RemoteCodexResult {
    // Keep semantic outcomes stable while projecting every retained message in the current locale.
    const result = this.result(outcome.status);
    if (!result.failed && outcome.currentHost) {
      result.message += `\n\n${t("settingsPanel.remoteCodex.currentHost")}`;
    }
    return { ...result, message: t("settingsPanel.remoteCodex.stopResult", outcome.pid, result.message) };
  }

  private result(status: string): RemoteCodexResult {
    const messages: Record<string, string> = {
      stopped: t("settingsPanel.remoteCodex.stopped"),
      pending: t("settingsPanel.remoteCodex.pending"),
      unknown: t("settingsPanel.remoteCodex.unknown"),
      stale: t("settingsPanel.remoteCodex.stale"),
      permission: t("settingsPanel.remoteCodex.permission"),
      unsupported: t("settingsPanel.remoteCodex.unsupported"),
      pythonMissing: t("settingsPanel.remoteCodex.pythonMissing"),
      failed: t("settingsPanel.remoteCodex.failed")
    };
    return { message: messages[status] ?? messages.failed, failed: status !== "stopped" };
  }
}
