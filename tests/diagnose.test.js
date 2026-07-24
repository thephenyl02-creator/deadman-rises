#!/usr/bin/env node
'use strict';
/*
 * Sandboxed tests for diagnose.js.
 *
 * Runs entirely against a scratch HOME dir so the real ~/.claude/deadman
 * state is never touched. Pass the scratch dir as argv[2], or it defaults to
 * a fresh dir under the OS temp dir.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
const DIAGNOSE = path.join(__dirname, 'diagnose.js');
const GRAVE_JS = path.join(__dirname, 'grave.js');

const scratchArg = process.argv[2];
const SCRATCH = scratchArg || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-test-'));
const DEADMAN_DIR = path.join(SCRATCH, '.claude', 'deadman');
const GRAVE_PATH = path.join(DEADMAN_DIR, 'grave.json');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS: ' + msg); }
  else { failed++; console.log('FAIL: ' + msg); }
}

function sandboxEnv() {
  return Object.assign({}, process.env, { USERPROFILE: SCRATCH, HOME: SCRATCH });
}

function resetState() {
  fs.rmSync(DEADMAN_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEADMAN_DIR, { recursive: true });
}

function initGrave(sessionId) {
  const r = spawnSync(NODE, [GRAVE_JS, 'init', '--session', sessionId], {
    env: sandboxEnv(), encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('grave init failed: ' + r.stderr);
}

function readGraveFile() {
  return JSON.parse(fs.readFileSync(GRAVE_PATH, 'utf8'));
}

function runDiagnose(type, eventObj) {
  const input = eventObj != null ? JSON.stringify(eventObj) : '';
  return spawnSync(NODE, [DIAGNOSE, type], {
    env: sandboxEnv(), encoding: 'utf8', input,
  });
}

// ---- Test 1: matching session -> last_failure set, rises/seal untouched ----
(function testMatchingSession() {
  resetState();
  initGrave('sess-1');
  const before = readGraveFile();
  before.rises = [{ role: 'primary', cron_id: 'c1', fire_time: 123, status: 'pending' }];
  before.seal = { owner: 'someone@gen1', claimed_at: 456 };
  fs.writeFileSync(GRAVE_PATH, JSON.stringify(before, null, 2));

  const r = runDiagnose('rate_limit', { session_id: 'sess-1', message: 'boom' });
  assert(r.status === 0, 'matching session: exits 0');

  const after = readGraveFile();
  assert(after.last_failure && after.last_failure.type === 'rate_limit', 'matching session: last_failure.type set');
  assert(after.last_failure.reason === 'boom', 'matching session: reason taken from event.message');
  assert(after.last_failure.source === 'diagnose', 'matching session: source is diagnose');
  assert(typeof after.last_failure.epoch === 'number', 'matching session: epoch is a number');
  assert(JSON.stringify(after.rises) === JSON.stringify(before.rises), 'matching session: rises untouched');
  assert(JSON.stringify(after.seal) === JSON.stringify(before.seal), 'matching session: seal untouched');
  assert(after.generation === before.generation, 'matching session: generation untouched');
  assert(after.resurrection_time === before.resurrection_time, 'matching session: resurrection_time untouched');
})();

// ---- Test 1b: canned reason map used when event has no reason string ----
(function testCannedReason() {
  resetState();
  initGrave('sess-1');
  const r = runDiagnose('billing_error', { session_id: 'sess-1' });
  assert(r.status === 0, 'canned reason: exits 0');
  const after = readGraveFile();
  assert(after.last_failure && after.last_failure.type === 'billing_error', 'canned reason: type set');
  assert(after.last_failure.reason === 'Billing error.', 'canned reason: canned string used');
})();

// ---- Test 2: mismatched session -> last_failure unchanged ----
(function testMismatchedSession() {
  resetState();
  initGrave('sess-1');
  const before = readGraveFile();
  assert(before.last_failure == null, 'mismatched session: precondition last_failure is null');

  const r = runDiagnose('overloaded', { session_id: 'sess-OTHER', message: 'nope' });
  assert(r.status === 0, 'mismatched session: exits 0');

  const after = readGraveFile();
  assert(JSON.stringify(after.last_failure) === JSON.stringify(before.last_failure), 'mismatched session: last_failure unchanged');
  assert(after.updated_at === before.updated_at, 'mismatched session: grave not rewritten (updated_at unchanged)');
})();

// ---- Test 3: no grave present -> exit 0, no crash, no file created ----
(function testNoGrave() {
  resetState(); // deadman dir exists but empty, no grave.json
  assert(!fs.existsSync(GRAVE_PATH), 'no grave: precondition grave.json absent');

  const r = runDiagnose('unknown', { session_id: 'sess-1', message: 'whatever' });
  assert(r.status === 0, 'no grave: exits 0');
  assert(!fs.existsSync(GRAVE_PATH), 'no grave: grave.json still not created');
})();

// ---- Test 4: no grave.json AND no .claude/deadman dir at all ----
(function testNoDirAtAll() {
  fs.rmSync(DEADMAN_DIR, { recursive: true, force: true });
  const r = runDiagnose('unknown', { session_id: 'sess-1' });
  assert(r.status === 0, 'no dir at all: exits 0');
  assert(!fs.existsSync(GRAVE_PATH), 'no dir at all: grave.json not created');
})();

// ---- Test 5: malformed stdin JSON -> defensive, still exits 0 ----
(function testMalformedStdin() {
  resetState();
  initGrave('sess-1');
  const r = spawnSync(NODE, [DIAGNOSE, 'server_error'], {
    env: sandboxEnv(), encoding: 'utf8', input: 'not json{{{',
  });
  assert(r.status === 0, 'malformed stdin: exits 0');
  const after = readGraveFile();
  // event.session_id could not be parsed, so no session in event -> guard
  // condition "event has a session_id" is false -> proceeds and records.
  assert(after.last_failure && after.last_failure.type === 'server_error', 'malformed stdin: still records (no session in event to compare)');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');

// cleanup
if (!scratchArg) {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
}

process.exit(failed > 0 ? 1 : 0);
