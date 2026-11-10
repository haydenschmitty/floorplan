// Which coding agent is running the skill: Claude Code or Codex. The map records it, so its Ask bar and
// "Fix with …" prompts name the right one, and serve.mjs answers through the same CLI.
// --agent <name> (or FLOORPLAN_AGENT) decides; otherwise each agent is recognised by the variables it sets
// for every command it runs, and anything else is taken to be Claude Code. Adding an agent is an entry here.
// "none" is for maps made without an agent session (in CI, in scripts, from your own tooling): the map then
// names no agent in its prompts. Unattended mode (FLOORPLAN_UNATTENDED=1) implies it unless one is named.
import { isUnattended } from './common.mjs';

const DETECT = {
  claude: () => false, // the default
  codex: (env) => !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID),
  none: () => false, // only when asked for, or in unattended mode
};
export const AGENTS = Object.keys(DETECT);

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  if (isUnattended(env)) return 'none';
  return AGENTS.find((a) => DETECT[a](env)) || 'claude';
}
