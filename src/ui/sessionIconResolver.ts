import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
import { sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import type { CodexAgentRelationKind } from "../agents/codexAgentRunsTypes";

export type SessionIconVariant = "default" | "dedicated";

export class SessionIconResolver {
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly codexSubagentIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly codexDedicatedIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly codexSubagentDedicatedIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeDedicatedIconPath: { light: vscode.Uri; dark: vscode.Uri };

  constructor(extensionUri: vscode.Uri) {
    this.codexIconPath = buildIconPath(extensionUri, "source-codex.svg");
    this.codexSubagentIconPath = buildIconPath(extensionUri, "source-codex-subagent.svg");
    this.claudeIconPath = buildIconPath(extensionUri, "source-claude.svg");
    this.codexDedicatedIconPath = buildIconPath(extensionUri, "source-codex-dedicated.svg");
    this.codexSubagentDedicatedIconPath = buildIconPath(
      extensionUri,
      "source-codex-subagent-dedicated.svg",
    );
    this.claudeDedicatedIconPath = buildIconPath(extensionUri, "source-claude-dedicated.svg");
  }

  public resolve(
    session: Pick<SessionSummary, "source" | "meta">,
    agentRunsEnabled: boolean,
    agentRelation?: CodexAgentRelationKind,
    variant: SessionIconVariant = "default",
  ): { light: vscode.Uri; dark: vscode.Uri } {
    const dedicated = variant === "dedicated";
    if (session.source === "claude") {
      return dedicated ? this.claudeDedicatedIconPath : this.claudeIconPath;
    }
    if (!agentRunsEnabled) {
      return dedicated ? this.codexDedicatedIconPath : this.codexIconPath;
    }
    const isSubagent = agentRelation === undefined
      ? Boolean(sanitizeCachedCodexAgentMetadata(session.meta.codexAgent).value)
      : agentRelation === "child" || agentRelation === "both";
    if (isSubagent) {
      return dedicated ? this.codexSubagentDedicatedIconPath : this.codexSubagentIconPath;
    }
    return dedicated ? this.codexDedicatedIconPath : this.codexIconPath;
  }
}

function buildIconPath(
  extensionUri: vscode.Uri,
  fileName: string,
): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", fileName),
    dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", fileName),
  };
}
