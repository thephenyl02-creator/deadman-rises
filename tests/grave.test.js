'use strict';
/* Unit tests for grave.js. Run sandboxed: USERPROFILE/HOME point at a scratch
 * dir so the real ~/.claude/deadman state is never touched. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('./grave.js');           // DIR resolved from sandboxed home
const GRAVE_JS = path.join(__dirname, 'grave.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL:', name); } }
function cli(...args) {
  return execFileSync(process.execPath, [GRAVE_JS, ...args], { env: process.env, encoding: 'utf8' }).trim();
}

// --- setup: seed usage.json in the sandboxed DIR ---
fs.mkdirSync(G.DIR, { recursive: true });
try { fs.unlinkSync(G.GRAVE); } catch (e) {}
try { fs.unlinkSync(G.ARMED); } catch (e) {}
fs.writeFileSync(G.USAGE, JSON.stringify({
  five_hour: { used_percentage: 82, resets_at: 1900000000 },
  seven_day: { used_percentage: 40, resets_at: 1900500000 },
  session: { session_id: 'sess-abc', cwd: 'C:/Users/Fenil/proj', project_key: 'C--Users-Fenil-proj' },
}));

// 1. init once — reads resurrection_time + session from usage.json
cli('init', '--mode', 'once');
let g = G.readGrave();
check('init gen=1', g.generation === 1);
check('init mode=once', g.mode === 'once');
check('init resurrection_time from usage', g.resurrection_time === 1900000000);
check('init window_resets_at from usage', g.window_resets_at === 1900000000);
check('init session_id from usage', g.session_id === 'sess-abc');
check('init project_key derived', g.project_key === 'C--Users-Fenil-proj');
check('init souls not paid', g.souls.paid === false);

// armed.json shim written
let a = G.readJson(G.ARMED);
check('shim armed_for_resets_at', a && a.armed_for_resets_at === 1900000000);
check('shim mode=once', a && a.mode === 'once');

// 2. addrise
cli('addrise', 'first', 'cron_a', '1900000000');
cli('addrise', 'second', 'cron_b', '1900000600');
g = G.readGrave();
check('two rises', g.rises.length === 2 && g.rises[0].role === 'first' && g.rises[1].cron_id === 'cron_b');
check('rise status pending', g.rises[0].status === 'pending');

// 3. seal STALE on wrong generation
check('claim wrong gen -> STALE', cli('claim', 'foo@gen9', '9') === 'STALE');

// 4. first claims -> WON
check('first claim -> WON', cli('claim', 'first@gen1', '1') === 'WON');
check('idempotent re-claim -> WON', cli('claim', 'first@gen1', '1') === 'WON');
g = G.readGrave();
check('seal owned by first', g.seal.owner === 'first@gen1');

// 5. sibling claims while owner healthy -> LOST
check('second claim (owner healthy) -> LOST', cli('claim', 'second@gen1', '1') === 'LOST');

// 6. owner claimed then died (failure after claim) -> TAKEOVER
cli('set', 'last_failure', '{"type":"rate_limit","reason":"still limited","epoch":9999999999,"source":"diagnose"}');
check('sibling after owner death -> TAKEOVER', cli('claim', 'second@gen1', '1') === 'TAKEOVER');
g = G.readGrave();
check('seal taken over by second', g.seal.owner === 'second@gen1');

// 7. owner genuinely completed -> LOST
cli('set', 'last_recovery_result', '{"generation":1,"result":"resumed","detail":"done","epoch":1899999999}');
check('claim after completion -> LOST', cli('claim', 'third@gen1', '1') === 'LOST');

// 8. rearm -> generation++, rises + seal cleared, new reset
cli('rearm', '--reset', '1900100000');
g = G.readGrave();
check('rearm gen=2', g.generation === 2);
check('rearm rises cleared', g.rises.length === 0);
check('rearm seal cleared', g.seal.owner === null);
check('rearm new resurrection_time', g.resurrection_time === 1900100000);
check('rearm last_recovery_result rearmed', g.last_recovery_result.result === 'rearmed' && g.last_recovery_result.generation === 1);

// 9. rest -> disarm/settle
cli('addrise', 'first', 'cron_c', '1900100000');
cli('rest');
g = G.readGrave();
check('rest rises deleted', g.rises.every(r => r.status === 'deleted'));
check('rest endless off', g.endless === false);
check('rest seal owner rest@', String(g.seal.owner).startsWith('rest@'));
check('rest window_resets_at from usage (debounce suppression)', g.window_resets_at === 1900000000);
check('rest last_recovery stopped', g.last_recovery_result.result === 'stopped');
a = G.readJson(G.ARMED);
check('rest shim mode=rest', a && a.mode === 'rest');

// 10. endless init increments generation on same session
cli('clear');
cli('init', '--mode', 'loop', '--endless', 'true');
g = G.readGrave();
check('endless init gen=1', g.generation === 1 && g.endless === true);
a = G.readJson(G.ARMED);
check('endless shim mode=loop', a && a.mode === 'loop');
cli('init', '--mode', 'loop', '--endless', 'true');
g = G.readGrave();
check('endless re-init same session gen=2', g.generation === 2);

// 10b. seal TTL: fresh claim -> sibling LOST; stale claim (>STALE_TTL) -> TAKEOVER
cli('clear');
cli('init', '--mode', 'once');
cli('claim', 'first@gen1', '1');
check('fresh seal -> sibling LOST', cli('claim', 'second@gen1', '1') === 'LOST');
cli('set', 'seal', JSON.stringify({ owner: 'first@gen1', claimed_at: G.nowSec() - 2000 }));
check('stale seal (>TTL) -> sibling TAKEOVER', cli('claim', 'second@gen1', '1') === 'TAKEOVER');

// 10b2. a rested generation is never taken over, even past the TTL
cli('clear');
cli('init', '--mode', 'once');
cli('rest');
cli('set', 'seal', JSON.stringify({ owner: 'rest@gen1', claimed_at: G.nowSec() - 5000 }));
check('rested seal never taken over (respects Rest in Peace)', cli('claim', 'first@gen1', '1') === 'LOST');

// 10c. rearm clears a stale last_failure
cli('clear');
cli('init', '--mode', 'loop', '--endless', 'true');
cli('set', 'last_failure', '{"type":"rate_limit","reason":"x","epoch":123,"source":"diagnose"}');
cli('rearm', '--reset', '1900200000');
check('rearm clears last_failure', G.readGrave().last_failure === null);

// 11. atomic write leaves valid JSON
check('grave.json parseable', G.readGrave() !== null);

// cleanup
cli('clear');
try { fs.unlinkSync(G.USAGE); } catch (e) {}

console.log(`\ngrave.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
