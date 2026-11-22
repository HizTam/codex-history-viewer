import { createHash } from "node:crypto";
import type { BookmarkTargetKind } from "../services/bookmarkStore";

const targetFingerprint = Symbol("antigravityTargetFingerprint");
type Target = { [targetFingerprint]?: { readonly kind: BookmarkTargetKind; readonly targetHash: string } };
export function antigravityNativeKey(conversationId: string, trajectoryId: string, index: number, kind: string): string {
  return createHash("sha256").update(JSON.stringify([conversationId, trajectoryId, index, kind]), "utf8").digest("hex");
}
export function setAntigravityTargetFingerprint(item: object, kind: BookmarkTargetKind, nativeKey: string, semanticContent: unknown, partial: boolean): void {
  const targetHash = createHash("sha256").update(JSON.stringify(["antigravity-target-v1", "antigravity", kind, nativeKey, partial, semanticContent]), "utf8").digest("hex");
  // Enumerable Symbols survive host-side spreads and are omitted by Webview JSON serialization.
  Object.defineProperty(item, targetFingerprint, { value: Object.freeze({ kind, targetHash }), enumerable: true });
}
export function getAntigravityTargetFingerprint(item: object): { readonly kind: BookmarkTargetKind; readonly targetHash: string } | undefined {
  return (item as Target)[targetFingerprint];
}
export function copyAntigravityTargetFingerprint<T extends object>(source: object, target: T): T {
  const fingerprint = getAntigravityTargetFingerprint(source);
  // Copy only the host-owned symbol, never heavy tool fields or unrelated properties.
  if (fingerprint) Object.defineProperty(target, targetFingerprint, { value: fingerprint, enumerable: true });
  return target;
}
export function isAntigravityProgressId(value: unknown): value is string {
  return typeof value === "string" && /^ag-[a-f0-9]{32}$/.test(value);
}
