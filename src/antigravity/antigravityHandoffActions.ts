import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { normalizeFsPathKey } from "../utils/fsUtils";
import type { HistoryService } from "../services/historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { sourceInventoryConfigKey } from "../sessions/sourceInventory";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { resolveCodexLogicalHistoryPlan } from "../sessions/codexHistoryBase";
import { getClaudeAgentDependencyStamp } from "../sessions/claudeAgentHistory";
import { antigravityReader } from "./antigravityReader";
import { AntigravityHandoffCapacityError, AntigravityHandoffCoordinator, AntigravityHandoffInterrupted, type AntigravityHandoffOperation } from "./antigravityHandoff";
import { buildHandoffPrompt, canReuseHandoffFile, createHandoff, isHandoffPathRewriteStale, protectHandoffDirectory, readHandoffMetadata, resolveHandoffLocation, selectCurrentHandoffLocation, updateHandoffTarget, validateExistingHandoffFile,
  type HandoffPathRewriteContext, type HandoffResult, type HandoffTarget } from "../services/handoffService";

export type AntigravityHandoffAction = "dispatch" | "create" | "copyPrompt" | "copyPath" | "open";
interface Dependencies {
  readonly globalStorageUri: vscode.Uri;
  readonly history: HistoryService;
  sourceRoot(session: SessionSummary): string;
  pathRewrite(session: SessionSummary): HandoffPathRewriteContext;
  refreshStorage(): Promise<void>;
}

// Source permissions and target preparation remain separate: a G target never enables its Reader.
export class AntigravityHandoffActions implements vscode.Disposable {
  private readonly coordinator = new AntigravityHandoffCoordinator();
  private sourceReads = 0;
  constructor(private readonly dependencies: Dependencies) {}
  public dispose(): void { this.coordinator.dispose(); }

