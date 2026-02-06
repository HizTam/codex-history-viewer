import * as vscode from "vscode";
import { resolveUiLanguage, t } from "./i18n";
import { getConfig } from "./settings";
import { HistoryService } from "./services/historyService";
import type { SessionSummary } from "./sessions/sessionTypes";
import { PinnedTreeDataProvider } from "./tree/pinnedTree";
import { HistoryTreeDataProvider } from "./tree/historyTree";
import { SearchTreeDataProvider } from "./tree/searchTree";
import { TranscriptContentProvider } from "./transcript/transcriptProvider";
import { renderResumeContext } from "./transcript/resumeRenderer";
import { promoteSessionCopyToToday } from "./services/promoteService";
import { deleteSessionsWithConfirmation } from "./services/deleteService";
import { PinStore } from "./services/pinStore";
import { runSearchFlow } from "./services/searchService";
import type { TreeNode } from "./tree/treeNodes";
import { MissingPinnedNode, SearchHitNode, isSessionNode } from "./tree/treeNodes";
import { ChatPanelManager } from "./chat/chatPanelManager";
import { getDateScopeValue, sanitizeDateScope, type DateScope } from "./types/dateScope";
import { resolveDateTimeSettings } from "./utils/dateTimeSettings";
import { safeDisplayPath } from "./utils/textUtils";
import { normalizeCacheKey } from "./utils/fsUtils";

