import type { BookmarkStore } from "./bookmarkStore";
import type { ChatOpenPositionStore } from "./chatOpenPositionStore";
import { formatDebugFields, safeDebugBasename, sanitizeDebugError } from "./debugLogUtils";
import type { DebugLogger } from "./logger";
import type { SessionAnnotationStore } from "./sessionAnnotationStore";
import type { HiddenSessionStore } from "./hiddenSessionStore";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";

export interface SessionRelocationResult {
  annotations: number;
  bookmarks: number;
  chatOpenPositions: number;
  hiddenSessions: number;
}

// Moves sidecar metadata when the physical session file changes location.
export class SessionReferenceRelocator {
  constructor(
    private readonly annotationStore: SessionAnnotationStore,
    private readonly bookmarkStore: BookmarkStore,
    private readonly chatOpenPositionStore: ChatOpenPositionStore,
    private readonly hiddenSessionStore?: HiddenSessionStore,
    private readonly logger?: DebugLogger,
    private readonly coordinator?: SessionMetadataMutationCoordinator,
  ) {}

  public async relocate(oldFsPath: string, newFsPath: string): Promise<SessionRelocationResult> {
    if (this.coordinator) {
      return this.coordinator.runExclusive(() => this.relocateUncoordinated(oldFsPath, newFsPath));
    }
    return this.relocateUncoordinated(oldFsPath, newFsPath);
  }

  private async relocateUncoordinated(oldFsPath: string, newFsPath: string): Promise<SessionRelocationResult> {
    const annotations = await this.relocateAnnotations(oldFsPath, newFsPath);
    const bookmarks = await this.relocateBookmarks(oldFsPath, newFsPath);
    const chatOpenPositions = await this.relocateChatOpenPositions(oldFsPath, newFsPath);
    const hiddenSessions = await this.relocateHiddenSession(oldFsPath, newFsPath);
    return { annotations, bookmarks, chatOpenPositions, hiddenSessions };
  }

  private async relocateAnnotations(oldFsPath: string, newFsPath: string): Promise<number> {
    try {
      return (await this.annotationStore.relocate(oldFsPath, newFsPath)) ? 1 : 0;
    } catch (error) {
      this.logRelocationFailure("annotations", oldFsPath, newFsPath, error);
      return 0;
    }
  }

  private async relocateBookmarks(oldFsPath: string, newFsPath: string): Promise<number> {
    try {
      return Math.max(0, await this.bookmarkStore.relocateSession(oldFsPath, newFsPath));
    } catch (error) {
      this.logRelocationFailure("bookmarks", oldFsPath, newFsPath, error);
      return 0;
    }
  }

  private async relocateChatOpenPositions(oldFsPath: string, newFsPath: string): Promise<number> {
    try {
      return (await this.chatOpenPositionStore.relocate(oldFsPath, newFsPath)) ? 1 : 0;
    } catch (error) {
      this.logRelocationFailure("chatOpenPositions", oldFsPath, newFsPath, error);
      return 0;
    }
  }

  private async relocateHiddenSession(oldFsPath: string, newFsPath: string): Promise<number> {
    if (!this.hiddenSessionStore) return 0;
    try {
      return (await this.hiddenSessionStore.relocate(oldFsPath, newFsPath)) ? 1 : 0;
    } catch (error) {
      this.logRelocationFailure("hiddenSessions", oldFsPath, newFsPath, error);
      return 0;
    }
  }

  private logRelocationFailure(store: string, oldFsPath: string, newFsPath: string, error: unknown): void {
    this.logger?.debug(
      formatDebugFields("sessionReferenceRelocator.failed", {
        store,
        oldFile: safeDebugBasename(oldFsPath),
        newFile: safeDebugBasename(newFsPath),
        error: sanitizeDebugError(error),
      }),
    );
  }
}
