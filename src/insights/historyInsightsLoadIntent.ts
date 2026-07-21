export type HistoryInsightsLoadIntent = "cancel" | "resume";

export class HistoryInsightsLoadIntentTracker {
  private revision = 0;
  private latestIntent: HistoryInsightsLoadIntent = "resume";

  public captureRevision(): number {
    return this.revision;
  }

  public record(intent: HistoryInsightsLoadIntent): void {
    this.revision += 1;
    this.latestIntent = intent;
  }

  public wasCancelledSince(revision: number): boolean {
    return this.revision !== revision && this.latestIntent === "cancel";
  }
}
