# Security Policy

Last updated: 2026-07-17

## Supported Versions

Use the latest published release of Codex History Viewer whenever possible. Older VSIX files may contain bundled dependencies that have since received security fixes.

| Version | Security status |
| --- | --- |
| 2.8.0 and later | Recommended. Includes both Markdown rendering mitigations noted below. |
| 1.2.2 through 2.7.x | Includes the `markdown-it` fix, but not the `linkify-it` mail-address mitigation; upgrade to 2.8.0 or later. |
| 1.2.1 and earlier | Do not install or redistribute historical VSIX files. |

## Security Notes

### markdown-it GHSA-38c4-r59v-3vqw / CVE-2026-2327

Codex History Viewer uses `markdown-it` to render Markdown content in the chat webview.

The `markdown-it` ReDoS advisory GHSA-38c4-r59v-3vqw / CVE-2026-2327 affects `markdown-it` versions `>=13.0.0 <14.1.1`. Codex History Viewer v1.2.2 and later bundle `markdown-it@14.1.1` or newer, which includes the upstream fix.

Do not install or redistribute Codex History Viewer v1.2.1 or earlier from local VSIX files, because those historical packages may bundle `markdown-it@14.1.0`. If you installed an older VSIX manually, upgrade to v1.2.2 or later.

### linkify-it GHSA-v245-v573-v5vm / CVE-2026-59887

The browser distribution used through Codex History Viewer v2.7.x was based on `markdown-it@14.1.1` and contained `linkify-it` mail-address detection code from before the upstream `5.0.2` fix. Repeated `mailto:` prefixes can cause quadratic CPU usage while linkifying untrusted Markdown text.

Codex History Viewer v2.8.0 updates the distributed browser implementation to `markdown-it@14.3.0` with `linkify-it@5.0.2`. It also keeps defense-in-depth initialization: Markdown auto-linking starts in a fail-closed state, both fuzzy email detection and the `mailto:` auto-detection schema are disabled, and only then is ordinary URL linkification enabled. Explicit Markdown mail links such as `[mail](mailto:user@example.com)` and `<user@example.com>` remain available.

Upgrade older installations to v2.8.0 or later. Do not open untrusted or unusually large history files in versions that do not include this mitigation.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through the GitHub repository's security reporting feature when available. If private reporting is unavailable, open a GitHub issue with a minimal description and avoid posting exploit details, secrets, tokens, personal data, or other sensitive information publicly.

When reporting a vulnerability, include:

- The affected extension version.
- The operating system and VS Code version.
- Reproduction steps using non-sensitive sample data.
- The expected and actual behavior.
- Any relevant dependency or VSIX version information.

Security-related fixes should avoid logging secrets, credentials, tokens, local file contents, or personally identifiable information.
