#!/usr/bin/env node
'use strict';
/*
 * status.test.js — sandboxed tests for status.js.
 *
 * Runs in-process (not via child_process) but with HOME/USERPROFILE already
 * pointed at a scratch dir by the caller (see run-tests.js), so os.homedir()
 * used by grave.js resolves into the sandbox and the real ~/.claude/deadman
 * state is never touched.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const G = require('./grave.js');
const { render } = require('./status.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log('  ' + (e && e.stack ? e.stack : String(e)));
  }
}

// ---- Test 1: full grave + usage renders expected substrings ----
test('full grave renders expected substrings', () => {
  // Seed grave via module API directly.
  let g = G.blankGrave();
  g.session_id = 'sess-1';
  g.project = 'C:/fake/project';
  g.project_key = G.deriveProjectKey(g.project);
  g.mode = 'loop';
  g.endless = true;
  g.generation = 3;
  g.resurrection_time = G.nowSec() + 3661; // ~1h01m out
  g.background = 'running';
  g.souls = { paid: true, protected: false };
  G.writeGrave(g);

  g = G.readGrave();
  G.setPath(g, 'rises', []);
  G.writeGrave(g);
  // use addrise-equivalent
  g = G.readGrave();
  g.rises.push({ role: 'echelon', cron_id: 'cron-abc', fire_time: G.nowSec() + 600, status: 'pending' });
  g.rises.push({ role: 'exact', cron_id: 'cron-xyz', fire_time: G.nowSec() + 3661, status: 'pending' });
  g.last_failure = { type: 'session_limit', reason: 'usage cap hit', epoch: G.nowSec() - 120 };
  g.last_recovery_result = { generation: 2, result: 'resumed', detail: 'resumed ok', epoch: G.nowSec() - 300 };
  G.writeGrave(g);

  const usage = {
    five_hour: { used_percentage: 82, resets_at: g.resurrection_time },
    seven_day: { used_percentage: 45, resets_at: G.nowSec() + 86400 },
    session: { session_id: 'sess-1', cwd: g.project, project_key: g.project_key },
    updated_at: G.nowSec(),
  };
  G.atomicWrite(G.USAGE, usage);

  const grave = G.readGrave();
  const u = G.readJson(G.USAGE);
  const output = render(grave, u);

  assert(output.includes('generation 3'), 'should include generation number');
  assert(output.includes('Life:'), 'should include Life: line');
  assert(output.includes('Resurrection Time:'), 'should include Resurrection Time: line');
  assert(output.includes('Echelon Rise:'), 'should include echelon rise role (capitalized)');
  assert(output.includes('Exact Rise:'), 'should include exact rise role (capitalized)');
  assert(output.includes('cron-abc'), 'should include cron_id for echelon rise');
  assert(output.includes('cron-xyz'), 'should include cron_id for exact rise');
  assert(output.includes('session_limit'), 'should include last_failure type');
  assert(output.includes('resumed'), 'should include last_recovery_result result');
  assert(output.includes('Endless Rise: on'), 'should show endless on');
  assert(output.includes('Mode: loop'), 'should show mode');
  assert(output.includes('Souls: paid'), 'should show souls paid');
});

// ---- Test 2: no-grave case ----
test('no grave prints not-armed line', () => {
  const output = render(null, null);
  assert.strictEqual(output, 'Deadman: not armed (no Grave)');
});

// ---- Test 3: grave with missing/partial fields never throws ----
test('partial grave renders without throwing', () => {
  const g = {
    version: 1,
    generation: 1,
    rises: [{ role: 'exact' }], // missing cron_id/fire_time/status
    // no resurrection_time, no last_failure, no last_recovery_result, no souls
  };
  let output;
  assert.doesNotThrow(() => { output = render(g, null); });
  assert(output.includes('generation 1'), 'should still show generation');
  assert(output.includes('Exact Rise:'), 'should still show rise role');
  assert(output.includes('Last recovery: none'), 'should show none for missing last_recovery_result');
  assert(output.includes('Last failure:  none'), 'should show none for missing last_failure');
});

// ---- Test 4: CLI entry point produces output on stdout ----
test('CLI run produces status output via stdout', () => {
  const { execFileSync } = require('child_process');
  // Reuse the grave/usage already seeded from Test 1 (still in sandbox DIR).
  const nodeBin = process.execPath;
  const scriptPath = path.join(__dirname, 'status.js');
  const out = execFileSync(nodeBin, [scriptPath], {
    env: Object.assign({}, process.env),
    encoding: 'utf8',
  });
  assert(out.includes('DEADMAN'), 'CLI output should include DEADMAN header');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