// Extension entry point. Initializes core services and tree views.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const HISTORY_FILTER_KEY = "codexHistoryViewer.historyFilter.v1";
  const HISTORY_PROJECT_FILTER_KEY = "codexHistoryViewer.historyProjectFilter.v1";

  const updateUiLanguageContext = (): void => {
    // Keep the UI language context up to date for menu visibility switching.
    // The value is fixed to "ja"/"en" because package.json `when` clauses depend on it.
    const lang = resolveUiLanguage();
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.uiLang", lang);
  };
  updateUiLanguageContext();

  // Ensure the global storage directory exists (cache / temp files).
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const pinStore = new PinStore(context.globalState);
  const historyService = new HistoryService(context.globalStorageUri, config);
  const transcriptProvider = new TranscriptContentProvider(historyService);
  const chatPanels = new ChatPanelManager(context.extensionUri, historyService);

  const pinnedProvider = new PinnedTreeDataProvider(historyService, pinStore, context.extensionUri);
  let historyFilter: DateScope = sanitizeDateScope(context.workspaceState.get(HISTORY_FILTER_KEY));
  let historyProjectCwd: string | null = sanitizeProjectCwd(context.workspaceState.get(HISTORY_PROJECT_FILTER_KEY));
  const historyProvider = new HistoryTreeDataProvider(
    historyService,
    pinStore,
    historyFilter,
    historyProjectCwd,
    context.extensionUri,
  );
  const searchProvider = new SearchTreeDataProvider(pinStore, context.extensionUri);
  const debugBuild = "2026-01-19.1";

  // Provide a virtual document (conversation log).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(transcriptProvider.scheme, transcriptProvider),
  );

  const URI_LIST_MIME = "text/uri-list";
  const OPEN_MULTI_LIMIT = 10;
  const MAX_DND_ITEMS = 500;
  const RESUME_MAX_MESSAGES = 20;
  const RESUME_MAX_CHARS = 25_000;

  const dedupeFsPaths = (fsPaths: readonly string[]): string[] => {
    // Deduplicate paths (normalize Windows case differences).
    const byKey = new Map<string, string>();
    for (const p of fsPaths) {
      const fsPath = typeof p === "string" ? p.trim() : "";
      if (!fsPath) continue;
      const key = normalizeCacheKey(fsPath);
      if (!byKey.has(key)) byKey.set(key, fsPath);
    }
    return Array.from(byKey.values());
  };

  const collectSessionFsPaths = (targets: readonly unknown[]): string[] => {
    const fsPaths: string[] = [];
    for (const t of targets) {
      if (isSessionNode(t)) fsPaths.push(t.session.fsPath);
    }
    return dedupeFsPaths(fsPaths);
  };

  const collectUnpinFsPaths = (targets: readonly unknown[]): string[] => {
    const fsPaths: string[] = [];
    for (const t of targets) {
      if (isSessionNode(t)) fsPaths.push(t.session.fsPath);
      else if (t instanceof MissingPinnedNode) fsPaths.push(t.fsPath);
    }
    return dedupeFsPaths(fsPaths);
  };

  const buildUriList = (fsPaths: readonly string[]): string => {
    // CRLF is recommended as the separator for text/uri-list.
    return fsPaths.map((p) => vscode.Uri.file(p).toString()).join("\r\n");
  };

  const parseUriListToFsPaths = async (dataTransfer: vscode.DataTransfer): Promise<string[]> => {
    const item = dataTransfer.get(URI_LIST_MIME);
    if (!item) return [];

    let raw = "";
    try {
      raw = await item.asString();
    } catch {
      return [];
    }

    const lines = String(raw ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    const fsPaths: string[] = [];
    for (const line of lines.slice(0, MAX_DND_ITEMS)) {
      try {
        const uri = vscode.Uri.parse(line);
        if (uri.scheme !== "file") continue;
        if (!uri.fsPath) continue;
        fsPaths.push(uri.fsPath);
      } catch {
        // Ignore lines we cannot parse.
      }
    }
    return dedupeFsPaths(fsPaths);
  };

  const historyDragController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [URI_LIST_MIME],
    dropMimeTypes: [],
    handleDrag: (source, dataTransfer) => {
      // Assume source contains all selected items when dragging with multi-selection.
      const fsPaths = collectSessionFsPaths(source);
      if (fsPaths.length === 0) return;
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(buildUriList(fsPaths)));
    },
  };

  const searchDragController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [URI_LIST_MIME],
    dropMimeTypes: [],
    handleDrag: (source, dataTransfer) => {
      const fsPaths = collectSessionFsPaths(source);
      if (fsPaths.length === 0) return;
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(buildUriList(fsPaths)));
    },
  };

  const pinnedDropController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [],
    dropMimeTypes: [URI_LIST_MIME],
    handleDrop: async (_target, dataTransfer) => {
      const fsPaths = await parseUriListToFsPaths(dataTransfer);
      if (fsPaths.length === 0) return;

      // Only allow pinning sessions present in the history index (prevents mixing in external drag-and-drop items).
      const candidates = fsPaths
        .map((p) => historyService.findByFsPath(p)?.fsPath)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      const unique = dedupeFsPaths(candidates);
      if (unique.length === 0) return;

      const { pinned, skipped } = await pinStore.pinMany(unique);
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.refresh();

      if (pinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.pinDone"));
      } else if (pinned > 0) {
        void vscode.window.showInformationMessage(t("app.pinDoneMulti", pinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.pinDoneNoop"));
      }
    },
  };

  // Create tree views (enable canSelectMany for multi-delete).
  const pinnedView = vscode.window.createTreeView("codexHistoryViewer.pinnedView", {
    treeDataProvider: pinnedProvider,
    canSelectMany: true,
    dragAndDropController: pinnedDropController,
  });
  const historyView = vscode.window.createTreeView("codexHistoryViewer.historyView", {
    treeDataProvider: historyProvider,
    canSelectMany: true,
    dragAndDropController: historyDragController,
  });
  const searchView = vscode.window.createTreeView("codexHistoryViewer.searchView", {
    treeDataProvider: searchProvider,
    canSelectMany: true,
    dragAndDropController: searchDragController,
  });

  context.subscriptions.push(pinnedView, historyView, searchView);

  const ensureAlwaysShowHeaderActions = async (): Promise<void> => {
    // Enable VS Code setting to always show header actions (top-right view icons).
    // Allow disabling via extension settings, and keep the extension running even if updating the setting fails.
    const extCfg = vscode.workspace.getConfiguration("codexHistoryViewer");
    const enabled = extCfg.get<boolean>("ui.alwaysShowHeaderActions") ?? true;
    if (!enabled) return;

    const wbCfg = vscode.workspace.getConfiguration();
    const current = wbCfg.get<boolean>("workbench.view.alwaysShowHeaderActions") ?? false;
    if (current) return;

    try {
      await wbCfg.update("workbench.view.alwaysShowHeaderActions", true, vscode.ConfigurationTarget.Global);
    } catch {
      // Ignore failures when updating settings (permissions/environment differences).
    }
  };

  const updateViewTitles = (): void => {
    pinnedView.title = t("view.pinned");
    historyView.title = t("view.history");
    searchView.title = t("view.search");
  };

  const updateHistoryViewDescription = (): void => {
    const parts: string[] = [];
    const dateValue = getDateScopeValue(historyFilter);
    if (dateValue) parts.push(dateValue);
    if (historyProjectCwd) parts.push(t("history.filter.projectLabel", safeDisplayPath(historyProjectCwd, 60)));

    const v = parts.join(" / ");
    historyView.description = v ? t("history.filter.active", v) : "";
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyFiltered", v.length > 0);
  };

  const applyHistoryFilters = async (
    next: { date: DateScope; projectCwd: string | null },
    opts: { persist: boolean },
  ): Promise<void> => {
    historyFilter = next.date;
    historyProjectCwd = next.projectCwd;
    historyProvider.setFilters(next.date, next.projectCwd);
    historyProvider.refresh();
    updateHistoryViewDescription();
    if (opts.persist) {
      await context.workspaceState.update(HISTORY_FILTER_KEY, next.date);
      await context.workspaceState.update(HISTORY_PROJECT_FILTER_KEY, next.projectCwd ?? "");
    }
  };

  updateViewTitles();
  updateHistoryViewDescription();
  await ensureAlwaysShowHeaderActions();

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.debugInfo", async () => {
      const uiLang = vscode.workspace.getConfiguration("codexHistoryViewer").get<string>("ui.language") ?? "auto";
      const resolvedUiLang = resolveUiLanguage(uiLang === "ja" || uiLang === "en" || uiLang === "auto" ? uiLang : "auto");
      const lines: string[] = [
        `Extension: ${context.extension.id} v${context.extension.packageJSON.version}`,
        `Build: ${debugBuild}`,
        `VS Code env.language: ${vscode.env.language}`,
        `codexHistoryViewer.ui.language: ${uiLang}`,
        `Resolved UI language: ${resolvedUiLang}`,
        `t(view.history): ${t("view.history")}`,
        `t(chat.button.detailsOff): ${t("chat.button.detailsOff")}`,
        `t(chat.button.toolsOff): ${t("chat.button.toolsOff")}`,
        `History filter: ${formatDateScopeForDebug(historyFilter)}`,
      ];
      const text = lines.join("\n");
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("Codex History Viewer: debug info copied to clipboard.");
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const uiLanguageChanged = e.affectsConfiguration("codexHistoryViewer.ui.language");
      const headerActionsChanged = e.affectsConfiguration("codexHistoryViewer.ui.alwaysShowHeaderActions");
      if (
        !uiLanguageChanged &&
        !headerActionsChanged
      ) {
        return;
      }
      if (uiLanguageChanged) updateUiLanguageContext();
      updateViewTitles();
      updateHistoryViewDescription();
      chatPanels.refreshI18n();
      void ensureAlwaysShowHeaderActions();

      // When UI language changes, rebuild history-dependent displays because date/time formatting can also change.
      if (!uiLanguageChanged) {
        pinnedProvider.refresh();
        historyProvider.refresh();
        searchProvider.refresh();
        return;
      }

      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") }, async () => {
        historyService.updateConfig(getConfig());
        await historyService.refresh({ forceRebuildCache: false });
        pinnedProvider.refresh();
        historyProvider.refresh();
        searchProvider.clear();
        chatPanels.refreshTitles();
      });
    }),
  );

  // Open a session preview on selection (if enabled).
  const tryOpenPreview = async (element: unknown): Promise<void> => {
    const latestConfig = getConfig();
    if (!latestConfig.previewOpenOnSelection) return;
    if (!isSessionNode(element)) return;
    const reveal = element instanceof SearchHitNode ? element.hit.messageIndex : undefined;
    await chatPanels.openSession(element.session, { preview: true, revealMessageIndex: reveal });
  };

  // Track the last interacted view, since multiple views can be visible at the same time.
  let lastSelectionSource: "pinned" | "history" | "search" | null = null;
  context.subscriptions.push(
    pinnedView.onDidChangeSelection((e) => {
      lastSelectionSource = "pinned";
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    historyView.onDidChangeSelection((e) => {
      lastSelectionSource = "history";
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    searchView.onDidChangeSelection((e) => {
      lastSelectionSource = "search";
      void tryOpenPreview(e.selection[0]);
    }),
  );

  const resolveActiveSelection = (): readonly unknown[] => {
    // Prefer selection from the last interacted view to avoid bulk actions on the wrong view.
    if (lastSelectionSource === "pinned" && pinnedView.selection.length > 0) return pinnedView.selection;
    if (lastSelectionSource === "history" && historyView.selection.length > 0) return historyView.selection;
    if (lastSelectionSource === "search" && searchView.selection.length > 0) return searchView.selection;

    // Fallback when last interaction cannot be determined.
    if (pinnedView.selection.length > 0) return pinnedView.selection;
    if (historyView.selection.length > 0) return historyView.selection;
    if (searchView.selection.length > 0) return searchView.selection;
    return [];
  };

  const resolveSelectionForElement = (element: unknown): readonly unknown[] | null => {
    // To avoid accidental actions from context menus/inline actions, prefer selection from the view the element belongs to.
    if (pinnedView.selection.includes(element as never)) return pinnedView.selection;
    if (historyView.selection.includes(element as never)) return historyView.selection;
    if (searchView.selection.includes(element as never)) return searchView.selection;
    return null;
  };

  const resolveTargets = (element?: unknown): readonly unknown[] => {
    // When invoked from a context menu, element is provided.
    // If there is multi-selection, apply the same operation to the whole selection.
    const selection = element === undefined ? resolveActiveSelection() : resolveSelectionForElement(element) ?? resolveActiveSelection();
    if (element === undefined) return selection;
    return selection.length > 1 ? selection : [element];
  };

  const collectOpenTargets = (targets: readonly unknown[]): Array<{ session: SessionSummary; revealMessageIndex?: number }> => {
    // Deduplicate "Open" targets by session, and for SearchHit use the first hit location.
    const byKey = new Map<string, { session: SessionSummary; revealMessageIndex?: number }>();
    for (const t of targets) {
      if (!isSessionNode(t)) continue;
      const s = t.session;
      const key = normalizeCacheKey(s.fsPath);
      if (byKey.has(key)) continue;
      byKey.set(key, { session: s, revealMessageIndex: resolveRevealIndex(t) });
    }
    return Array.from(byKey.values());
  };

  // Register commands (palette + context menus).
  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refresh", async () => {
      historyService.updateConfig(getConfig());
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => {
          await historyService.refresh({ forceRebuildCache: false });
        },
      );
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildCache", async () => {
      historyService.updateConfig(getConfig());
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("app.rebuildingCache") },
        async () => {
          await historyService.refresh({ forceRebuildCache: true });
        },
      );
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSession", async (element?: unknown) => {
      // When multiple items are selected, open the selected sessions in bulk (with a limit).
      const targets = resolveTargets(element);
      const openTargets = collectOpenTargets(targets);
      if (openTargets.length > 1) {
        const total = openTargets.length;
        const limited = openTargets.slice(0, OPEN_MULTI_LIMIT);
        const msg =
          total > OPEN_MULTI_LIMIT
            ? t("app.openMultiConfirmLimit", total, OPEN_MULTI_LIMIT)
            : t("app.openMultiConfirm", total);
        const choice = await vscode.window.showWarningMessage(msg, { modal: true }, "OK");
        if (choice !== "OK") return;

        for (const it of limited) {
          await chatPanels.openSession(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        }
        return;
      }

      // For a single item, keep the legacy behavior (from element or active Markdown).
      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        await chatPanels.openSession(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        return;
      }

      const session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, element);
      if (!session) return;
      const reveal = resolveRevealIndex(element);
      await chatPanels.openSession(session, { preview: false, revealMessageIndex: reveal });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSessionMarkdown", async (elementOrArgs?: unknown) => {
      // Switching from the chat webview passes args (fsPath), so do not prefer bulk-selection handling.
      const hasDirectFsPath =
        !!elementOrArgs &&
        typeof elementOrArgs === "object" &&
        !isSessionNode(elementOrArgs) &&
        typeof (elementOrArgs as any).fsPath === "string";
      if (hasDirectFsPath) {
        const session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
        if (!session) return;
        const reveal = resolveRevealIndexFromArgs(elementOrArgs);
        await transcriptProvider.openSessionTranscript(session, { preview: false, revealMessageIndex: reveal });
        return;
      }

      // When multiple items are selected, open the selected sessions in bulk (with a limit).
      const targets = resolveTargets(elementOrArgs);
      const openTargets = collectOpenTargets(targets);
      if (openTargets.length > 1) {
        const total = openTargets.length;
        const limited = openTargets.slice(0, OPEN_MULTI_LIMIT);
        const msg =
          total > OPEN_MULTI_LIMIT
            ? t("app.openMultiConfirmLimit", total, OPEN_MULTI_LIMIT)
            : t("app.openMultiConfirm", total);
        const choice = await vscode.window.showWarningMessage(msg, { modal: true }, "OK");
        if (choice !== "OK") return;

        for (const it of limited) {
          await transcriptProvider.openSessionTranscript(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        }
        return;
      }

      // Open as a Markdown document.
      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        await transcriptProvider.openSessionTranscript(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        return;
      }

      const session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
      if (!session) return;
      const reveal = resolveRevealIndex(elementOrArgs);
      await transcriptProvider.openSessionTranscript(session, { preview: false, revealMessageIndex: reveal });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.copyResumePrompt", async (elementOrArgs?: unknown) => {
      // Resolve exactly one target session from tree selection or webview args, then copy its prompt excerpt.
      const hasDirectFsPath =
        !!elementOrArgs &&
        typeof elementOrArgs === "object" &&
        !isSessionNode(elementOrArgs) &&
        typeof (elementOrArgs as any).fsPath === "string";

      let session: SessionSummary | undefined;
      if (hasDirectFsPath) {
        session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
      } else {
        const targets = resolveTargets(elementOrArgs);
        const openTargets = collectOpenTargets(targets);
        if (openTargets.length > 0) session = openTargets[0]!.session;
      }
      if (!session) {
        session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
      }
      if (!session) return false;

      try {
        const { timeZone } = resolveDateTimeSettings();
        const excerpt = await renderResumeContext(session.fsPath, {
          timeZone,
          maxMessages: RESUME_MAX_MESSAGES,
          maxChars: RESUME_MAX_CHARS,
          includeContext: false,
        });
        await vscode.env.clipboard.writeText(excerpt);
        void vscode.window.showInformationMessage(t("app.copyResumePromptDone"));
        return true;
      } catch {
        void vscode.window.showErrorMessage(t("app.copyResumePromptFailed"));
        return false;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSettings", async () => {
      // Open the VS Code Settings UI filtered to this extension.
      const extId = context.extension.id;
      await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extId}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.search", async () => {
      const latestConfig = getConfig();
      historyService.updateConfig(latestConfig);
      const index = historyService.getIndex();
      const results = await runSearchFlow(index, latestConfig, historyFilter, historyProjectCwd);
      if (!results) return;
      searchProvider.setResults(results);
      await searchView.reveal(results.root, { focus: true, expand: true, select: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistory", async () => {
      const idx = historyService.getIndex();
      const change = await promptHistoryFilter(idx, { date: historyFilter, projectCwd: historyProjectCwd });
      if (!change) return;
      const next = {
        date: change.kind === "date" ? change.date : historyFilter,
        projectCwd: change.kind === "project" ? change.projectCwd : historyProjectCwd,
      };
      await applyHistoryFilters(next, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryFilter", async () => {
      await applyHistoryFilters({ date: { kind: "all" }, projectCwd: null }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.promoteSession", async (element?: unknown) => {
      // When multiple items are selected, bulk "promote" (copy) the selected sessions to today.
      const targets = resolveTargets(element);
      const byKey = new Map<string, SessionSummary>();
      for (const t of targets) {
        if (!isSessionNode(t)) continue;
        const s = t.session;
        const key = normalizeCacheKey(s.fsPath);
        if (!byKey.has(key)) byKey.set(key, s);
      }
      const sessions = Array.from(byKey.values());
      if (sessions.length === 0) return;

      if (sessions.length === 1) {
        const choice = await vscode.window.showWarningMessage(t("app.promoteConfirm"), { modal: true }, "OK");
        if (choice !== "OK") return;

        const promoted = await promoteSessionCopyToToday(sessions[0]!, historyService, getConfig());
        await vscode.window.showInformationMessage(t("app.promoteDone"));

        // Refresh views and open the newly created session.
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
          async () => historyService.refresh({ forceRebuildCache: false }),
        );
        pinnedProvider.refresh();
        historyProvider.refresh();
        searchProvider.clear();
        await transcriptProvider.openSessionTranscript(promoted, { preview: false });
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        t("app.promoteConfirmMulti", sessions.length),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      const latestConfig = getConfig();
      let succeeded = 0;
      let failed = 0;
      for (const s of sessions) {
        try {
          await promoteSessionCopyToToday(s, historyService, latestConfig);
          succeeded += 1;
        } catch {
          // Continue even if one item fails.
          failed += 1;
        }
      }
      void vscode.window.showInformationMessage(t("app.promoteDoneMulti", succeeded, failed));

      // Refresh views in bulk (viewer restores position after multiple copies).
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => historyService.refresh({ forceRebuildCache: false }),
      );
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.pinSession", async (element?: unknown) => {
      // When multiple items are selected, pin the whole selection in one operation.
      const targets = resolveTargets(element);
      const fsPaths = collectSessionFsPaths(targets);
      if (fsPaths.length === 0) return;
      const { pinned, skipped } = await pinStore.pinMany(fsPaths);
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.refresh();
      if (pinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.pinDone"));
      } else if (pinned > 0) {
        void vscode.window.showInformationMessage(t("app.pinDoneMulti", pinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.pinDoneNoop"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.unpinSession", async (element?: unknown) => {
      // When multiple items are selected, unpin the whole selection in one operation (including missing pins).
      const targets = resolveTargets(element);
      const fsPaths = collectUnpinFsPaths(targets);
      if (fsPaths.length === 0) return;
      const { unpinned, skipped } = await pinStore.unpinMany(fsPaths);
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.refresh();
      if (unpinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.unpinDone"));
      } else if (unpinned > 0) {
        void vscode.window.showInformationMessage(t("app.unpinDoneMulti", unpinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.unpinDoneNoop"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.deleteSessions", async (element?: unknown) => {
      // When an element is provided, prefer selection from the view it belongs to (avoid bulk-deleting from the wrong view).
      const viewSelection =
        element === undefined
          ? resolveActiveSelection()
          : resolveSelectionForElement(element) ?? resolveActiveSelection();
      const selection =
        element === undefined
          ? viewSelection.length >= 1
            ? viewSelection
            : undefined
          : viewSelection.length > 1
            ? viewSelection
            : undefined;
      await deleteSessionsWithConfirmation({
        element,
        selection,
        historyIndex: historyService.getIndex(),
        config: getConfig(),
        pinStore,
        globalStorageUri: context.globalStorageUri,
      });
      await historyService.refresh({ forceRebuildCache: false });
      pinnedProvider.refresh();
      historyProvider.refresh();
      searchProvider.clear();
    }),
  );

  // Register UI command aliases so menu labels can switch by extension language setting.
  // This keeps context menu text independent from VS Code display language.
  const registerUiCommandAlias = (aliasId: string, targetId: string): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(aliasId, async (...args: unknown[]) => {
        await vscode.commands.executeCommand(targetId, ...(args as any[]));
      }),
    );
  };

  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSession", "codexHistoryViewer.openSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSession", "codexHistoryViewer.openSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSessionMarkdown", "codexHistoryViewer.openSessionMarkdown");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSessionMarkdown", "codexHistoryViewer.openSessionMarkdown");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.copyResumePrompt", "codexHistoryViewer.copyResumePrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.en.copyResumePrompt", "codexHistoryViewer.copyResumePrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.promoteSession", "codexHistoryViewer.promoteSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.promoteSession", "codexHistoryViewer.promoteSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinSession", "codexHistoryViewer.pinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinSession", "codexHistoryViewer.pinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.unpinSession", "codexHistoryViewer.unpinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.unpinSession", "codexHistoryViewer.unpinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.deleteSessions", "codexHistoryViewer.deleteSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.en.deleteSessions", "codexHistoryViewer.deleteSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refresh", "codexHistoryViewer.refresh");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refresh", "codexHistoryViewer.refresh");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.en.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterHistory", "codexHistoryViewer.filterHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterHistory", "codexHistoryViewer.filterHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearHistoryFilter", "codexHistoryViewer.clearHistoryFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearHistoryFilter", "codexHistoryViewer.clearHistoryFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSettings", "codexHistoryViewer.openSettings");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSettings", "codexHistoryViewer.openSettings");

  // Initial load on activation.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
    async () => {
      historyService.updateConfig(getConfig());
      await historyService.refresh({ forceRebuildCache: false });
    },
  );
  pinnedProvider.refresh();
  historyProvider.refresh();
}

function formatDateScopeForDebug(scope: DateScope): string {
  const v = getDateScopeValue(scope);
  return v ? `${scope.kind}:${v}` : "all";
}

function sanitizeProjectCwd(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

type HistoryFilterChange = { kind: "date"; date: DateScope } | { kind: "project"; projectCwd: string | null };

type HistoryFilterPick = vscode.QuickPickItem & {
  pickKind?: "date" | "project";
  date?: DateScope;
  projectCwd?: string | null;
};

async function promptHistoryFilter(
  idx: import("./sessions/sessionTypes").HistoryIndex,
  current: { date: DateScope; projectCwd: string | null },
): Promise<HistoryFilterChange | null> {
  const years = Array.from(idx.byY.keys()).sort((a, b) => (a < b ? 1 : -1));
  const yms: string[] = [];
  const ymds: string[] = Array.from(idx.byYmd.keys()).sort((a, b) => (a < b ? 1 : -1));
  for (const y of years) {
    const months = idx.byY.get(y);
    if (!months) continue;
    for (const m of Array.from(months.keys()).sort((a, b) => (a < b ? 1 : -1))) {
      yms.push(`${y}-${m}`);
    }
  }

  // List session CWDs (projects) in descending recency (cap the list size since it can grow large).
  const MAX_PROJECTS = 250;
  const projectCwds: string[] = [];
  const seenProjects = new Set<string>();
  for (const s of idx.sessions) {
    const cwd = typeof s.meta?.cwd === "string" ? s.meta.cwd.trim() : "";
    if (!cwd) continue;
    const key = normalizeCacheKey(cwd);
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    projectCwds.push(cwd);
    if (projectCwds.length >= MAX_PROJECTS) break;
  }

  const dateItemsBase: HistoryFilterPick[] = [
    { label: t("history.filter.section.date"), kind: vscode.QuickPickItemKind.Separator },
    { label: t("history.filter.all"), pickKind: "date", date: { kind: "all" } },
    ...years.map((y) => ({ label: y, pickKind: "date" as const, date: { kind: "year" as const, yyyy: y } })),
    ...yms.map((ym) => ({ label: ym, pickKind: "date" as const, date: { kind: "month" as const, ym } })),
  ];

  const projectItemsBase: HistoryFilterPick[] = [
    { label: t("history.filter.section.project"), kind: vscode.QuickPickItemKind.Separator },
    { label: t("history.project.clear"), pickKind: "project" as const, projectCwd: null },
    ...projectCwds.map((cwd) => ({
      label: safeDisplayPath(cwd, 80),
      description: t("history.filter.project"),
      detail: cwd,
      pickKind: "project" as const,
      projectCwd: cwd,
    })),
  ];

  const baseItems: HistoryFilterPick[] = [...dateItemsBase, ...projectItemsBase];

  const isSameDateScope = (a: DateScope, b: DateScope): boolean => a.kind === b.kind && getDateScopeValue(a) === getDateScopeValue(b);

  return await new Promise<HistoryFilterChange | null>((resolve) => {
    const qp = vscode.window.createQuickPick<HistoryFilterPick>();
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = t("history.filter.placeholder");
    qp.items = baseItems;

    // Default to year-month options; only while typing add year-month-day (YYYY-MM-DD) suggestions.
    const updateItems = (raw: string): void => {
      const v = String(raw ?? "").trim();
      if (!v || v.length < 7 || !v.includes("-")) {
        qp.items = baseItems;
        return;
      }

      const MAX_DAYS = 250;
      const dayKeys = ymds.filter((ymd) => ymd.startsWith(v)).slice(0, MAX_DAYS);
      if (dayKeys.length === 0) {
        qp.items = baseItems;
        return;
      }

      const dayItems: HistoryFilterPick[] = dayKeys.map((ymd) => ({
        label: ymd,
        pickKind: "date" as const,
        date: { kind: "day" as const, ymd },
      }));

      qp.items = [...dateItemsBase, ...dayItems, ...projectItemsBase];
    };

    let done = false;
    const finish = (v: HistoryFilterChange | null): void => {
      if (done) return;
      done = true;
      resolve(v);
      qp.dispose();
    };

    qp.onDidChangeValue(updateItems);
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      const pickKind = typeof picked?.pickKind === "string" ? picked.pickKind : "";
      if (pickKind === "date" && picked?.date) {
        finish({ kind: "date", date: picked.date });
        return;
      }
      if (pickKind === "project") {
        finish({ kind: "project", projectCwd: picked?.projectCwd ?? null });
        return;
      }
      finish(null);
    });
    qp.onDidHide(() => finish(null));

    // Set initial focus based on the current filters.
    const currentProjectKey = current.projectCwd ? normalizeCacheKey(current.projectCwd) : null;
    const activeDateItem = dateItemsBase.find((it) => it.pickKind === "date" && it.date && isSameDateScope(it.date, current.date));
    const activeProjectItem = currentProjectKey
      ? projectItemsBase.find(
          (it) => it.pickKind === "project" && it.projectCwd && normalizeCacheKey(it.projectCwd) === currentProjectKey,
        )
      : undefined;
    qp.activeItems = activeDateItem ? [activeDateItem] : activeProjectItem ? [activeProjectItem] : [];
    qp.show();
  });
}

// Cleanup hook called by VS Code.
export function deactivate(): void {
  // Disposables are already registered in context.subscriptions.
}

function resolveRevealIndex(element: unknown): number | undefined {
  return element instanceof SearchHitNode ? element.hit.messageIndex : undefined;
}

function resolveRevealIndexFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as any).revealMessageIndex;
  return typeof v === "number" ? v : undefined;
}

function resolveSessionFromElementOrFsPath(historyService: HistoryService, elementOrArgs: unknown): SessionSummary | undefined {
  if (isSessionNode(elementOrArgs)) return elementOrArgs.session;
  if (!elementOrArgs || typeof elementOrArgs !== "object") return undefined;
  const fsPath = (elementOrArgs as any).fsPath;
  if (typeof fsPath !== "string" || fsPath.length === 0) return undefined;
  return historyService.findByFsPath(fsPath);
}

function resolveSessionFromElementOrActive(
  historyService: HistoryService,
  transcriptScheme: string,
  element?: unknown,
): SessionSummary | undefined {
  if (isSessionNode(element)) return element.session;

  // Allow "switch to chat view" from an opened Markdown transcript.
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return undefined;
  if (doc.uri.scheme !== transcriptScheme) return undefined;
  const params = new URLSearchParams(doc.uri.query);
  const fsPath = params.get("fsPath");
  if (!fsPath) return undefined;
  return historyService.findByFsPath(fsPath);
}
