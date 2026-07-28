#!/usr/bin/env node
'use strict';
/*
 * deadman / diagnose — StopFailure hook that records the classified API-error
 * type into the Grave for later reading by /deadman status and a fired Rise.
 *
 * stdout is IGNORED by Claude Code: this script ONLY does a side-effecting
 * disk write. It must never throw and must always exit 0.
 *
 * Usage: node diagnose.js <type>
 *   <type> is the StopFailure matcher, e.g. rate_limit, billing_error,
 *   authentication_failed, overloaded, server_error, unknown, ...
 */

const REASON_MAP = {
  rate_limit: 'Rate limit exceeded.',
  overloaded: 'API overloaded.',
  server_error: 'Server error.',
  authentication_failed: 'Authentication failed.',
  oauth_org_not_allowed: 'OAuth organization not allowed.',
  billing_error: 'Billing error.',
  invalid_request: 'Invalid request.',
  model_not_found: 'Model not found.',
  max_output_tokens: 'Max output tokens reached.',
  unknown: 'Unknown error.',
};

function main() {
  const type = process.argv[2] || 'unknown';

  let event = {};
  try {
    const raw = require('fs').readFileSync(0, 'utf8');
    if (raw) event = JSON.parse(raw);
  } catch (e) { /* defensive: stdin may be empty/absent/malformed */ }

  let G;
  try {
    G = require('./grave.js');
  } catch (e) { return; }

  // Take the Grave lock for the whole read-modify-write. Unlocked, this hook can
  // land between a Rise's claim and its verify-read and blow away the seal that
  // Rise just wrote — losing the claim and making a legitimate sole winner
  // report LOST. Everything that mutates the Grave shares one mutex.
  //
  // This runs at turn-end, so it waits only briefly and then gives up:
  // last_failure is a hint, and losing it costs far less than stalling every
  // turn behind a busy lock — or writing unlocked and destroying a live claim.
  let recorded = false;
  G.withGraveLock(() => {
    const g = G.readGrave();
    if (!g) return; // nothing to record against

    // Session guard: never cross-contaminate another session's Grave.
    if (g.session_id && event.session_id && g.session_id !== event.session_id) return;

    // The reason is an upstream API error string we do not control, and it is
    // re-read later by a model (status output, and the Fired Rise's failure
    // triage). Sanitise on the way in — see sanitizeText in grave.js.
    const rawReason = event.message || event.reason || event.error || REASON_MAP[type] || REASON_MAP.unknown;
    const reason = G.sanitizeText(rawReason, 200);

    G.setPath(g, 'last_failure', {
      type,
      reason,
      epoch: G.nowSec(),
      source: 'diagnose',
    });
    G.writeGrave(g);
    recorded = true;
  }, { tries: 10, ifBusy: 'skip' });

  // Losing a failure record silently would leave the Fired Rise's triage
  // reasoning about a stall it has no evidence for. stdout is ignored by Claude
  // Code, so say it on stderr where it lands in the hook log.
  if (!recorded) {
    try { process.stderr.write('deadman/diagnose: grave busy, failure not recorded (' + type + ')\n'); } catch (e) {}
  }
}

try {
  main();
} catch (e) { /* never break turn-end */ }

process.exit(0);
