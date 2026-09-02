# Security Policy

Last updated: 2026-09-02

## Supported Versions

Use the latest published release of Codex History Viewer whenever possible. Older VSIX files may contain bundled dependencies that have since received security fixes.

| Version | Security status |
| --- | --- |
| 2.13.0 and later | Recommended. Includes the current KaTeX, Mermaid, DOMPurify, and Markdown renderer dependency updates and the Markdown rendering mitigations noted below. |
| 2.11.0 through 2.12.0 | Includes the Mermaid and DOMPurify dependency updates and the earlier Markdown rendering mitigations, but bundles the older KaTeX and Markdown renderer versions noted below; upgrade to 2.13.0 or later. |
| 2.10.0 | Bundles Mermaid and DOMPurify versions covered by the advisories noted below; upgrade to 2.13.0 or later. |
| 2.8.0 through 2.9.x | Includes the earlier Markdown rendering mitigations and does not include Mermaid rendering, but bundles the older KaTeX and Markdown renderer versions noted below; upgrade to 2.13.0 or later. |
| 1.2.2 through 2.7.x | Does not include all current Markdown and KaTeX dependency security updates; upgrade to 2.13.0 or later. |
| 1.2.1 and earlier | Do not install or redistribute historical VSIX files. |

## Security Notes

### KaTeX math rendering

Codex History Viewer v1.3.0 introduced KaTeX-based rendering for inline and block math in the Session Viewer. Releases from v1.3.0 through v2.12.0 bundled `katex@0.16.8`.

KaTeX 0.16.8 is within the affected ranges for the [`\edef` expansion-limit bypass (GHSA-64fm-8hw2-v72w)](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-64fm-8hw2-v72w) and the [Unicode subscript/superscript expansion-limit bypass (GHSA-cvr6-37gx-v8wc)](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-cvr6-37gx-v8wc), both fixed in 0.16.10. Malicious untrusted math input can use these issues to consume memory, block the main thread, or overflow the stack. It also predates the [`\htmlData` attribute-name validation fix (GHSA-cg87-wmx4-v546)](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-cg87-wmx4-v546) released in 0.16.21.

