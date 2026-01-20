import * as vscode from "vscode";

// Safe JSON read/write helpers for global storage (UTF-8).

export async function readJson<T>(uri: vscode.Uri): Promise<T | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder("utf-8").decode(buf);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeJson<T>(uri: vscode.Uri, data: T): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  const buf = new TextEncoder().encode(text);
  await vscode.workspace.fs.writeFile(uri, buf);
}
