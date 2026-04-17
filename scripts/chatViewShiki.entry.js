import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import javascript from "@shikijs/langs/javascript";
import java from "@shikijs/langs/java";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import kotlin from "@shikijs/langs/kotlin";
import makefile from "@shikijs/langs/makefile";
import markdown from "@shikijs/langs/markdown";
import nginx from "@shikijs/langs/nginx";
import php from "@shikijs/langs/php";
import proto from "@shikijs/langs/proto";
import powershell from "@shikijs/langs/powershell";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import toml from "@shikijs/langs/toml";
import terraform from "@shikijs/langs/terraform";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import githubDarkHighContrast from "@shikijs/themes/github-dark-high-contrast";
import githubLightHighContrast from "@shikijs/themes/github-light-high-contrast";
import lightPlus from "@shikijs/themes/light-plus";

// Expose a small Shiki bridge for the chat webview.
(function initializeShikiBridge() {
  const LIGHT_THEME_NAME = "light-plus";
  const DARK_THEME_NAME = "dark-plus";
  const HIGH_CONTRAST_LIGHT_THEME_NAME = "github-light-high-contrast";
  const HIGH_CONTRAST_DARK_THEME_NAME = "github-dark-high-contrast";

  const displayLabelMap = {
    shellscript: "bash",
  };

  const languageAliasMap = {
    "c#": "csharp",
    cjs: "javascript",
    cs: "csharp",
    console: "shellscript",
    css: "css",
    docker: "dockerfile",
    golang: "go",
    h: "c",
    hpp: "cpp",
    htm: "html",
    html: "html",
    html5: "html",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    json5: "json",
    jsonc: "jsonc",
    kt: "kotlin",
    kts: "kotlin",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    psql: "sql",
    plain: "plaintext",
    plaintext: "plaintext",
    powershell: "powershell",
    ps: "powershell",
    ps1: "powershell",
    rb: "ruby",
    rs: "rust",
    pwsh: "powershell",
    shellsession: "shellscript",
    sh: "shellscript",
    zsh: "shellscript",
    shell: "shellscript",
    sql: "sql",
    tf: "terraform",
    text: "plaintext",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };

  let highlighter = null;
  try {
    // Load only commonly used grammars to keep the webview bundle smaller.
    highlighter = createHighlighterCoreSync({
      engine: createJavaScriptRegexEngine(),
      langs: [
        bash,
        c,
        cpp,
        csharp,
        css,
        diff,
        dockerfile,
        go,
        html,
        ini,
        javascript,
        java,
        json,
        jsonc,
        jsx,
        kotlin,
        makefile,
        markdown,
        nginx,
        php,
        proto,
        powershell,
        python,
        ruby,
        rust,
        sql,
        swift,
        toml,
        terraform,
        tsx,
        typescript,
        xml,
        yaml,
      ],
      themes: [lightPlus, darkPlus, githubLightHighContrast, githubDarkHighContrast],
    });
  } catch (error) {
    console.error("[codex-history-viewer] Failed to initialize Shiki.", error);
  }

  function normalizeLanguage(rawLanguage, codeText) {
    const normalizedRaw = String(rawLanguage || "").trim().toLowerCase();
    const aliased = languageAliasMap[normalizedRaw] || normalizedRaw;
    if (aliased === "plaintext") return "";
    if (aliased) return aliased;

    const text = String(codeText || "").trimStart();
    if (!text) return "";
    if (/^#!\s*\/.*\b(?:ba|z)?sh\b/m.test(text)) return "shellscript";
    if (/^(?:diff --git|--- .+\r?\n\+\+\+ .+)/m.test(text)) return "diff";
    if (/^(?:\$ |# |PS> )/m.test(text)) return "shellscript";
    if ((text.startsWith("{") || text.startsWith("[")) && looksLikeJson(text)) return "json";
    return "";
  }

  function looksLikeJson(text) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  function getLanguageLabel(rawLanguage, codeText) {
    const normalized = normalizeLanguage(rawLanguage, codeText);
    if (!normalized) return rawLanguage ? String(rawLanguage).trim() : "";
    return displayLabelMap[normalized] || normalized;
  }

  function highlightCodeHtml(codeText, normalizedLanguage) {
    if (!highlighter) return "";

    try {
      return highlighter.codeToHtml(String(codeText || ""), {
        lang: normalizedLanguage,
        themes: {
          dark: DARK_THEME_NAME,
          hcDark: HIGH_CONTRAST_DARK_THEME_NAME,
          hcLight: HIGH_CONTRAST_LIGHT_THEME_NAME,
          light: LIGHT_THEME_NAME,
        },
      });
    } catch (error) {
      console.warn("[codex-history-viewer] Shiki highlight fallback.", {
        error,
        language: normalizedLanguage,
      });
      return "";
    }
  }

  function highlightCodeToHtml(codeText, rawLanguage) {
    if (!highlighter) return "";

    const normalized = normalizeLanguage(rawLanguage, codeText);
    if (!normalized) return "";

    return highlightCodeHtml(codeText, normalized);
  }

  function highlightLineFragment(codeText, rawLanguage) {
    if (!highlighter) return "";

    const normalized = normalizeLanguage(rawLanguage, codeText);
    if (!normalized) return null;

    const html = highlightCodeHtml(codeText, normalized);
    if (!html || typeof document === "undefined") return null;

    const tmp = document.createElement("div");
    tmp.innerHTML = html.trim();
    const preEl = tmp.querySelector("pre");
    const codeEl = tmp.querySelector("code");
    if (!(preEl instanceof HTMLElement) || !(codeEl instanceof HTMLElement)) return null;

    const lineEl = codeEl.querySelector(".line");
    return {
      className: preEl.className || "",
      html: lineEl instanceof HTMLElement ? lineEl.innerHTML || "" : codeEl.innerHTML || "",
      style: preEl.getAttribute("style") || "",
    };
  }

  function highlightLineToHtml(codeText, rawLanguage) {
    const fragment = highlightLineFragment(codeText, rawLanguage);
    return fragment && typeof fragment.html === "string" ? fragment.html : "";
  }

  globalThis.codexHistoryViewerShiki = {
    getLanguageLabel,
    highlightCodeToHtml,
    highlightLineFragment,
    highlightLineToHtml,
    normalizeLanguage,
  };
})();
