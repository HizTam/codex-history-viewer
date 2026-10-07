import * as vscode from "vscode";
import { getLocaleState, t } from "../i18n";
import { DEFAULT_LOCALE } from "./localeCatalog";
import { DEFAULT_RUNTIME_MESSAGES } from "../generated/defaultRuntimeMessages";
import { LOCALIZATION_FINGERPRINT } from "../generated/localeCatalog";
import { WEBVIEW_I18N_KEYS, type LocalizedPanelKind } from "../generated/webviewI18n";
import type { SessionSource } from "../sessions/sessionTypes";

interface LocalizationContext {
  historySource?: SessionSource;
}

export function buildWebviewI18n(panel: LocalizedPanelKind, context?: LocalizationContext): Record<string, string> {
  const messages = Object.fromEntries(Object.entries(WEBVIEW_I18N_KEYS[panel]).map(([property, key]) => [property, t(key)]));
  if (panel === "chat" && context?.historySource === "codex") {
    messages.branchSwitchFailed = t("codexForks.switchFailed");
    messages.branchNone = t("codexForks.none");
    messages.branchLoadFailed = t("codexForks.loadFailed");
  }
  return messages;
}

// Read locale state at the actual send boundary, after any asynchronous work.
export function postLocalizedMessage(webview: vscode.Webview, panel: LocalizedPanelKind, value: Record<string, unknown>, context?: LocalizationContext): Thenable<boolean> {
  // Control-only acknowledgements retain their existing wire shape.
  if (!Object.hasOwn(value, "i18n") && !(panel === "settings" && Object.hasOwn(value, "snapshot"))) return webview.postMessage(value);
  const state = getLocaleState();
  const changed = sentRevisions.get(webview) !== state.localeRevision;
  sentRevisions.set(webview, state.localeRevision);
  return webview.postMessage({ ...value, ...(value.model ? { model: projectLocalizedModel(panel, value.model) } : {}), ...state, ...(changed || Object.hasOwn(value, "i18n") ? { i18n: buildWebviewI18n(panel, context) } : {}) });
}

function projectLocalizedModel(panel: LocalizedPanelKind, value: unknown): unknown {
  // Reproject marked UI labels, never user-supplied names or analysis data.
  if (panel === "chat" && Array.isArray((value as { items?: unknown }).items)) {
    const model = value as import("../chat/chatTypes").ChatSessionModel;
    return { ...model, items: model.items.map(item => item.type === "note" && item.noticeKind === "historyIncomplete"
      ? { ...item, title: t("chat.historyIncomplete.title"), text: t("chat.historyIncomplete.message") }
      : item) };
  }
  if (panel === "insights") {
    const model = value as import("../insights/historyInsightsTypes").HistoryInsightsModel;
    const label = t("historyInsights.fileProjectUnknown");
    return { ...model,
      projects: { ...model.projects, rows: model.projects.rows.map(row => row.unknownProject ? { ...row, label } : row) },
      activeSessions: model.activeSessions.map(row => row.unknownProject ? { ...row, projectLabel: label } : row),
      files: model.files.map(file => ({ ...file, projectContexts: file.projectContexts.map(context => context.unknownProject ? { ...context, displayName: label } : context) })),
    };
  }
  if (panel === "fileHistory") {
    const model = value as import("../fileHistory/fileChangeHistoryTypes").FileChangeHistoryWebviewModel;
    return { ...model, cards: model.cards.map(card => ({ ...card,
      ...(card.unknownDate ? { localDate: t("fileChangeHistory.unknownDate"), dateTimeLabel: t("fileChangeHistory.unknownDate") } : {}),
      ...(card.sessionTitleFallback ? { sessionTitle: card.sessionTitleFallback.date ? t("fileChangeHistory.sessionTitleWithDate", card.sessionTitleFallback.source, card.sessionTitleFallback.date) : t("fileChangeHistory.untitledSession") } : {}),
    })) };
  }
  return value;
}

const sentRevisions = new WeakMap<vscode.Webview, number>();

const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const registrations = new WeakMap<vscode.Webview, vscode.Disposable>();

export function localizationBootstrap(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  registrations.get(webview)?.dispose();
  const registration = webview.onDidReceiveMessage((message: unknown) => {
    if (!message || typeof message !== "object" || (message as Record<string, unknown>).type !== "localizationLoadFailed" || registrations.get(webview) !== registration) return;
    registration.dispose();
    registrations.delete(webview);
    // The error page has no active content and needs neither the failed bundle nor browser translations.
    webview.html = `<!DOCTYPE html><html lang="${escape(DEFAULT_LOCALE)}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'"></head><body><p role="alert">${escape(DEFAULT_RUNTIME_MESSAGES["localization.webviewUnavailable"])}</p></body></html>`;
  });
  registrations.set(webview, registration);
  return ["generated/localization.js", "localizationBridge.js"].map(file => {
    const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...file.split("/")));
    return `<script nonce="${escape(nonce)}" data-localization-fingerprint="${LOCALIZATION_FINGERPRINT}" src="${escape(uri.toString())}"></script>`;
  }).join("\n");
}
