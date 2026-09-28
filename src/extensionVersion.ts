// Resolve package metadata relative to this module, never to a workspace or the process cwd.
const packagedManifest: unknown = require("../package.json");
const packagedVersion = readExtensionVersion(packagedManifest);
if (packagedVersion === undefined) {
  throw new Error("The extension package has no valid version.");
}
const currentVersion: string = packagedVersion;

export function getExtensionVersion(manifest?: unknown): string {
  return readExtensionVersion(manifest) ?? currentVersion;
}

export function isBoundedExtensionVersion(value: unknown): value is string {
  // Preserve the metadata backup contract, including valid explicit producer versions.
  return typeof value === "string" &&
    value.length <= 64 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function readExtensionVersion(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
  const version: unknown = (manifest as Record<string, unknown>).version;
  return isBoundedExtensionVersion(version) ? version : undefined;
}
