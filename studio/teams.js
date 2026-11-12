// Single source of truth for "which team does an agent belong to" (engine pause check + supervisor).
// Roster `team` wins (any string, so custom teams work); otherwise the built-in fallback; default 'eng'.
const TEAMS = ['eng', 'rd', 'creative'];
const TEAM_FALLBACK = {
  'rd-manager': 'rd', 'market-researcher': 'rd', 'opportunity-analyst': 'rd',
  'creative-director': 'creative', 'image-artist': 'creative',
  'video-producer': 'creative', 'copy-voice': 'creative', 'ui-ux-designer': 'creative',
};

function teamOf(agent, roster) {
  const t = roster && roster.agents && roster.agents[agent] && roster.agents[agent].team;
  return (typeof t === 'string' && t) || TEAM_FALLBACK[agent] || 'eng';
}

/** True when the global switch or (given control.teams) the team is paused. Team check only. */
function teamPaused(team, control) {
  return !!(control && control.teams && control.teams[team] === 'paused');
}

module.exports = { TEAMS, TEAM_FALLBACK, teamOf, teamPaused };
