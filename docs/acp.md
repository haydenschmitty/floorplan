# Asking questions through ACP agents

The map's Ask bar and "Request a new flow" run on your own agent's sign-in. Besides the Claude Code CLI and Codex, the map's server can use **any agent that speaks [ACP](https://agentclientprotocol.com)** — the Agent Client Protocol editors like Zed use to talk to coding agents. [Gemini CLI](https://geminicli.com) is the best-known example; Claude Code and Codex also have ACP adapters.

## How it works

```bash
node floorplan/serve.mjs --engine acp --acp gemini
```

`--acp` takes either a **known agent's name** or a full command line:

- **By name.** The server knows how to launch `gemini` (`gemini --acp`), `opencode` (`opencode acp`), `devin` (`devin acp`), and the `claude-code-acp` and `codex-acp` adapters, and finds them on your PATH. `--acp opencode` picks one.
- **Auto-detect.** With no `--acp`, it uses the first known agent it finds on PATH (or in your Zed config) and says so at startup (`asking via OpenCode (ACP) …`, plus "other ACP agents found: … — pass --acp <name> to use one instead").
- **A command line** for anything else: `--acp 'gemini --acp'`, `--acp 'npx some-adapter'`, `--acp '/path/to/agent --acp'`. Quotes inside the command are honoured, and a `.js`/`.mjs` file runs under the same Node as the server.

Agents you've configured in **Zed** are detected too: `agent_servers` entries in `~/.config/zed/settings.json` (command, args and env) show up in the picker as "name (from Zed)" and can be picked with `--acp 'zed:<name>'`. Detection re-reads the file and PATH every time the picker opens, so newly installed or newly configured agents just appear.

Each question spawns the agent in your project folder, on your own sign-in. Answers, follow-up questions and new flows work the same as with the Claude Code or Codex engines. `FLOORPLAN_ACP` works instead of `--acp`, `FLOORPLAN_ACP_<NAME>` overrides where a known agent is found (set it empty to skip one), and `open.mjs --acp …` passes it through when starting the server.

## Switching agent or model from the map

Click the engine pill in the Ask bar (the one that names the current agent) to open the picker: every agent the server can find is listed — installed plugins first, a divider, then the ACP agents — with the one in use and your default marked. Picking one switches it live, for every open tab, and makes it your default: the choice is remembered in `~/.floorplan/settings.json` for next time (a `--engine`/`--acp` flag always wins). Model stays a flag (`--model`/`FLOORPLAN_MODEL`, passed through to agents that take it, currently `devin`).

## What's different from Claude Code and Codex

- **Read-only is best-effort, not a sandbox.** The server confines the agent through ACP's client surface: it serves the agent's file reads (inside the codebase only), refuses writes, runs only `node floorplan/query.mjs …` commands, and auto-answers permission prompts the same way. An agent with its own file and shell tools can bypass that surface; some agents use it only when asked nicely. The Claude Code and Codex engines enforce read-only more strictly.
- **Model choice is mostly the agent's own.** `--model` is passed through to known agents that take it (currently `devin`); it's ignored for the rest.
- **Sign-in errors are the agent's own.** If a question fails because the agent isn't signed in, sign in to it the way its docs say (for Gemini, run `gemini` once), then ask again.

Everything else — the map, Health, screens, recent work — is identical, and a map made with one agent asks through any of them.
