# Security Policy

Last updated: 2026-04-30

## Supported Versions

Use the latest published release of Codex History Viewer whenever possible. Older VSIX files may contain bundled dependencies that have since received security fixes.

| Version | Security status |
| --- | --- |
| Latest release | Recommended. |
| 1.2.2 and later | Includes the `markdown-it` fix noted below; upgrade to the latest release when possible. |
| 1.2.1 and earlier | Do not install or redistribute historical VSIX files. |

## Security Notes

### markdown-it GHSA-38c4-r59v-3vqw / CVE-2026-2327

Codex History Viewer uses `markdown-it` to render Markdown content in the chat webview.

The `markdown-it` ReDoS advisory GHSA-38c4-r59v-3vqw / CVE-2026-2327 affects `markdown-it` versions `>=13.0.0 <14.1.1`. Codex History Viewer v1.2.2 and later bundle `markdown-it@14.1.1` or newer, which includes the upstream fix.

Do not install or redistribute Codex History Viewer v1.2.1 or earlier from local VSIX files, because those historical packages may bundle `markdown-it@14.1.0`. If you installed an older VSIX manually, upgrade to v1.2.2 or later.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through the GitHub repository's security reporting feature when available. If private reporting is unavailable, open a GitHub issue with a minimal description and avoid posting exploit details, secrets, tokens, personal data, or other sensitive information publicly.

When reporting a vulnerability, include:

- The affected extension version.
- The operating system and VS Code version.
- Reproduction steps using non-sensitive sample data.
- The expected and actual behavior.
- Any relevant dependency or VSIX version information.

Security-related fixes should avoid logging secrets, credentials, tokens, local file contents, or personally identifiable information.
