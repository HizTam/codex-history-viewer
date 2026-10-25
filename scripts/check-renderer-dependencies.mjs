import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRendererDependencies } from "./renderer-dependency-guard.mjs";

// Keep CLI verification read-only; dependency installation remains an explicit developer operation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  validateRendererDependencies(root);
  console.log("Renderer and development authentication dependencies verified.");
} catch (error) {
  console.error(`Dependency verification failed: ${error.message}`);
  process.exitCode = 1;
}
