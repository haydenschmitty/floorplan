// Which coding agent is running the skill: Cursor, Claude Code or Codex. The map records it, so its
// "Fix with …" prompts name the right one. serve.mjs answers through a CLI only for Claude Code and Codex;
// Cursor has no read-only CLI wired up, so the map tells you to ask in the Cursor chat.
// --agent <name> (or FLOORPLAN_AGENT) decides; otherwise each agent is recognised by the variables it sets
// for every command it runs, and anything else is taken to be Claude Code. Adding an agent is an entry here.
// Cursor is checked before Codex, so a Cursor session wins if both sets of variables are present.
// "none" is for maps made without an agent session (in CI, in scripts, from your own tooling): the map then
// names no agent in its prompts. Unattended mode (FLOORPLAN_UNATTENDED=1) implies it unless one is named.
import { isUnattended } from './common.mjs';

const yes = (v) => /^(1|true|yes)$/i.test(String(v || '').trim());
const DETECT = {
  claude: () => false, // the default
  cursor: (env) => yes(env.CURSOR_AGENT) || !!env.CURSOR_CONVERSATION_ID,
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
