export function selectVisibleProjectOptionKeys(
  orderedKeys: readonly string[],
  requiredKeys: ReadonlySet<string>,
  maximum: number,
): ReadonlySet<string> {
  const limit = Math.max(0, Math.floor(maximum));
  const selected = new Set<string>();
  for (const key of orderedKeys) {
    if (selected.size >= limit) break;
    if (requiredKeys.has(key)) selected.add(key);
  }
  for (const key of orderedKeys) {
    if (selected.size >= limit) break;
    selected.add(key);
  }
  return selected;
}
