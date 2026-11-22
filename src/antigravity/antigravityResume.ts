import * as vscode from "vscode";
import { t } from "../i18n";
import { getConfig } from "../settings";
import type { HistoryService } from "../services/historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { antigravityReader } from "./antigravityReader";
import { captureAntigravitySourceScope, hasAntigravitySessionPermission, isAntigravitySourceScopeCurrent } from "./antigravitySessionScope";

const EXTENSION_ID = "google.google-antigravity";
const OPEN_CONVERSATION_COMMAND = "antigravity.openConversation";
const PHASE_TIMEOUT_MS = 15_000;

export interface AntigravityResumeInvocation {
  readonly owner: object;
  readonly isCurrent: () => boolean;
}

// The official extension resolves IDs in its own store; no history root or URI is forwarded.
export class AntigravityResumeService implements vscode.Disposable {
  private sequence = 0;
  private disposed = false;
  private active?: { key: string; owner?: object; current: () => boolean; promise: Promise<boolean>; cancel: vscode.CancellationTokenSource };
  constructor(private readonly history: Pick<HistoryService, "getIndex" | "findByFsPath">) {}

  public resume(session: SessionSummary, invocation?: AntigravityResumeInvocation): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const invocationCurrent = (): boolean => {
      try { return invocation?.isCurrent() !== false; } catch { return false; }
    };
    if (!invocationCurrent()) return Promise.resolve(false);
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage(t("app.resumeSessionInAntigravityUntrusted")); return Promise.resolve(false); }
    if (vscode.env.remoteName) { void vscode.window.showErrorMessage(t("app.resumeSessionInAntigravityRemote")); return Promise.resolve(false); }
    const config = getConfig(), index = this.history.getIndex();
    if (!hasAntigravitySessionPermission(config, index, session) || this.history.findByFsPath(session.fsPath)?.identityKey !== session.identityKey) {
      void vscode.window.showErrorMessage(t("app.resumeSessionInAntigravityFailed")); return Promise.resolve(false);
    }
    const scope = captureAntigravitySourceScope(config, index, [session]);
    const key = JSON.stringify(scope);
    if (this.active?.key === key && this.active.owner === invocation?.owner && this.active.current()) return this.active.promise;
    this.active?.cancel.cancel();
    const sequence = ++this.sequence, cancellation = new vscode.CancellationTokenSource();
    const deadline = Date.now() + 30_000;
    const current = (): boolean => {
      try {
        return !this.disposed && sequence === this.sequence && !cancellation.token.isCancellationRequested && invocationCurrent()
          && vscode.workspace.isTrusted && !vscode.env.remoteName && isAntigravitySourceScopeCurrent(scope, getConfig(), this.history.getIndex());
      } catch { return false; }
    };
    const check = (): void => {
      if (!current()) throw new vscode.CancellationError();
      if (Date.now() >= deadline) throw new Error("Antigravity resume timed out.");
    };
    const phase = async <T>(effect: () => T | PromiseLike<T>): Promise<T> => {
      check();
      const result = Promise.resolve().then(() => { check(); return effect(); });
      let timeout: ReturnType<typeof setTimeout> | undefined, subscription: vscode.Disposable | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Antigravity resume timed out.")), Math.max(1, Math.min(PHASE_TIMEOUT_MS, deadline - Date.now())));
          subscription = cancellation.token.onCancellationRequested(() => reject(new vscode.CancellationError()));
          // Both completion paths stay observed after timeout or cancellation.
          result.then(resolve, reject);
        });
      } finally { clearTimeout(timeout); subscription?.dispose(); }
    };
    const promise = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        check();
        const metadata = await phase(() => antigravityReader.readMetadata(session.fsPath, cancellation.token));
        check();
        if (metadata.conversationId !== session.meta.id) throw new Error("Antigravity conversation changed.");
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        if (!extension) { void vscode.window.showErrorMessage(t("app.resumeSessionInAntigravityMissingExtension")); return false; }
        await phase(() => extension.activate());
        check();
        const commands = await phase(() => vscode.commands.getCommands(true));
        check();
        if (!commands.includes(OPEN_CONVERSATION_COMMAND)) throw new Error("Antigravity resume command is unavailable.");
        const verified = await phase(() => antigravityReader.readMetadata(session.fsPath, cancellation.token));
        check();
        if (verified.conversationId !== session.meta.id) throw new Error("Antigravity conversation changed.");
        await phase(() => vscode.commands.executeCommand(OPEN_CONVERSATION_COMMAND, session.meta.id));
        check();
        // Command completion is not proof of target existence or completed screen navigation.
        return true;
      } catch (error) {
        if (!(error instanceof vscode.CancellationError) && current()) {
          void vscode.window.showErrorMessage(t("app.resumeSessionInAntigravityFailed"));
        }
        return false;
      } finally {
        cancellation.cancel(); cancellation.dispose();
        if (this.active?.cancel === cancellation) this.active = undefined;
      }
    });
    this.active = { key, owner: invocation?.owner, current, promise, cancel: cancellation };
    return promise;
  }

  public dispose(): void {
    this.disposed = true; this.sequence++; this.active?.cancel.cancel(); this.active = undefined;
  }
}