The Session Viewer renders session math as untrusted input with `trust: false`. This prevents trusted-only commands such as `\htmlData` from being enabled, but it does not replace the expansion-limit fixes. Codex History Viewer v2.13.0 updates the direct `media/vendor/katex` renderer to `katex@0.18.5`, which also includes the [own-property checks introduced in KaTeX 0.18.2](https://github.com/KaTeX/KaTeX/pull/4260) to prevent polluted prototypes from influencing renderer settings or inherited macros. Release-time byte-for-byte verification ensures that the vendored JavaScript, CSS, license, and fonts cannot silently remain on an older installed version.

Mermaid 11.17.2 separately declares `katex@^0.16.47` for diagram math, which resolves to `katex@0.16.47` inside the generated Mermaid bundle. This separate dependency is newer than the 0.16.10 and 0.16.21 security fixes described above and is intentionally kept within Mermaid's supported dependency range instead of being overridden with KaTeX 0.18.x.

Users of Codex History Viewer v1.3.0 through v2.12.0 should upgrade to v2.13.0 or later before opening untrusted session files containing math expressions.

### Mermaid diagram rendering and export

Codex History Viewer v2.10.0 introduced fenced Mermaid rendering in the Session Viewer and bundled `mermaid@11.16.0` with `dompurify@3.4.12`. These dependency versions are covered by upstream advisories for prototype pollution (`GHSA-c4c3-pg64-4m4v`, `GHSA-3rrr-jr9j-h3q3`), CSS injection (`GHSA-6x64-9x62-f2gx`), denial of service (`GHSA-2v8p-3f2j-5mp7`, `GHSA-rhh3-jpg6-66xh`), and XSS (`GHSA-55q2-fjhq-7xh7`). Codex History Viewer v2.11.0 updates the bundled dependencies to `mermaid@11.16.1` and `dompurify@3.4.13`, and v2.13.0 further updates Mermaid to `11.17.2`. Users of v2.10.0 should upgrade to v2.13.0 or later.

Mermaid source from session files is treated as untrusted input. Rendering uses fixed security settings, disables HTML labels, and removes frontmatter configuration overrides, initialization directives, and click directives before the source reaches Mermaid. These controls reduce exposure to unsafe diagram content but do not replace dependency updates.

Generated SVG is parsed and validated before it is inserted into the webview. Executable or externally loaded content, event-handler attributes, unsafe URLs, and unsafe CSS are rejected. XML Base attributes are removed so that internal fragment references cannot be resolved as external resources. SVG export is independently validated again by the extension host, which rejects XML Base attributes and link elements without trusting the webview sanitizer. PNG export is bounded by dimension and pixel-count limits, and files are written only to a location selected through the VS Code save dialog.

Rendering and export also enforce limits on Mermaid source length, diagrams per message, graph edges, generated SVG structure, and exported image size. Inputs that exceed rendering limits fall back to source display or a bounded error state instead of bypassing these checks.

### markdown-it GHSA-38c4-r59v-3vqw / CVE-2026-2327

Codex History Viewer uses `markdown-it` to render Markdown content in the chat webview.

The `markdown-it` ReDoS advisory GHSA-38c4-r59v-3vqw / CVE-2026-2327 affects `markdown-it` versions `>=13.0.0 <14.1.1`. Codex History Viewer v1.2.2 and later bundle `markdown-it@14.1.1` or newer, which includes the upstream fix.

Do not install or redistribute Codex History Viewer v1.2.1 or earlier from local VSIX files, because those historical packages may bundle `markdown-it@14.1.0`. If you installed an older VSIX manually, upgrade to v2.13.0 or later.

### linkify-it GHSA-v245-v573-v5vm / CVE-2026-59887

The browser distribution used through Codex History Viewer v2.7.x was based on `markdown-it@14.1.1` and contained `linkify-it` mail-address detection code from before the upstream `5.0.2` fix. Repeated `mailto:` prefixes can cause quadratic CPU usage while linkifying untrusted Markdown text.

Codex History Viewer v2.8.0 updates the distributed browser implementation to `markdown-it@14.3.0` with `linkify-it@5.0.2`. It also keeps defense-in-depth initialization: Markdown auto-linking starts in a fail-closed state, both fuzzy email detection and the `mailto:` auto-detection schema are disabled, and only then is ordinary URL linkification enabled. Explicit Markdown mail links such as `[mail](mailto:user@example.com)` and `<user@example.com>` remain available.

Upgrade older installations to v2.13.0 or later. Do not open untrusted or unusually large history files in versions that do not include this mitigation.

### markdown-it 14.3.1 linkification performance fixes

The [`markdown-it@14.3.1` release](https://github.com/markdown-it/markdown-it/releases/tag/14.3.1) backports the security fixes from [`markdown-it@15.0.1`](https://github.com/markdown-it/markdown-it/blob/15.0.1/CHANGELOG.md#1501---2026-08-27) for quadratic-complexity behavior while replacing fuzzy links and while scanning backward for URL schemes in the inline linkification rule. Codex History Viewer processes session Markdown as untrusted input and keeps ordinary URL linkification enabled, so disabling fuzzy email and `mailto:` auto-detection alone does not replace these upstream fixes.

Codex History Viewer v2.13.0 updates the distributed browser implementation from `markdown-it@14.3.0` to `markdown-it@14.3.1` while retaining the existing fail-closed initialization and link validation. The v14 security backport is used instead of the breaking v15 renderer migration.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/HizTam/codex-history-viewer/security/advisories/new).

Do not post vulnerability details, reproduction steps, exploit code, secrets, tokens, personal data, or other sensitive information in GitHub Discussions or other public channels.

For non-security bug reports, questions, and feature requests, use [GitHub Discussions](https://github.com/HizTam/codex-history-viewer/discussions).

When reporting a vulnerability, include:

- The affected extension version.
- The operating system and VS Code version.
- Reproduction steps using non-sensitive sample data.
- The expected and actual behavior.
- Any relevant dependency or VSIX version information.

Security-related fixes should avoid logging secrets, credentials, tokens, local file contents, or personally identifiable information.
