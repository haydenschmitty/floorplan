# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue.

Helpful details:
- what the problem is, and what someone could do with it;
- the steps to reproduce it;
- which version of Floorplan you're on (see `.claude-plugin/plugin.json`).

You'll get a reply within a few days. Once a fix is out, you'll be credited unless you'd rather not be.

## What the plugin can do

[Is it safe to install?](docs/is-it-safe.md) lists everything Floorplan does on your computer: its one outbound request, every program it runs, and what it never does. [`tests/supply-chain.test.mjs`](tests/supply-chain.test.mjs) enforces that on every push and pull request, and each release's `CHECKSUMS.txt` lets you confirm an installed copy matches it (`node tools/checksums.mjs --check <folder>`).

## Scope

In scope:
- the map's local server (`serve.mjs`);
- anything that could leak secrets or source code;
- anything that writes outside the project's `floorplan/` folder and `CLAUDE.local.md`.

Out of scope: issues in Claude Code itself, which go to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy), in Codex itself, which go to [OpenAI](https://help.openai.com/en/articles/6653653-how-to-report-security-vulnerabilities-to-openai), and in Cursor itself, which go to [Cursor](https://cursor.com/security).

## Supported versions

Only the latest release gets security fixes.
