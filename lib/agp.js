import { listTools, callTool, diagnose, parseMcpConfig as parseGeneric, genericLooksLikeAction } from './mcpClient';

export { parseMcpConfig } from './mcpClient';
export const listAgpTools = listTools;
export const callAgpTool = callTool;
export const diagnoseAgp = diagnose;

// AGP's actual tools, confirmed via a live tools/list call. Hardcoded
// because keyword matching alone missed a real one (start_track commits to
// a real-money spend cap but has no matchable action word in its
// description). Anything AGP adds later falls back to the generic heuristic.
const KNOWN_ACTION_TOOLS = new Set(['start_track', 'ask', 'guess']);
const KNOWN_READ_TOOLS = new Set(['list_tracks', 'my_race', 'sigil_balance', 'track_state', 'practice_ask', 'practice_guess']);

export function looksLikeAction(tool) {
  if (KNOWN_ACTION_TOOLS.has(tool.name)) return true;
  if (KNOWN_READ_TOOLS.has(tool.name)) return false;
  return genericLooksLikeAction(tool);
}
