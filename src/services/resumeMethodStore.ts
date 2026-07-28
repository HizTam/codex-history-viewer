import * as vscode from "vscode";

export type ResumeActionMethod = "extension" | "cli";
export type ResumeSource = "codex" | "claude";

const RESUME_METHOD_KEYS: Record<ResumeSource, string> = {
  codex: "codexHistoryViewer.resume.lastMethod.codex.v1",
  claude: "codexHistoryViewer.resume.lastMethod.claude.v1",
};

type SourceState = {
  nextSequence: number;
  highestSuccessfulSequence: number;
  mutationQueue: Promise<void>;
};

function normalizeResumeActionMethod(value: unknown): ResumeActionMethod {
  return value === "cli" ? "cli" : "extension";
}

// Stores source-global resume preferences without persisting session information.
export class ResumeMethodStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ResumeSource>();
  private readonly state: Record<ResumeSource, SourceState> = {
    codex: { nextSequence: 0, highestSuccessfulSequence: 0, mutationQueue: Promise.resolve() },
    claude: { nextSequence: 0, highestSuccessfulSequence: 0, mutationQueue: Promise.resolve() },
  };

  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  public get(source: ResumeSource): ResumeActionMethod {
    return normalizeResumeActionMethod(this.memento.get<unknown>(RESUME_METHOD_KEYS[source]));
  }

  public beginInvocation(source: ResumeSource): number {
    const sourceState = this.state[source];
    sourceState.nextSequence += 1;
    return sourceState.nextSequence;
  }

  public recordSuccessful(
    source: ResumeSource,
    method: ResumeActionMethod,
    sequence: number,
  ): Promise<boolean> {
    const sourceState = this.state[source];
    const operation = async (): Promise<boolean> => {
      if (!Number.isSafeInteger(sequence) || sequence <= sourceState.highestSuccessfulSequence) return false;

      // Claim the successful sequence before storage I/O so an older completion cannot
      // overwrite the existing value after a newer write failure.
      sourceState.highestSuccessfulSequence = sequence;
      if (this.get(source) === method) return false;

      await this.memento.update(RESUME_METHOD_KEYS[source], method);
      this.onDidChangeEmitter.fire(source);
      return true;
    };
    const result = sourceState.mutationQueue.then(operation, operation);
    sourceState.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
