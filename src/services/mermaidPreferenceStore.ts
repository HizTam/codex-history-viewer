import type * as vscode from "vscode";

export type MermaidThemePreference = "auto" | "light" | "dark";
export type MermaidSaveFormatPreference = "svg" | "png" | "mmd";
export type MermaidPreferences = {
  themePreference: MermaidThemePreference;
  saveFormat: MermaidSaveFormatPreference;
};

const MERMAID_THEME_PREFERENCE_KEY = "codexHistoryViewer.mermaid.themePreference.v1";
const MERMAID_SAVE_FORMAT_KEY = "codexHistoryViewer.mermaid.saveFormat.v1";

type MutationState = {
  nextSequence: number;
  highestClaimedSequence: number;
  mutationQueue: Promise<void>;
};

export function parseMermaidThemePreference(value: unknown): MermaidThemePreference | undefined {
  return value === "auto" || value === "light" || value === "dark" ? value : undefined;
}

export function parseMermaidSaveFormatPreference(value: unknown): MermaidSaveFormatPreference | undefined {
  return value === "svg" || value === "png" || value === "mmd" ? value : undefined;
}

// Stores global Mermaid presentation preferences without session or diagram data.
export class MermaidPreferenceStore {
  private readonly themeState: MutationState = {
    nextSequence: 0,
    highestClaimedSequence: 0,
    mutationQueue: Promise.resolve(),
  };
  private readonly saveFormatState: MutationState = {
    nextSequence: 0,
    highestClaimedSequence: 0,
    mutationQueue: Promise.resolve(),
  };

  constructor(private readonly memento: Pick<vscode.Memento, "get" | "update">) {}

  public get(): MermaidPreferences {
    return {
      themePreference: parseMermaidThemePreference(this.memento.get<unknown>(MERMAID_THEME_PREFERENCE_KEY)) ?? "auto",
      saveFormat: parseMermaidSaveFormatPreference(this.memento.get<unknown>(MERMAID_SAVE_FORMAT_KEY)) ?? "svg",
    };
  }

  public beginThemeUpdate(): number {
    this.themeState.nextSequence += 1;
    return this.themeState.nextSequence;
  }

  public beginSaveFormatUpdate(): number {
    this.saveFormatState.nextSequence += 1;
    return this.saveFormatState.nextSequence;
  }

  public updateThemePreference(value: MermaidThemePreference, sequence: number): Promise<boolean> {
    if (parseMermaidThemePreference(value) !== value) return Promise.resolve(false);
    return this.enqueueUpdate(
      this.themeState,
      MERMAID_THEME_PREFERENCE_KEY,
      value,
      sequence,
      () => this.get().themePreference,
    );
  }

  public updateSaveFormat(value: MermaidSaveFormatPreference, sequence: number): Promise<boolean> {
    if (parseMermaidSaveFormatPreference(value) !== value) return Promise.resolve(false);
    return this.enqueueUpdate(
      this.saveFormatState,
      MERMAID_SAVE_FORMAT_KEY,
      value,
      sequence,
      () => this.get().saveFormat,
    );
  }

  private enqueueUpdate<T extends string>(
    state: MutationState,
    key: string,
    value: T,
    sequence: number,
    getCurrent: () => T,
  ): Promise<boolean> {
    const operation = async (): Promise<boolean> => {
      if (!Number.isSafeInteger(sequence) || sequence <= state.highestClaimedSequence) return false;

      // Claim before storage I/O so an older request cannot overwrite a newer request.
      state.highestClaimedSequence = sequence;
      if (getCurrent() === value) return false;

      await this.memento.update(key, value);
      return true;
    };
    const result = state.mutationQueue.then(operation, operation);
    state.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
