// Shared file-path language inference for diff webviews.
(function initializeCodeLanguageSupport() {
  const LANGUAGE_BY_EXTENSION = Object.freeze({
    ".ascx": "html",
    ".aspx": "html",
    ".automount": "systemd",
    ".bas": "vb",
    ".bash": "shellscript",
    ".bat": "bat",
    ".bicep": "bicep",
    ".bicepparam": "bicep",
    ".c": "c",
    ".c++": "cpp",
    ".cc": "cpp",
    ".cjs": "javascript",
    ".cmd": "bat",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".cshtml": "razor",
    ".csl": "kusto",
    ".css": "css",
    ".csx": "csharp",
    ".cts": "typescript",
    ".cxx": "cpp",
    ".ddl": "sql",
    ".device": "systemd",
    ".dml": "sql",
    ".dtx": "latex",
    ".env": "dotenv",
    ".frm": "vb",
    ".fs": "fsharp",
    ".fsi": "fsharp",
    ".fsscript": "fsharp",
    ".fsx": "fsharp",
    ".go": "go",
    ".h": "c",
    ".hcl": "hcl",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".htaccess": "apache",
    ".htm": "html",
    ".html": "html",
    ".hxx": "cpp",
    ".ini": "ini",
    ".ins": "latex",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".json5": "json",
    ".jsonc": "jsonc",
    ".jsx": "jsx",
    ".kql": "kusto",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".kusto": "kusto",
    ".link": "systemd",
    ".ltx": "latex",
    ".master": "html",
    ".md": "markdown",
    ".mjs": "javascript",
    ".mount": "systemd",
    ".mts": "typescript",
    ".mysql": "sql",
    ".netdev": "systemd",
    ".network": "systemd",
    ".nginx": "nginx",
    ".path": "systemd",
    ".pck": "plsql",
    ".pgsql": "sql",
    ".php": "php",
    ".pkb": "plsql",
    ".pkh": "plsql",
    ".pks": "plsql",
    ".pl": "perl",
    ".plb": "plsql",
    ".plpgsql": "sql",
    ".plsql": "plsql",
    ".pm": "perl",
    ".pod": "perl",
    ".proto": "proto",
    ".ps1": "powershell",
    ".psd1": "powershell",
    ".psgi": "perl",
    ".psm1": "powershell",
    ".psql": "sql",
    ".py": "python",
    ".pyw": "python",
    ".razor": "razor",
    ".rb": "ruby",
    ".reg": "reg",
    ".rs": "rust",
    ".scope": "systemd",
    ".service": "systemd",
    ".sh": "shellscript",
    ".slice": "systemd",
    ".snapshot": "systemd",
    ".socket": "systemd",
    ".sql": "sql",
    ".sty": "latex",
    ".swap": "systemd",
    ".swift": "swift",
    ".target": "systemd",
    ".tex": "latex",
    ".tf": "terraform",
    ".timer": "systemd",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsql": "sql",
    ".tsx": "tsx",
    ".vb": "vb",
    ".vba": "vb",
    ".vbhtml": "razor",
    ".vbs": "vb",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zsh": "shellscript",
  });
  const LANGUAGE_BY_FILENAME = Object.freeze({
    "apache2.conf": "apache",
    cpanfile: "perl",
    dockerfile: "dockerfile",
    envvars: "apache",
    gemfile: "ruby",
    "httpd-ssl.conf": "apache",
    "httpd-vhosts.conf": "apache",
    "httpd.conf": "apache",
    makefile: "makefile",
    "nginx.conf": "nginx",
    rakefile: "ruby",
    ssh_config: "ssh-config",
    sshd_config: "ssh-config",
    vagrantfile: "ruby",
  });

  function inferLanguageFromPath(rawPath) {
    const normalized = String(rawPath || "").trim().replace(/\\/g, "/");
    if (!normalized) return "";

    const segments = normalized.split("/");
    const fileName = String(segments[segments.length - 1] || "").toLowerCase();
    if (!fileName) return "";

    if (LANGUAGE_BY_FILENAME[fileName]) return LANGUAGE_BY_FILENAME[fileName];
    if (fileName.startsWith(".env.")) return "dotenv";
    if (fileName.startsWith("dockerfile.")) return "dockerfile";
    if (fileName.startsWith("makefile.")) return "makefile";

    const directoryNames = segments.slice(0, -1).map((segment) => String(segment || "").toLowerCase());
    const parentDirectory = directoryNames[directoryNames.length - 1] || "";
    if (fileName === "config" && parentDirectory === ".ssh") return "ssh-config";
    if (directoryNames.includes(".ssh") && parentDirectory === "config.d") return "ssh-config";
    if (
      fileName.endsWith(".conf") &&
      /\.(?:automount|device|link|mount|netdev|network|path|scope|service|slice|snapshot|socket|swap|target|timer)\.d$/u.test(
        parentDirectory,
      )
    ) {
      return "systemd";
    }
    if (fileName.endsWith(".conf") && directoryNames.some((name) => name === "apache2" || name === "httpd")) {
      return "apache";
    }
    if (fileName.endsWith(".conf") && directoryNames.includes("nginx")) return "nginx";

    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex < 0) return "";
    const extension = fileName.slice(dotIndex).toLowerCase();
    return LANGUAGE_BY_EXTENSION[extension] || "";
  }

  globalThis.codexHistoryViewerCodeLanguageSupport = Object.freeze({ inferLanguageFromPath });
})();
