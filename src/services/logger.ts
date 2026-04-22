import * as vscode from "vscode";
import { formatYmdHmsInTimeZone } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";

const OUTPUT_CHANNEL_NAME = "Codex History Viewer";
const DEBUG_LOGGING_CONFIG_KEY = "debug.logging.enabled";

export interface DebugLogger extends vscode.Disposable {
  isDebugEnabled(): boolean;
  debug(message: string): void;
}

export class OutputChannelLogger implements DebugLogger {
  private outputChannel: vscode.OutputChannel | null = null;

  public isDebugEnabled(): boolean {
    const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
    return cfg.get<boolean>(DEBUG_LOGGING_CONFIG_KEY) ?? false;
  }

  public debug(message: string): void {
    if (!this.isDebugEnabled()) return;
    this.getOutputChannel().appendLine(`[${formatLogTimestamp(new Date())}] ${message}`);
  }

  public dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = null;
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this.outputChannel;
  }
}

function formatLogTimestamp(date: Date): string {
  const { timeZone } = resolveDateTimeSettings();
  const base = formatYmdHmsInTimeZone(date, timeZone).replace("T", " ");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${base}.${ms}`;
}
