# Asking questions through ACP agents

The map's Ask bar and "Request a new flow" run on your own agent's sign-in. Besides the Claude Code CLI and Codex, the map's server can answer through an agent that speaks [ACP](https://agentclientprotocol.com), the Agent Client Protocol. Gemini CLI, OpenCode and Devin speak it directly. Claude Code and Codex speak it through a small adapter.

Change, the switch that edits a blueprint from the map, stays off. That needs an answer in one fixed shape, and these agents don't provide one.

## Start one

```bash
node floorplan/serve.mjs --engine acp --acp gemini
```

`--acp` takes a **known name**, an agent you already set up in Zed, or a command you type yourself:

- **By name.** `gemini`, `opencode`, `devin`, `claude-code-acp`, `claude-agent-acp` and `codex-acp`. The server finds that program on your PATH. `FLOORPLAN_ACP_<NAME>` can point at a copy installed somewhere else (set it empty to skip one).
- **From Zed.** Agents in `agent_servers` in Zed's settings (`~/.config/zed/settings.json`, or the settings file Zed uses on your system) are available as `--acp zed:<name>`. The server runs the command Zed already has, including its arguments and environment.
- **Auto-detect.** With `--engine acp` and no `--acp`, the server uses the first known agent it finds, then one from Zed, and says so when it starts. If it finds more than one, it names the others.
- **A command you type.** `--acp 'some-agent --acp'` runs that command. This is only read from the command that starts the server (or `FLOORPLAN_ACP` in that same place). The map page cannot choose a command, and a command saved in `~/.floorplan/settings.json` is ignored.

## Pick one from the map

Click the agent name on the Ask bar. The menu lists Claude Code and Codex when they are installed, then a divider, then the ACP agents the server can find: Gemini, OpenCode, Devin, `claude-code-acp`, `claude-agent-acp`, `codex-acp`, and any Zed agent as `zed:<name>`.

Choosing one switches the agent for every open tab. The star remembers that choice for next time, in `~/.floorplan/settings.json`: the engine (`claude`, `codex`, or `acp`) and, for ACP, a known name or `zed:<name>`. The file's other contents, including the Cloud waitlist answer, stay as they are. A command is never written there.

A `--engine` or `--acp` flag on the command that started the server is used instead of that memory when the server starts. You can still switch from the menu for the rest of that run; starting the server again follows the flag.

Change stays hidden while an ACP agent is answering, and comes back when you switch to Claude Code or Codex.

`open.mjs --acp …` passes the same value through when it starts the server. `--model` is passed only to Devin, which accepts it.

## How read-only it is

Claude Code and Codex are read-only because their own CLIs enforce it. An ACP agent is read-only only as far as **that agent** enforces it. For each known agent the server turns on the read-only mode that agent already has:

| Agent | What the server turns on |
|---|---|
| Gemini | `--approval-mode=plan`, and the session's Plan mode when Gemini offers it. Plan mode is Gemini's read-only mode. It can still write a plan file in Gemini's own plans folder. |
| OpenCode | the session's Plan agent, when OpenCode offers it. Plan refuses edits to project files. Shell commands still follow OpenCode's own permissions. |
| Devin | the session's Plan mode, when Devin offers it. That profile's tools are read-only. |
| Claude Code adapter (`claude-code-acp`, `claude-agent-acp`) | the session's Plan permission mode, when the adapter offers it. |
| Codex adapter (`codex-acp`) | `INITIAL_AGENT_MODE=read-only`, and the session's read-only mode when the adapter offers it. |

The server also refuses, on the ACP connection itself, to write a file or to run any terminal command other than `node floorplan/query.mjs …`. It does not trust a tool's own label, including a label of "read" or "fetch".

That client-side refusal is not a sandbox. An agent that runs its own file and shell tools, instead of asking the server, can go past it. A command you pass with `--acp '<command>'`, and an agent that comes from Zed, are started the way you configured them: the server does not invent a read-only flag for a program it doesn't know. If that agent has a read-only mode, use it in the command you type.

## Sign-in

The server uses the sign-in the agent already has. It does not try each sign-in method the agent advertises. If the agent isn't signed in, the question fails and the map names the methods the agent offered and how to sign in (for Gemini, run `gemini` once; for Devin, `devin auth login`).

Everything else — the map, Health, screens, recent work — is unchanged.
