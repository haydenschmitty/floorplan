// Which coding agent is running the skill: Claude Code, Codex, OpenCode or GitHub Copilot (VS Code).
// The map records it, so its Ask bar and "Fix with …" prompts name the right one, and serve.mjs answers
// through the same CLI when there is one (Claude Code and Codex; the others fall back to those).
// --agent (or FLOORPLAN_AGENT) decides; otherwise Codex and OpenCode are recognised by the variables
// they set for every command they run, and anything else is taken to be Claude Code. Copilot sets no
// such variable, so it is only chosen with --agent copilot.
export const AGENTS = ['claude', 'codex', 'opencode', 'copilot'];

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.OPENCODE_CLIENT) return 'opencode';
  return 'claude';
}
