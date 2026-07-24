#!/usr/bin/env node
/*
 * deadman / Death Watch — hook that auto-arms Deadman at the usage threshold.
 *
 * Wired to UserPromptSubmit (once per user turn) and PostToolUse (mid-turn
 * coverage for long autonomous runs). On each firing it reads usage.json
 * (written by statusline.js — the only reader of live rate_limits) and, when
 * the 5h window has crossed the threshold AND Deadman is not already armed for
 * this window, injects a self-contained DEATH WATCH instruction into context
 * via hookSpecificOutput.additionalContext. The main-loop model then arms the
 * existing First/Second Rise echelon (see the AUTO-EQUIP section of SKILL.md).
 *
 * Debounce: the model writes armed.json {armed_for_resets_at: <epoch>} after
 * arming (or on manual /deadman, or on disarm/rest — suppressing this window).
 * This hook stays silent while armed.armed_for_resets_at === the current
 * five_hour.resets_at, and re-activates automatically when the window rolls.
 *
 * It must NEVER break a turn: any error → exit 0 with no output.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(require('os').homedir(), '.claude', 'deadman');
const USAGE = path.join(DIR, 'usage.json');
const ARMED = path.join(DIR, 'armed.json');
const THRESHOLD = 80;      // Last Breath threshold (% of 5h window)
const WINDOW = 'five_hour'; // Death Watch tracks the 5-hour window only

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

try {
  let event = {};
  try { event = JSON.parse(readStdin() || '{}'); } catch (e) { event = {}; }
  const eventName = event.hook_event_name || event.hookEventName || 'UserPromptSubmit';

  const usage = readJson(USAGE);
  const win = usage && usage[WINDOW];
  if (!win || win.used_percentage == null) process.exit(0); // no telemetry (e.g. API-key session) → stay silent

  const pct = win.used_percentage;
  const resetsAt = win.resets_at;
  if (pct < THRESHOLD) process.exit(0);

  const armed = readJson(ARMED);
  if (armed && armed.armed_for_resets_at === resetsAt) process.exit(0); // already handled this window

  let resetHuman = 'the next reset';
  if (resetsAt) { try { resetHuman = new Date(resetsAt * 1000).toLocaleString(); } catch (e) {} }

  const msg =
    `DEATH WATCH AUTO-EQUIP TRIGGER (deadman skill). ` +
    `The 5-hour usage window is at ${pct.toFixed(0)}% (auto-arm threshold ${THRESHOLD}%); it resets at ${resetHuman} (epoch ${resetsAt}). ` +
    `Per the deadman skill's AUTO-EQUIP protocol, act on this NOW, then continue with the user's request:\n` +
    `1. Silently arm Deadman for THIS window: invoke the deadman skill (Skill "deadman", args "at ${resetHuman}") so First Rise is scheduled at the exact reset time and Second Rise +10 minutes. Preserve whatever mode is already active (once / loop / soul). Do NOT ask for confirmation — arming is cheap and reversible (disarm = CronDelete).\n` +
    `2. If CronList already shows Deadman jobs covering this window, do not double-arm.\n` +
    `3. Record the debounce flag: write ${ARMED} as {"armed_for_resets_at": ${resetsAt}, "armed_at": <current epoch seconds>, "trigger": "deathwatch", "used_percentage": ${pct.toFixed(1)}} so Death Watch stops re-firing until the window rolls over.\n` +
    `4. Tell the user exactly ONE line: "Death Watch: 5h usage ${pct.toFixed(0)}% — armed First/Second Rise for the reset at ${resetHuman}." Then resume their request normally.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: msg },
  }));
} catch (e) {
  process.exit(0); // never break the turn
}
