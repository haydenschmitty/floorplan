// Which coding agent is running the skill: Claude Code, Codex, OpenCode or GitHub Copilot (VS Code).
// The map records it, so its Ask bar and "Fix with …" prompts name the right one, and serve.mjs answers
// through the same CLI when there is one (Claude Code and Codex; maps built by the others answer through those).
// --agent <name> (or FLOORPLAN_AGENT) decides; otherwise each agent is recognised by the variables it sets
// for every command it runs, and anything else is taken to be Claude Code. Adding an agent is an entry here.
const DETECT = {
  claude: () => false, // the default
  codex: (env) => !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID),
  // OPENCODE_CLIENT is documented (https://opencode.ai/docs/cli/#environment-variables) and set by the
  // desktop app and `opencode acp`; the CLI sets OPENCODE=1 for every command instead.
  opencode: (env) => !!(env.OPENCODE_CLIENT || env.OPENCODE === '1'),
  copilot: () => false, // sets no variable of its own: only chosen with --agent copilot
};
export const AGENTS = Object.keys(DETECT);

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  return AGENTS.find((a) => DETECT[a](env)) || 'claude';
}
