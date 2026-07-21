export interface SearchExecutionSettlement {
  readonly clearSearch: boolean;
  readonly rerunAutomatically: boolean;
}

export type AutomaticSearchRequestDisposition = "runNow" | "deferred";

// Owns one active search generation and coalesces passive UI intents behind it.
export class SearchExecutionCoordinator {
  private nextGeneration = 0;
  private activeGeneration: number | null = null;
  private pendingAutomaticRerun = false;
  private pendingClearSearch = false;

  public get isSearchActive(): boolean {
    return this.activeGeneration !== null;
  }

  public beginSearch(): number {
    const generation = ++this.nextGeneration;
    this.activeGeneration = generation;
    this.pendingAutomaticRerun = false;
    return generation;
  }

  public isCurrent(generation: number): boolean {
    return this.activeGeneration === generation;
  }

  public requestAutomaticRerun(): AutomaticSearchRequestDisposition {
    if (this.activeGeneration === null) return "runNow";
    this.pendingAutomaticRerun = true;
    return "deferred";
  }

  public requestClearSearch(): boolean {
    if (this.activeGeneration === null) return true;
    this.pendingClearSearch = true;
    return false;
  }

  public finishSearch(generation: number, published: boolean): SearchExecutionSettlement {
    if (this.activeGeneration !== generation) {
      return { clearSearch: false, rerunAutomatically: false };
    }

    this.activeGeneration = null;
    const settlement: SearchExecutionSettlement = published
      ? {
          clearSearch: false,
          rerunAutomatically: this.pendingAutomaticRerun,
        }
      : {
          clearSearch: this.pendingClearSearch,
          rerunAutomatically: false,
        };
    this.pendingAutomaticRerun = false;
    this.pendingClearSearch = false;
    return settlement;
  }
}
