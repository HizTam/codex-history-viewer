import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import {
  CliResumeProbeScheduler,
  classifyCliResumeNativePath,
  type CliResumePathClassification,
} from "./cliResumeAvailability";

export type CliResumeDirectoryProbe =
  | { status: "available"; path: string }
  | { status: "missing" }
  | { status: "inaccessible" }
  | { status: "invalid" };

type CwdQuickPickItem = vscode.QuickPickItem & {
  kindId: "candidate" | "browse";
  fsPath?: string;
  classification?: CliResumePathClassification;
};

const DIRECTORY_PROBE_TIMEOUT_MS = 1_000;

export async function probeCliResumeDirectory(
  value: unknown,
  scheduler: CliResumeProbeScheduler,
  options: {
    allowRemote: boolean;
    isCancelled?: () => boolean;
  },
): Promise<CliResumeDirectoryProbe> {
  if (value === undefined || value === null) return { status: "missing" };
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return { status: "invalid" };

  const classification = classifyCliResumeNativePath(value);
  if (classification === "invalid" || (classification === "remote" && !options.allowRemote)) {
    return { status: "invalid" };
  }
  const isCancelled = options.isCancelled ?? (() => false);
  const statResult = await scheduler.schedule(() => fs.stat(value), isCancelled, DIRECTORY_PROBE_TIMEOUT_MS);
  if (statResult.status === "cancelled") return { status: "inaccessible" };
  if (statResult.status === "timeout") return { status: "inaccessible" };
  if (statResult.status === "failed") return mapDirectoryError(statResult.error);
  if (!statResult.value.isDirectory()) return { status: "invalid" };

  const accessMode = process.platform === "win32"
    ? fs.constants.F_OK | fs.constants.R_OK
    : fs.constants.F_OK | fs.constants.R_OK | fs.constants.X_OK;
  const accessResult = await scheduler.schedule(
    () => fs.access(value, accessMode),
    isCancelled,
    DIRECTORY_PROBE_TIMEOUT_MS,
  );
  if (accessResult.status === "completed") return { status: "available", path: value };
  if (accessResult.status === "failed") return mapDirectoryError(accessResult.error);
  return { status: "inaccessible" };
}

export class CliResumeCwdResolver {
  constructor(
    private readonly scheduler: CliResumeProbeScheduler,
    private readonly projectAssociationStore: ProjectAssociationStore,
  ) {}

  public async select(session: SessionSummary, isCancelled: () => boolean): Promise<string | undefined> {
    const recordedCwd = session.meta.cwd;
    const recordedClassification = classifyCliResumeNativePath(recordedCwd);
    const remoteWorkspaceMatch =
      recordedClassification === "remote" &&
      vscode.workspace.isTrusted &&
      this.isWorkspaceFolderPath(recordedCwd);
    const requiresExplicitRecordedSelection = recordedClassification === "remote" && !remoteWorkspaceMatch;

    const recordedProbe = requiresExplicitRecordedSelection
      ? { status: "invalid" as const }
      : await probeCliResumeDirectory(recordedCwd, this.scheduler, {
          allowRemote: remoteWorkspaceMatch,
          isCancelled,
        });
    if (isCancelled()) return undefined;
    if (recordedProbe.status === "available") return recordedProbe.path;

    const items: CwdQuickPickItem[] = [];
    const seen = new Set<string>();
    if (typeof recordedCwd === "string" && recordedClassification !== "invalid") {
      const recordedKey = normalizeCliResumeCwdCandidateKey(recordedCwd);
      if (recordedKey) seen.add(recordedKey);
    }
    if (requiresExplicitRecordedSelection && typeof recordedCwd === "string") {
      items.push({
        kindId: "candidate",
        fsPath: recordedCwd,
        classification: recordedClassification,
        label: t("cliResume.cwd.recordedRemote.label"),
        description: recordedCwd,
        detail: t("cliResume.cwd.recordedRemote.detail"),
      });
    }

    const relocationTarget = this.projectAssociationStore.getDisplayCwd(recordedCwd);
    // Alternative paths are probed only after explicit selection so slow paths cannot delay the picker.
    this.addCandidate(items, seen, relocationTarget, t("cliResume.cwd.relocation.label"));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.addCandidate(items, seen, folder.uri.fsPath, t("cliResume.cwd.workspace.label", folder.name));
    }
    if (isCancelled()) return undefined;

