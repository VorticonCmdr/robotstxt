// Extracts the Allow/Disallow paths that apply to a given user-agent so they
// can be translated into declarativeNetRequest rules.
//
// The authoritative allow/deny *decision* is made by RobotsMatcher
// (oneAgentAllowedByRobots) in the observational logger. DNR, however, needs a
// declarative rule list ahead of time, and the matcher does not expose one — so
// we reuse the library's own line parser (parseRobotsTxt + RobotsParseHandler)
// to enumerate the directives, then pick the group for the active agent using
// Google's rules (a specific-agent group beats the `*` group entirely).

import { parseRobotsTxt, RobotsParseHandler, maybeEscapePattern } from 'google-robotstxt-parser';

class GroupHandler extends RobotsParseHandler {
  constructor() {
    super();
    this.rulesByAgent = {}; // agent(lowercased) -> { allow: [], disallow: [] }
    this.currentAgents = [];
    this.sawRuleInGroup = false;
  }

  groupFor(agent) {
    if (!this.rulesByAgent[agent]) this.rulesByAgent[agent] = { allow: [], disallow: [] };
    return this.rulesByAgent[agent];
  }

  handleUserAgent(lineNum, value) {
    // A user-agent line after a rule line starts a new group.
    if (this.sawRuleInGroup) {
      this.currentAgents = [];
      this.sawRuleInGroup = false;
    }
    const agent = value.toLowerCase();
    this.currentAgents.push(agent);
    this.groupFor(agent);
  }

  handleAllow(lineNum, value) {
    this.sawRuleInGroup = true;
    if (!value) return;
    for (const agent of this.currentAgents) this.groupFor(agent).allow.push(value);
  }

  handleDisallow(lineNum, value) {
    this.sawRuleInGroup = true;
    if (!value) return; // empty Disallow means "allow all" — no rule to emit
    for (const agent of this.currentAgents) this.groupFor(agent).disallow.push(value);
  }
}

// Same as GroupHandler but stores line numbers alongside each path.
class LineAwareGroupHandler extends RobotsParseHandler {
  constructor() {
    super();
    this.rulesByAgent = {}; // agent -> { allow: [{path, line}], disallow: [{path, line}] }
    this.currentAgents = [];
    this.sawRuleInGroup = false;
  }

  groupFor(agent) {
    if (!this.rulesByAgent[agent]) this.rulesByAgent[agent] = { allow: [], disallow: [] };
    return this.rulesByAgent[agent];
  }

  handleUserAgent(lineNum, value) {
    if (this.sawRuleInGroup) { this.currentAgents = []; this.sawRuleInGroup = false; }
    const agent = value.toLowerCase();
    this.currentAgents.push(agent);
    this.groupFor(agent);
  }

  handleAllow(lineNum, value) {
    this.sawRuleInGroup = true;
    if (!value) return;
    for (const agent of this.currentAgents) this.groupFor(agent).allow.push({ path: value, line: lineNum });
  }

  handleDisallow(lineNum, value) {
    this.sawRuleInGroup = true;
    if (!value) return;
    for (const agent of this.currentAgents) this.groupFor(agent).disallow.push({ path: value, line: lineNum });
  }
}

// Minimal robots.txt path-matching (subset used by findMatchingLine).
function pathMatches(pattern, urlPathAndQuery) {
  const hasEnd = pattern.endsWith('$');
  const p = hasEnd ? pattern.slice(0, -1) : pattern;
  const parts = p.split('*');
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      if (!urlPathAndQuery.startsWith(parts[0])) return false;
      pos = parts[0].length;
    } else {
      const idx = urlPathAndQuery.indexOf(parts[i], pos);
      if (idx === -1) return false;
      pos = idx + parts[i].length;
    }
  }
  return !hasEnd || pos === urlPathAndQuery.length;
}

// Returns the line number in robotsText of the Disallow rule that blocked
// urlString, or null if it cannot be determined.
export function findMatchingLine(robotsText, preferredAgent, urlString) {
  let urlPathAndQuery;
  try {
    const u = new URL(urlString);
    urlPathAndQuery = u.pathname + u.search;
  } catch { return null; }

  const handler = new LineAwareGroupHandler();
  try { parseRobotsTxt(robotsText || '', handler); } catch { return null; }
  const group = selectGroup(handler.rulesByAgent, preferredAgent);
  if (!group) return null;

  // Highest-priority (longest) matching Disallow rule wins.
  let bestLine = null;
  let bestLen = -1;
  for (const { path, line } of group.disallow) {
    const canon = maybeEscapePattern(path);
    const len = canon.replace(/\$$/, '').length;
    if (pathMatches(canon, urlPathAndQuery) && len > bestLen) {
      bestLen = len;
      bestLine = line;
    }
  }
  return bestLine;
}

// Picks the rule group for `preferredAgent`, matching Google's precedence:
// exact agent match, else the longest agent token that is a prefix of the
// preferred agent, else the `*` group.
function selectGroup(rulesByAgent, preferredAgent) {
  const preferred = (preferredAgent || '*').toLowerCase();

  if (preferred !== '*' && rulesByAgent[preferred]) return rulesByAgent[preferred];

  if (preferred !== '*') {
    let best = null;
    let bestLen = 0;
    for (const agent of Object.keys(rulesByAgent)) {
      if (agent === '*') continue;
      if (preferred.startsWith(agent) && agent.length > bestLen) {
        best = rulesByAgent[agent];
        bestLen = agent.length;
      }
    }
    if (best) return best;
  }

  return rulesByAgent['*'] || null;
}

// Returns { allow: string[], disallow: string[] } of canonicalised path
// patterns for the active agent, or empty arrays if no group applies.
export function extractRules(robotsText, preferredAgent) {
  const handler = new GroupHandler();
  try {
    parseRobotsTxt(robotsText || '', handler);
  } catch (e) {
    return { allow: [], disallow: [] };
  }

  const group = selectGroup(handler.rulesByAgent, preferredAgent);
  if (!group) return { allow: [], disallow: [] };

  // Canonicalise patterns the same way the matcher does (percent-encode
  // non-ASCII) so DNR rules line up with the library's verdict.
  const canon = (patterns) => patterns.map((p) => maybeEscapePattern(p));
  return { allow: canon(group.allow), disallow: canon(group.disallow) };
}
