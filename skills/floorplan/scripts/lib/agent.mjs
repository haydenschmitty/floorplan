// Which coding agent is running the skill: Claude Code, Codex or Cursor. The map records it, so its Ask bar and
// "Fix with …" prompts name the right one, and serve.mjs answers through the same CLI.
// --agent <name> (or FLOORPLAN_AGENT) decides; otherwise each agent is recognised by the variables it sets
// for every command it runs, and anything else is taken to be Claude Code. Adding an agent is an entry here.
const DETECT = {
  claude: () => false, // the default
  codex: (env) => !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID),
  // Claude Code started from a Cursor terminal inherits Cursor's variable, so Claude Code's own marker wins
  cursor: (env) => !!env.CURSOR_AGENT && !env.CLAUDECODE,
};
export const AGENTS = Object.keys(DETECT);

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  return AGENTS.find((a) => DETECT[a](env)) || 'claude';
}