    items.push({
      kindId: "browse",
      label: t("cliResume.cwd.browse.label"),
      detail: t("cliResume.cwd.browse.detail"),
    });
    const selected = await vscode.window.showQuickPick(items, {
      title: t("cliResume.cwd.quickPick.title"),
      placeHolder: cwdProbeReason(recordedProbe.status, requiresExplicitRecordedSelection),
      ignoreFocusOut: true,
    });
    if (!selected || isCancelled()) return undefined;

    let selectedPath = selected.fsPath;
    if (selected.kindId === "browse") {
      const picked = await vscode.window.showOpenDialog({
        title: t("cliResume.cwd.folderPicker.title"),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!picked || picked.length !== 1 || isCancelled()) return undefined;
      selectedPath = picked[0]!.fsPath;
    }
    if (typeof selectedPath !== "string") return undefined;

    const selectedProbe = await probeCliResumeDirectory(selectedPath, this.scheduler, {
      allowRemote: true,
      isCancelled,
    });
    if (isCancelled()) return undefined;
    if (selectedProbe.status === "available") return selectedProbe.path;
    void vscode.window.showErrorMessage(directoryProbeError(selectedProbe.status));
    return undefined;
  }

  private addCandidate(
    items: CwdQuickPickItem[],
    seen: Set<string>,
    fsPath: string | null | undefined,
    label: string,
  ): void {
    if (typeof fsPath !== "string") return;
    const classification = classifyCliResumeNativePath(fsPath);
    if (classification === "invalid") return;
    const key = normalizeCliResumeCwdCandidateKey(fsPath);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ kindId: "candidate", fsPath, classification, label, description: fsPath });
  }

  private isWorkspaceFolderPath(fsPath: unknown): boolean {
    if (typeof fsPath !== "string") return false;
    const target = normalizeCliResumeCwdCandidateKey(fsPath);
    return (vscode.workspace.workspaceFolders ?? []).some(
      (folder) => normalizeCliResumeCwdCandidateKey(folder.uri.fsPath) === target,
    );
  }
}

export function normalizeCliResumeCwdCandidateKey(value: string): string {
  if (process.platform !== "win32") return value === "/" ? value : value.replace(/\/+$/u, "");
  const separatorNormalized = value.replace(/\//gu, "\\");
  let withoutTrailingSeparators = separatorNormalized.replace(/[\\]+$/u, "");
  if (/^[A-Za-z]:$/u.test(withoutTrailingSeparators)) withoutTrailingSeparators += "\\";
  return withoutTrailingSeparators.toLowerCase();
}

function mapDirectoryError(error: unknown): CliResumeDirectoryProbe {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR"
    ? { status: "missing" }
    : { status: "inaccessible" };
}

function cwdProbeReason(status: CliResumeDirectoryProbe["status"], remoteSelectionRequired: boolean): string {
  if (remoteSelectionRequired) return t("cliResume.cwd.reason.remoteSelectionRequired");
  if (status === "missing") return t("cliResume.cwd.reason.missing");
  if (status === "inaccessible") return t("cliResume.cwd.reason.inaccessible");
  return t("cliResume.cwd.reason.invalid");
}

function directoryProbeError(status: Exclude<CliResumeDirectoryProbe["status"], "available">): string {
  if (status === "missing") return t("cliResume.cwd.error.missing");
  if (status === "inaccessible") return t("cliResume.cwd.error.inaccessible");
  return t("cliResume.cwd.error.invalid");
}
