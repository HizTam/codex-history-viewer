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
import mermaid from "mermaid";

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

// Expose a constrained Mermaid bridge for the chat webview.
(function initializeMermaidBridge() {
  const MAX_SOURCE_LENGTH = 100000;
  const MAX_FLOWCHART_ROLE_NODES = 2048;
  const FLOWCHART_DIAGRAM_TYPES = new Set(["flowchart", "flowchart-v2"]);
  const FLOWCHART_DECISION_SHAPES = new Set([
    "choice",
    "diam",
    "decision",
    "diamond",
    "question",
  ]);
  const FLOWCHART_INPUT_OUTPUT_SHAPES = new Set([
    "curv-trap",
    "curved-trapezoid",
    "display",
    "in-out",
    "lean-l",
    "lean-left",
    "lean-r",
    "lean-right",
    "lean_left",
    "lean_right",
    "manual-input",
    "out-in",
    "sl-rect",
    "sloped-rectangle",
  ]);
  const FLOWCHART_TERMINAL_SHAPES = new Set([
    "circ",
    "circle",
    "dbl-circ",
    "double-circle",
    "doublecircle",
    "ellipse",
    "fr-circ",
    "framed-circle",
    "pill",
    "small-circle",
    "sm-circ",
    "start",
    "stateend",
    "statestart",
    "stadium",
    "stop",
    "terminal",
  ]);
  const FLOWCHART_DATA_SHAPES = new Set([
    "bow-rect",
    "bow-tie-rectangle",
    "cyl",
    "cylinder",
    "das",
    "data-store",
    "database",
    "datastore",
    "db",
    "disk",
    "doc",
    "document",
    "documents",
    "h-cyl",
    "horizontal-cylinder",
    "internal-storage",
    "lin-cyl",
    "lined-cylinder",
    "multi-document",
    "st-doc",
    "stacked-document",
    "stored-data",
    "win-pane",
    "window-pane",
  ]);
  let renderQueue = Promise.resolve();

  function normalizeSource(rawSource) {
    let source = String(rawSource ?? "").replace(/\r\n?/g, "\n");
    if (!source.trim() || source.length > MAX_SOURCE_LENGTH || source.includes("\0")) {
      throw new Error("Invalid Mermaid source.");
    }

    const frontmatterOpening = /^([^\S\n]*)---[^\S\n]*\n/u.exec(source);
    if (frontmatterOpening) {
      const frontmatterIndent = frontmatterOpening[1] || "";
      let lineStart = frontmatterOpening[0].length;
      let frontmatterEnd = -1;
      while (lineStart < source.length) {
        const lineEnd = source.indexOf("\n", lineStart);
        if (lineEnd < 0) break;
        const line = source.slice(lineStart, lineEnd);
        if (
          line.startsWith(frontmatterIndent) &&
          /^---[^\S\n]*$/u.test(line.slice(frontmatterIndent.length))
        ) {
          frontmatterEnd = lineEnd + 1;
          break;
        }
        lineStart = lineEnd + 1;
      }
      if (frontmatterEnd < 0) throw new Error("Invalid Mermaid source.");
      source = source.slice(frontmatterEnd);
    }

    source = source.replace(/%%\{\s*(?:init|initialize|config)\s*:[\s\S]*?\}%%/giu, "");
    source = source
      .split("\n")
      .filter((line) => !/^\s*click(?:\s|$)/iu.test(line))
      .join("\n");

    if (!source.trim()) throw new Error("Invalid Mermaid source.");
    return source;
  }

  function buildThemeVariables(themeMode) {
    if (themeMode === "dark" || themeMode === "highContrastDark") {
      return {
        background: "#0f172a",
        darkMode: true,
        primaryColor: "#1d4ed8",
        primaryTextColor: "#f8fafc",
        primaryBorderColor: "#93c5fd",
        mainBkg: "#1d4ed8",
        rowOdd: "#172554",
        rowEven: "#1e3a8a",
        attributeBackgroundColorOdd: "#172554",
        attributeBackgroundColorEven: "#1e3a8a",
        secondaryColor: "#6d28d9",
        secondaryTextColor: "#f8fafc",
        secondaryBorderColor: "#c4b5fd",
        tertiaryColor: "#0f766e",
        tertiaryTextColor: "#f0fdfa",
        tertiaryBorderColor: "#5eead4",
        lineColor: "#cbd5e1",
        textColor: "#f8fafc",
        nodeBorder: "#93c5fd",
        clusterBkg: "#172554",
        clusterBorder: "#60a5fa",
        edgeLabelBackground: "#1e293b",
        noteBkgColor: "#713f12",
        noteBorderColor: "#facc15",
        noteTextColor: "#fefce8",
      };
    }

    return {
      background: "#ffffff",
      darkMode: false,
      primaryColor: "#dbeafe",
      primaryTextColor: "#172554",
      primaryBorderColor: "#2563eb",
      mainBkg: "#dbeafe",
      rowOdd: "#ffffff",
      rowEven: "#eff6ff",
      attributeBackgroundColorOdd: "#ffffff",
      attributeBackgroundColorEven: "#eff6ff",
      secondaryColor: "#ede9fe",
      secondaryTextColor: "#2e1065",
      secondaryBorderColor: "#7c3aed",
      tertiaryColor: "#ccfbf1",
      tertiaryTextColor: "#042f2e",
      tertiaryBorderColor: "#0f766e",
      lineColor: "#334155",
      textColor: "#0f172a",
      nodeBorder: "#2563eb",
      clusterBkg: "#eff6ff",
      clusterBorder: "#60a5fa",
      edgeLabelBackground: "#ffffff",
      noteBkgColor: "#fef3c7",
      noteBorderColor: "#d97706",
      noteTextColor: "#451a03",
    };
  }

  function getMindmapTheme(themeMode) {
    const dark = themeMode === "dark" || themeMode === "highContrastDark";
    return {
      rootFill: dark ? "#1e40af" : "#dbeafe",
      rootText: dark ? "#f8fafc" : "#172554",
      sections: dark
        ? [
            { fill: "#5b21b6", text: "#f8fafc", edge: "#a78bfa" },
            { fill: "#115e59", text: "#f0fdfa", edge: "#2dd4bf" },
            { fill: "#1e40af", text: "#f8fafc", edge: "#60a5fa" },
            { fill: "#78350f", text: "#fffbeb", edge: "#f59e0b" },
            { fill: "#881337", text: "#fff1f2", edge: "#fb7185" },
            { fill: "#164e63", text: "#ecfeff", edge: "#22d3ee" },
            { fill: "#14532d", text: "#f0fdf4", edge: "#4ade80" },
            { fill: "#312e81", text: "#eef2ff", edge: "#818cf8" },
            { fill: "#7c2d12", text: "#fff7ed", edge: "#fb923c" },
            { fill: "#701a75", text: "#fdf4ff", edge: "#e879f9" },
            { fill: "#334155", text: "#f8fafc", edge: "#94a3b8" },
          ]
        : [],
    };
  }

  function buildThemeCss(themeMode) {
    const mindmapTheme = getMindmapTheme(themeMode);
    const sectionCss = mindmapTheme.sections
      .map(
        (section, index) => `
          .mindmap-node.section-${index} rect,
          .mindmap-node.section-${index} path,
          .mindmap-node.section-${index} circle,
          .mindmap-node.section-${index} polygon,
          [data-look="neo"].mindmap-node.section-${index} rect,
          [data-look="neo"].mindmap-node.section-${index} path,
          [data-look="neo"].mindmap-node.section-${index} circle,
          [data-look="neo"].mindmap-node.section-${index} polygon {
            fill: ${section.fill};
            stroke: ${section.edge};
          }
          .mindmap-node.section-${index} text,
          .mindmap-node.section-${index} .text-inner-tspan,
          [data-look="neo"].mindmap-node.section-${index} text,
          [data-look="neo"].mindmap-node.section-${index} .text-inner-tspan {
            fill: ${section.text};
          }
          .mindmap-node.section-${index} span {
            color: ${section.text};
          }
          .section-edge-${index},
          [data-look="neo"].section-edge-${index},
          .mindmap-node.section-${index} line {
            stroke: ${section.edge};
          }
        `,
      )
      .join("\n");
    return `
      .mindmap-node.section-root rect,
      .mindmap-node.section-root path,
      .mindmap-node.section-root circle,
      .mindmap-node.section-root polygon,
      [data-look="neo"].mindmap-node.section-root rect,
      [data-look="neo"].mindmap-node.section-root path,
      [data-look="neo"].mindmap-node.section-root circle,
      [data-look="neo"].mindmap-node.section-root polygon {
        fill: ${mindmapTheme.rootFill};
      }
      .mindmap-node.section-root text,
      .mindmap-node.section-root .text-inner-tspan,
      [data-look="neo"].mindmap-node.section-root text,
      [data-look="neo"].mindmap-node.section-root .text-inner-tspan {
        fill: ${mindmapTheme.rootText};
        font-weight: 600;
      }
      ${sectionCss}
    `;
  }

  function getMermaidFlowchartNodeRole(rawShape) {
    const shape = String(rawShape ?? "square").trim().toLowerCase();
    if (FLOWCHART_DECISION_SHAPES.has(shape)) return "decision";
    if (FLOWCHART_INPUT_OUTPUT_SHAPES.has(shape)) return "input-output";
    if (FLOWCHART_TERMINAL_SHAPES.has(shape)) return "terminal";
    if (FLOWCHART_DATA_SHAPES.has(shape)) return "data";
    if (
      shape === "hex" ||
      shape === "hexagon" ||
      shape === "prepare" ||
      shape === "manual" ||
      shape === "priority" ||
      shape === "trap-b" ||
      shape === "trap-t" ||
      shape === "trapezoid" ||
      shape === "trapezoid-bottom" ||
      shape === "trapezoid-top" ||
      shape === "inv-trapezoid" ||
      shape === "inv_trapezoid"
    ) {
      return "special";
    }
    return "process";
  }

  function getMermaidFlowchartDomKey(value) {
    const domId = typeof value === "string" ? value : "";
    const match = /^(flowchart-.+)-\d+$/u.exec(domId);
    return match ? match[1] : "";
  }

  function getMermaidFlowchartNodeRoles(diagram) {
    if (!diagram || !FLOWCHART_DIAGRAM_TYPES.has(String(diagram.type || ""))) return [];
    const getVertices = diagram.db && diagram.db.getVertices;
    if (typeof getVertices !== "function") return [];
    const vertices = getVertices.call(diagram.db);
    if (!(vertices instanceof Map) || vertices.size > MAX_FLOWCHART_ROLE_NODES) return [];

    const roles = [];
    const domKeys = new Set();
    for (const vertex of vertices.values()) {
      const domId = vertex && typeof vertex.domId === "string" ? vertex.domId : "";
      const domKey = getMermaidFlowchartDomKey(domId);
      if (!domKey || domKey.length > 4096 || domKeys.has(domKey)) return [];
      domKeys.add(domKey);
      roles.push({
        domKey,
        role: getMermaidFlowchartNodeRole(vertex.type),
      });
    }
    return roles;
  }

  function renderDiagram(renderId, rawSource, themeMode) {
    const id = String(renderId ?? "");
    if (!/^chv-mermaid-[a-z0-9-]{1,96}$/u.test(id)) {
      return Promise.reject(new Error("Invalid Mermaid render identifier."));
    }

    const source = normalizeSource(rawSource);
    const mode =
      themeMode === "dark" || themeMode === "highContrastDark" || themeMode === "highContrastLight"
        ? themeMode
        : "light";
    const run = async () => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: buildThemeVariables(mode),
        themeCSS: buildThemeCss(mode),
        fontFamily: "var(--vscode-font-family, sans-serif)",
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: 1000,
        htmlLabels: false,
        flowchart: {
          htmlLabels: false,
          useMaxWidth: true,
        },
        sequence: {
          useMaxWidth: true,
        },
        gantt: {
          useMaxWidth: true,
        },
        secure: [
          "securityLevel",
          "startOnLoad",
          "suppressErrorRendering",
          "theme",
          "themeVariables",
          "themeCSS",
          "fontFamily",
          "maxTextSize",
          "maxEdges",
          "htmlLabels",
          "flowchart",
          "sequence",
          "gantt",
          "look",
          "layout",
        ],
      });
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
      const nodeRoles = getMermaidFlowchartNodeRoles(diagram);
      const rendered = await mermaid.render(id, source);
      return {
        diagramType: rendered.diagramType,
        nodeRoles,
        svg: rendered.svg,
      };
    };

    const result = renderQueue.then(run, run);
    renderQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  globalThis.codexHistoryViewerMermaid = Object.freeze({
    render: renderDiagram,
  });
})();