  public async run(session: SessionSummary, requestedTarget: HandoffTarget | null, action: AntigravityHandoffAction): Promise<boolean> {
    const initial = getConfig(), sourceKey = sourceInventoryConfigKey(initial, session.source), sourceGeneration = this.dependencies.history.getSourceIndexGeneration(session.source);
    const readerRevision = antigravityReader.getConfigurationRevision(), sourceRoot = this.dependencies.sourceRoot(session), rewrite = this.dependencies.pathRewrite(session), rewriteKey = JSON.stringify(rewrite), host = vscode.env.remoteName;
    if (!initial.handoffEnabled) { void vscode.window.showErrorMessage(t("handoff.disabled")); return false; }
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage(t("handoff.native.workspaceUntrusted")); return false; }
    const valid = (): boolean => {
      const cfg = getConfig(), current = this.dependencies.history.findByFsPath(session.fsPath);
      const sourceState = this.dependencies.history.getIndex().sourceInventoryStates[session.source], relative = path.relative(session.storage.rootPath, session.fsPath);
      const enabled = session.source === "antigravity" ? cfg.enableAntigravitySource : session.source === "claude" ? cfg.enableClaudeSource
        : session.storage.archiveState === "archived" ? cfg.enableCodexArchivedSessions : cfg.enableCodexSource;
      return cfg.handoffEnabled && enabled && vscode.workspace.isTrusted && vscode.env.remoteName === host && current?.source === session.source && current.identityKey === session.identityKey
        && sourceState.configKey === sourceKey && sourceState.allowedRoots.some(root => normalizeFsPathKey(root) === normalizeFsPathKey(session.storage.rootPath))
        && Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && current.meta.id === session.meta.id && normalizeFsPathKey(current.storage.rootPath) === normalizeFsPathKey(session.storage.rootPath)
        && sourceInventoryConfigKey(cfg, session.source) === sourceKey && this.dependencies.history.getSourceIndexGeneration(session.source) === sourceGeneration
        && JSON.stringify(this.dependencies.pathRewrite(current)) === rewriteKey && this.dependencies.sourceRoot(current) === sourceRoot
        && (session.source !== "antigravity" || antigravityReader.getConfigurationRevision() === readerRevision);
    };
    let originalProtection: ReturnType<typeof protectHandoffDirectory> | undefined;
    try {
      if (session.source === "codex" && requestedTarget && requestedTarget !== "codex") {
        const original = resolveHandoffLocation({ globalStorageUri: this.dependencies.globalStorageUri, session, sourceSessionsRoot: sourceRoot, target: requestedTarget });
        // The answer projection can select a sibling while maintenance still knows the original directory.
        originalProtection = protectHandoffDirectory(original.directoryUri.fsPath);
      }
      return await this.coordinator.run(session.identityKey, requestedTarget, action, valid, async operation => {
        let target = requestedTarget;
        if (!target) {
          if (session.source !== "antigravity") return false;
          if (action === "open") {
            const location = resolveHandoffLocation({ globalStorageUri: this.dependencies.globalStorageUri, session, sourceSessionsRoot: sourceRoot, target: "codex" });
            const metadata = await operation.wait(() => readHandoffMetadata(location.metadataUri), 30000);
            if (metadata.native?.identityKey === session.identityKey && (metadata.target === "codex" || metadata.target === "claude")) target = metadata.target;
          }
          if (!target) {
            const selected = await operation.wait(() => vscode.window.showQuickPick([
              { label: t("history.filter.source.codex"), target: "codex" as const }, { label: t("history.filter.source.claude"), target: "claude" as const },
            ], { title: t("handoff.native.chooseTarget"), ignoreFocusOut: true }, operation.token));
            if (!selected) return false; target = selected.target;
          }
        }
        if (target === session.source || !["codex", "claude", "antigravity"].includes(target)) return false;
        const inventory = this.dependencies.history.getIndex().historySources ?? this.dependencies.history.getIndex().sessions;
        operation.setStage("reading");
        const signature = await operation.wait(() => this.sourceSignature(session, inventory, operation.token), 30000);
        const verifySource = async (): Promise<void> => {
          operation.assertCurrent();
          if (await operation.wait(() => this.sourceSignature(session, inventory, operation.token), 30000) !== signature) throw new AntigravityHandoffInterrupted("stale");
        };
        const prepared = await this.prepare(session, target, action, operation, sourceRoot, rewrite, signature, verifySource, inventory);
        if (!prepared) return false;
        const { result, generated } = prepared;
        operation.setStage("published"); operation.protect(result.directoryUri.fsPath);
        if (generated) await operation.wait(() => this.dependencies.refreshStorage(), 30000);
        const verifyPrepared = async (): Promise<void> => {
          const storage = this.dependencies.globalStorageUri;
          if (!await operation.wait(() => validateExistingHandoffFile(storage, result), 30000) ||
              !await operation.wait(() => canReuseHandoffFile(storage, result), 30000)) throw new AntigravityHandoffInterrupted("stale");
          const metadata = await operation.wait(() => readHandoffMetadata(result.metadataUri), 30000);
          if (metadata.target !== result.target || metadata.source !== result.source ||
              (session.source === "codex" && !metadata.codexAnswerProjection) ||
              (session.source === "antigravity" && metadata.native?.identityKey !== session.identityKey)) {
            throw new AntigravityHandoffInterrupted("stale");
          }
        };
        await verifyPrepared();
        if (action === "open") { await operation.wait(() => vscode.window.showTextDocument(result.handoffUri, { preview: false }), 30000); return true; }
        if (action === "copyPath" || action === "copyPrompt") {
          if (!await this.copyResult(result, action, operation, verifyPrepared)) return false;
          operation.assertCurrent(); void vscode.window.showInformationMessage(t(action === "copyPath" ? "handoff.copyPathDone" : "handoff.copyPromptDone")); return true;
        }
        if (action === "create") { operation.assertCurrent(); void vscode.window.showInformationMessage(t("handoff.fileReady")); return true; }
        operation.setStage("preparingTarget");
        const requested = await this.requestTarget(session, target, result, operation, verifySource, verifyPrepared);
        if (target !== "claude" || !requested) {
          await verifyPrepared();
          if (!await this.copyResult(result, "copyPrompt", operation, verifyPrepared)) return false;
        }
        operation.assertCurrent();
        const message = !requested && target !== "codex" ? t("handoff.native.targetUnavailableCopied")
          : target === "antigravity" ? t("handoff.native.antigravityRequestedCopied") : target === "claude" ? t("handoff.native.claudeRequested") : t("handoff.native.codexCopied");
        void vscode.window.showInformationMessage(message); return true;
      });
    } catch (error) {
      if (error instanceof AntigravityHandoffInterrupted) {
        if (error.reason === "timeout") void vscode.window.showWarningMessage(t("handoff.native.timeout"));
        else if (error.reason === "stale") void vscode.window.showWarningMessage(t("handoff.native.stale"));
      } else void vscode.window.showErrorMessage(t("handoff.createFailed"));
      return false;
    } finally { originalProtection?.dispose(); }
  }

  private async copyResult(result: HandoffResult, action: "copyPath" | "copyPrompt", operation: AntigravityHandoffOperation, verifyPrepared: () => Promise<void>): Promise<boolean> {
    try {
      await operation.wait(() => vscode.env.clipboard.writeText(action === "copyPath" ? result.handoffPath : result.promptText), 30000);
      return true;
    } catch (error) {
      if (error instanceof AntigravityHandoffInterrupted || error instanceof AntigravityHandoffCapacityError) throw error;
      operation.releaseForSelection();
      const open = { title: t("handoff.action.openFile") };
      const choice = await operation.wait(() => vscode.window.showErrorMessage(t(action === "copyPath" ? "handoff.copyPathFailed" : "handoff.copyPromptFailed"), open));
      if (choice === open) {
        operation.setStage("published");
        operation.protect(result.directoryUri.fsPath);
        await verifyPrepared();
        try { await operation.wait(() => vscode.window.showTextDocument(result.handoffUri, { preview: false }), 30000); }
        catch (error) {
          if (error instanceof AntigravityHandoffInterrupted || error instanceof AntigravityHandoffCapacityError) throw error;
          void vscode.window.showErrorMessage(t("handoff.openFileFailed"));
        }
      }
      return false;
    }
  }

  private async prepare(session: SessionSummary, target: HandoffTarget, action: AntigravityHandoffAction, operation: AntigravityHandoffOperation, sourceRoot: string,
    rewrite: HandoffPathRewriteContext, signature: string, verifySource: () => Promise<void>, inventory: readonly SessionSummary[]): Promise<{ result: HandoffResult; generated: boolean } | null> {
    const base = { globalStorageUri: this.dependencies.globalStorageUri, session, sourceSessionsRoot: sourceRoot, target };
    const selection = await operation.wait(() => selectCurrentHandoffLocation(base), 30000);
    const { location } = selection;
    const options = { ...base, selection };
    let existing = await operation.wait(() => validateExistingHandoffFile(options.globalStorageUri, location), 30000);
    if (existing) {
      const metadata = await operation.wait(() => readHandoffMetadata(location.metadataUri), 30000);
      const canReuse = metadata.source === session.source &&
        (session.source !== "antigravity" || metadata.native?.identityKey === session.identityKey) &&
        await operation.wait(() => canReuseHandoffFile(options.globalStorageUri, location), 30000);
      const stale = !canReuse || isHandoffPathRewriteStale(metadata, rewrite)
        || session.source === "antigravity" && (metadata.native?.identityKey !== session.identityKey || metadata.native.digest !== signature);
      if (action !== "open" || stale) {
        operation.releaseForSelection();
        const reuse = { title: t("handoff.action.useExistingFile"), reuse: true }, recreate = { title: t("handoff.action.recreateFile"), reuse: false };
        const choice = await operation.wait(() => !canReuse ? vscode.window.showWarningMessage(t("handoff.native.invalidMetadata"), recreate)
          : stale ? vscode.window.showWarningMessage(t("handoff.native.staleConfirm"), recreate, reuse) : vscode.window.showInformationMessage(t("handoff.existingConfirm"), reuse, recreate));
        if (!choice) return null;
        operation.setStage("reading");
        existing = choice.reuse;
      }
      if (existing && (!await operation.wait(() => validateExistingHandoffFile(options.globalStorageUri, location), 30000) ||
          !await operation.wait(() => canReuseHandoffFile(options.globalStorageUri, location), 30000))) {
        void vscode.window.showWarningMessage(t("handoff.native.fileRemoved")); return null;
      }
      if (existing) {
        await verifySource(); operation.protect(location.directoryUri.fsPath);
        await operation.wait(() => updateHandoffTarget({ ...options, assertCurrent: () => operation.assertCurrent() }), 30000);
        return { result: { ...location, promptText: buildHandoffPrompt(location.handoffPath), createdAtIso: metadata.createdAt ?? new Date().toISOString() }, generated: false };
      }
    }
    operation.protect(location.directoryUri.fsPath);
    const result = await operation.wait(() => createHandoff({ ...options, pathRewrite: rewrite, sessionInventory: inventory, token: operation.token,
      assertCurrent: () => operation.assertCurrent(), validateSource: verifySource }), 30000);
    return { result, generated: true };
  }

  private async sourceSignature(session: SessionSummary, inventory: readonly SessionSummary[], token: vscode.CancellationToken): Promise<string> {
    if (this.sourceReads >= 4) throw new Error("Handoff source read capacity reached.");
    this.sourceReads++;
    try { return await this.readSourceSignature(session, inventory, token); }
    finally { this.sourceReads--; }
  }

  private async readSourceSignature(session: SessionSummary, inventory: readonly SessionSummary[], token: vscode.CancellationToken): Promise<string> {
    if (token.isCancellationRequested) throw new AntigravityHandoffInterrupted("cancelled");
    if (session.source === "antigravity") return (await antigravityReader.readSession(session.fsPath, token)).digest;
    const stat = await fs.stat(session.fsPath, { bigint: true }), meta = await tryReadSessionMeta(session.fsPath);
    if (!stat.isFile() || !meta || meta.id !== session.meta.id) throw new AntigravityHandoffInterrupted("stale");
    const dependency = session.source === "codex" ? (await resolveCodexLogicalHistoryPlan(session.fsPath, inventory)).signature
      : await getClaudeAgentDependencyStamp(session.fsPath, session.storage.rootPath);
    return createHash("sha256").update(JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), dependency])).digest("hex");
  }

  private async requestTarget(session: SessionSummary, target: HandoffTarget, result: HandoffResult, operation: AntigravityHandoffOperation, verifySource: () => Promise<void>, verifyPrepared: () => Promise<void>): Promise<boolean> {
    if (target === "codex") { await verifySource(); return true; }
    // A remote Host cannot establish that the target UI reads this Host's generated path.
    if (vscode.env.remoteName) return false;
    const extension = vscode.extensions.getExtension(target === "antigravity" ? "google.google-antigravity" : "anthropic.claude-code");
    if (!extension) return false;
    try {
      await operation.wait(() => extension.activate(), 30000);
      const commands = await operation.wait(() => vscode.commands.getCommands(true), 30000), command = target === "antigravity" ? "antigravity.startNewConversation" : "claude-vscode.editor.open";
      if (!commands.includes(command)) return false;
      await verifySource(); await verifyPrepared(); operation.assertCurrent();
      if (target === "antigravity") {
        const cwd = this.dependencies.pathRewrite(session).displayCwd ?? session.meta.cwd;
        const folder = cwd && path.isAbsolute(cwd) ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) : undefined;
        await operation.dispatch(() => vscode.commands.executeCommand(command, folder?.uri.toString()));
      } else await operation.dispatch(() => vscode.commands.executeCommand(command, undefined, result.promptText));
      return true;
    } catch (error) { if (error instanceof AntigravityHandoffInterrupted || error instanceof AntigravityHandoffCapacityError) throw error; operation.assertCurrent(); return false; }
  }
}
