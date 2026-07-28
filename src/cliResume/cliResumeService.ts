import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { normalizeCacheKey } from "../utils/fsUtils";
import { probeCliResumeDirectory, type CliResumeCwdResolver } from "./cliResumeCwd";
import type { CliResumeProbeScheduler } from "./cliResumeAvailability";
import {
  buildCliResumeCommand,
  isCliResumeSessionEligible,
  validateCliResumeSessionId,
  type CliResumeTarget,
} from "./cliResumeValidation";

export type CliResumeTargetResolution =
  | { status: "resolved"; session: SessionSummary }
  | { status: "none" | "multiple" | "invalid" };

type CliResumeSessionIdentity = {
  fsPath: string;
  fsPathKey: string;
  source: SessionSummary["source"];
  archiveState: SessionSummary["storage"]["archiveState"];
  id: unknown;
};

type CliResumeCurrentResolution = CliResumeTargetResolution | { status: "stale" };

export class CliResumeService {
  private readonly inFlight = new Set<string>();
  private readonly duplicateNoticeShown = new Set<string>();

  constructor(
    private readonly historyService: HistoryService,
    private readonly scheduler: CliResumeProbeScheduler,
    private readonly cwdResolver: CliResumeCwdResolver,
    private readonly resolveTarget: (input: unknown) => CliResumeTargetResolution,
  ) {}

  public async prepare(input: unknown, target: CliResumeTarget): Promise<boolean> {
    const resolution = this.resolveTarget(input);
    if (resolution.status !== "resolved") {
      this.showResolutionError(resolution.status);
      return false;
    }

    const initialSession = resolution.session;
    const initialIdentity: CliResumeSessionIdentity = {
      fsPath: initialSession.fsPath,
      fsPathKey: normalizeCacheKey(initialSession.fsPath),
      source: initialSession.source,
      archiveState: initialSession.storage.archiveState,
      id: initialSession.meta.id,
    };
    const guardKey = `${target}:${initialIdentity.fsPathKey}`;
    if (this.inFlight.has(guardKey)) {
      if (!this.duplicateNoticeShown.has(guardKey)) {
        this.duplicateNoticeShown.add(guardKey);
        void vscode.window.showInformationMessage(t("cliResume.info.alreadyPreparing"));
      }
      return false;
    }
    this.inFlight.add(guardKey);
    let dispatched = false;

    try {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage(t("cliResume.error.workspaceUntrusted"));
        return false;
      }
      if (!isCliResumeSessionEligible(initialSession, target)) {
        void vscode.window.showErrorMessage(t("cliResume.error.sessionIneligible"));
        return false;
      }
      if (!validateCliResumeSessionId(initialSession.meta.id, target)) {
        void vscode.window.showErrorMessage(t("cliResume.error.invalidSessionId"));
        return false;
      }

      let cwd: string | undefined;
      try {
        cwd = await this.cwdResolver.select(initialSession, () => !this.inFlight.has(guardKey));
      } catch {
        void vscode.window.showErrorMessage(t("cliResume.error.cwdSelection"));
        return false;
      }
      if (!cwd || !this.inFlight.has(guardKey)) return false;

      let latestResolution = this.resolveCurrentEligibleSession(target, initialIdentity);
      if (latestResolution.status !== "resolved") {
        this.showResolutionError(latestResolution.status);
        return false;
      }
      let latestSession = latestResolution.session;

      const cwdProbe = await probeCliResumeDirectory(cwd, this.scheduler, {
        allowRemote: true,
        isCancelled: () => !this.inFlight.has(guardKey),
      });
      if (cwdProbe.status !== "available") {
        void vscode.window.showErrorMessage(t(`cliResume.cwd.error.${cwdProbe.status}`));
        return false;
      }

      latestResolution = this.resolveCurrentEligibleSession(target, initialIdentity);
      if (latestResolution.status !== "resolved") {
        this.showResolutionError(latestResolution.status);
        return false;
      }
      latestSession = latestResolution.session;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage(t("cliResume.error.workspaceUntrusted"));
        return false;
      }

      const latestId = validateCliResumeSessionId(latestSession.meta.id, target);
      if (!latestId) {
        void vscode.window.showErrorMessage(t("cliResume.error.staleSession"));
        return false;
      }
      const command = buildCliResumeCommand(target, latestId);
      let terminal: vscode.Terminal | undefined;
      try {
        terminal = vscode.window.createTerminal({
          name: target === "codex" ? t("cliResume.terminal.codex") : t("cliResume.terminal.claude"),
          cwd: cwdProbe.path,
        });
        terminal.sendText(command, false);
        terminal.show();
        dispatched = true;
      } catch {
        try {
          terminal?.dispose();
        } catch {
          // Preserve the original dispatch failure even if best-effort cleanup also fails.
        }
        void vscode.window.showErrorMessage(t("cliResume.error.terminalDispatch"));
        return false;
      }
    } finally {
      this.inFlight.delete(guardKey);
      this.duplicateNoticeShown.delete(guardKey);
    }
    if (!dispatched) return false;
    void vscode.window.showInformationMessage(
      target === "codex" ? t("cliResume.prepared.codex") : t("cliResume.prepared.claude"),
    );
    return true;
  }

  private resolveCurrentEligibleSession(
    target: CliResumeTarget,
    initialIdentity: CliResumeSessionIdentity,
  ): CliResumeCurrentResolution {
    const currentSession = resolveUniqueSession(this.historyService, initialIdentity.fsPath);
    if (
      !currentSession ||
      currentSession.source !== initialIdentity.source ||
      currentSession.storage.archiveState !== initialIdentity.archiveState ||
      currentSession.meta.id !== initialIdentity.id ||
      !isCliResumeSessionEligible(currentSession, target)
    ) {
      return { status: "stale" };
    }
    return { status: "resolved", session: currentSession };
  }

  private showResolutionError(status: Exclude<CliResumeCurrentResolution["status"], "resolved">): void {
    void vscode.window.showErrorMessage(
      status === "multiple"
        ? t("cliResume.error.multipleSelection")
        : status === "stale"
          ? t("cliResume.error.staleSession")
          : t("cliResume.error.singleSessionRequired"),
    );
  }
}

function resolveUniqueSession(historyService: HistoryService, fsPath: string): SessionSummary | undefined {
  const key = normalizeCacheKey(fsPath);
  const matches = historyService.getIndex().sessions.filter((session) => normalizeCacheKey(session.fsPath) === key);
  return matches.length === 1 ? matches[0] : undefined;
}
