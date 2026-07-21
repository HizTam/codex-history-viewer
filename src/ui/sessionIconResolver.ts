import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
import { sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import type { CodexAgentRelationKind } from "../agents/codexAgentRunsTypes";

export class SessionIconResolver {
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly codexSubagentIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };

  constructor(extensionUri: vscode.Uri) {
    this.codexIconPath = buildIconPath(extensionUri, "source-codex.svg");
    this.codexSubagentIconPath = buildIconPath(extensionUri, "source-codex-subagent.svg");
    this.claudeIconPath = buildIconPath(extensionUri, "source-claude.svg");
  }

  public resolve(
    session: Pick<SessionSummary, "source" | "meta">,
    agentRunsEnabled: boolean,
    agentRelation?: CodexAgentRelationKind,
  ): { light: vscode.Uri; dark: vscode.Uri } {
    if (session.source === "claude") return this.claudeIconPath;
    if (!agentRunsEnabled) return this.codexIconPath;
    const isSubagent = agentRelation === undefined
      ? Boolean(sanitizeCachedCodexAgentMetadata(session.meta.codexAgent).value)
      : agentRelation === "child" || agentRelation === "both";
    if (isSubagent) return this.codexSubagentIconPath;
    return this.codexIconPath;
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
