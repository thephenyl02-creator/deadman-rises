'use strict';
/*
 * Sandboxed tests for deathwatch.js — the opt-in gate, staleness guard,
 * threshold, and debounce. HOME/USERPROFILE point at a scratch dir so the real
 * ~/.claude/deadman state is never touched.
 *
 * The contract under test: Death Watch injects its AUTO-EQUIP trigger ONLY when
 * ALL of these hold — fresh usage.json, 5h ≥ threshold, a Grave that opted in
 * (session matches, not rested), and the window not already armed. Every other
 * combination must produce NO output (exit 0, empty stdout).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL:', name); } }

const DW = path.join(__dirname, 'deathwatch.js');
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DIR = path.join(HOME, '.claude', 'deadman');
fs.mkdirSync(DIR, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const RESETS = NOW + 5400;
const SESS = 'sess-live-1';

function seed(opts) {
  const o = opts || {};
  // usage.json
  if (o.usage === null) { try { fs.unlinkSync(path.join(DIR, 'usage.json')); } catch (e) {} }
  else {
    fs.writeFileSync(path.join(DIR, 'usage.json'), JSON.stringify(Object.assign({
      five_hour: { used_percentage: 85, resets_at: RESETS },
      session: { session_id: SESS, cwd: 'C:/x', project_key: 'C--x' },
      updated_at: NOW,
    }, o.usage || {})));
  }
  // grave.json
  if (o.grave === null) { try { fs.unlinkSync(path.join(DIR, 'grave.json')); } catch (e) {} }
  else if (o.grave !== undefined) {
    fs.writeFileSync(path.join(DIR, 'grave.json'), JSON.stringify(o.grave));
  }
  // armed.json
  if (o.armed === null || o.armed === undefined) { try { fs.unlinkSync(path.join(DIR, 'armed.json')); } catch (e) {} }
  else fs.writeFileSync(path.join(DIR, 'armed.json'), JSON.stringify(o.armed));
}

function run() {
  const r = spawnSync(process.execPath, [DW], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESS }),
    env: process.env, encoding: 'utf8',
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

const OPTED_IN = { version: 1, session_id: SESS, generation: 1, mode: 'once', endless: false, watch: true, rises: [], seal: { owner: null, claimed_at: null } };

// 1. Everything right → EMITS the trigger
seed({ grave: OPTED_IN });
let r = run();
check('opted-in + fresh + 85% + unarmed -> emits', r.out.includes('DEATH WATCH AUTO-EQUIP TRIGGER'));
check('emit echoes hookEventName', r.out.includes('"hookEventName":"UserPromptSubmit"'));
check('emit names the exact reset epoch', r.out.includes(String(RESETS)));

// 2. No grave (nobody opted in) → silent
seed({ grave: null });
check('no grave -> silent', run().out === '');

// 3. Grave from a DIFFERENT conversation → silent
seed({ grave: Object.assign({}, OPTED_IN, { session_id: 'sess-other' }) });
check('different conversation -> silent', run().out === '');

// 4. Rested grave (opt-in ended) → silent
seed({ grave: Object.assign({}, OPTED_IN, { seal: { owner: 'rest@gen1', claimed_at: NOW } }) });
check('rested -> silent', run().out === '');

// 5. Grave with no session_id → silent (cannot prove same conversation)
seed({ grave: Object.assign({}, OPTED_IN, { session_id: null }) });
check('grave without session_id -> silent', run().out === '');

// 6. STALE usage.json (11 min old) → silent even though everything else is right
seed({ grave: OPTED_IN, usage: { updated_at: NOW - 660 } });
check('stale usage -> silent', run().out === '');

// 7. usage.json missing updated_at entirely → silent
seed({ grave: OPTED_IN, usage: { updated_at: undefined } });
// JSON.stringify drops undefined → field absent
check('usage without updated_at -> silent', run().out === '');

// 8. Below threshold → silent
seed({ grave: OPTED_IN, usage: { five_hour: { used_percentage: 72, resets_at: RESETS } } });
check('below threshold -> silent', run().out === '');

// 9. Already armed for this window (debounce) → silent
seed({ grave: OPTED_IN, armed: { armed_for_resets_at: RESETS, armed_at: NOW, mode: 'once' } });
check('debounced (same window) -> silent', run().out === '');

// 10. Armed for a DIFFERENT (rolled) window → emits again
seed({ grave: OPTED_IN, armed: { armed_for_resets_at: RESETS - 18000, armed_at: NOW - 18000, mode: 'once' } });
check('window rolled -> emits again', run().out.includes('DEATH WATCH AUTO-EQUIP TRIGGER'));

// 11. Watching shim (null key) never debounces itself → emits
seed({ grave: OPTED_IN, armed: { armed_for_resets_at: null, armed_at: NOW, mode: 'watch' } });
check('watch shim (null key) -> emits', run().out.includes('DEATH WATCH AUTO-EQUIP TRIGGER'));

// 12. No usage.json at all → silent
seed({ grave: OPTED_IN, usage: null });
check('no usage.json -> silent', run().out === '');

// 13. usage session block missing → STILL EMITS (identity comes from the EVENT
// payload, never from usage.json — the gate must not depend on the racy file)
seed({ grave: OPTED_IN, usage: { session: undefined } });
check('usage without session block -> emits (event is authoritative)', run().out.includes('DEATH WATCH AUTO-EQUIP TRIGGER'));

// 14. THE LEAK CASE: usage.json names the opted-in conversation (stale writer
// from another terminal) but THIS event is a different conversation → silent.
seed({ grave: OPTED_IN }); // usage.session.session_id === SESS === grave.session_id
{
  const r14 = spawnSync(process.execPath, [DW], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'conv-B-not-opted' }),
    env: process.env, encoding: 'utf8',
  });
  check('event from non-opted conversation -> silent (no leak via usage.json)', (r14.stdout || '').trim() === '');
}

// 15. Event with NO session_id → fail closed (consent cannot be proven)
seed({ grave: OPTED_IN });
{
  const r15 = spawnSync(process.execPath, [DW], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    env: process.env, encoding: 'utf8',
  });
  check('event without session_id -> silent (fail closed)', (r15.stdout || '').trim() === '');
}

// 16. Telemetry without resets_at → silent (nothing to arm for; null never debounces)
seed({ grave: OPTED_IN, usage: { five_hour: { used_percentage: 90 } } });
check('no resets_at -> silent', run().out === '');

// 17. Every invocation stamps session.json with the EVENT's identity
seed({ grave: OPTED_IN });
run();
{
  const stamp = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'));
  check('session.json stamped with event session_id', stamp.session_id === SESS && Number.isInteger(stamp.updated_at));
}

// 18. The trigger embeds --session <event id> so init records identity race-free
seed({ grave: OPTED_IN });
check('trigger embeds --session', run().out.includes(`--session ${SESS}`));

// cleanup
for (const f of ['usage.json', 'grave.json', 'armed.json', 'session.json']) {
  try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {}
}

console.log(`\ndeathwatch.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
