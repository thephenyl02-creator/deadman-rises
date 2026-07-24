#!/usr/bin/env node
'use strict';
/*
 * Sandboxed test for the session-persistence extension to statusline.js.
 * Pipes a sample stdin JSON into statusline.js under a fresh HOME/USERPROFILE
 * and asserts usage.json gains a session block plus retains five_hour.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS - ' + msg); }
  else { fail++; console.log('FAIL - ' + msg); }
}

const scratchRoot = path.join(os.tmpdir(), 'deadman-statusline-test-' + process.pid + '-' + Date.now());
fs.mkdirSync(scratchRoot, { recursive: true });

const nodeExe = process.execPath;
const statuslinePath = path.join(__dirname, 'statusline.js');
const usagePath = path.join(scratchRoot, '.claude', 'deadman', 'usage.json');

const stdinObj = {
  session_id: 'sess-abc-123',
  cwd: 'C:/Users/Fenil/proj',
  model: { display_name: 'Sonnet' },
  workspace: { current_dir: 'C:/Users/Fenil/proj' },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1234567890 },
    seven_day: { used_percentage: 10, resets_at: 1234599999 },
  },
};

try {
  execFileSync(nodeExe, [statuslinePath], {
    input: JSON.stringify(stdinObj),
    env: Object.assign({}, process.env, { HOME: scratchRoot, USERPROFILE: scratchRoot }),
    encoding: 'utf8',
  });
} catch (e) {
  console.error('statusline.js invocation failed:', e && e.message);
}

let usage = null;
try { usage = JSON.parse(fs.readFileSync(usagePath, 'utf8')); } catch (e) { /* leave null */ }

ok(!!usage, 'usage.json was written');
ok(!!(usage && usage.session), 'usage.json contains a session block');
ok(!!(usage && usage.session && usage.session.session_id === 'sess-abc-123'), 'session.session_id matches stdin session_id');
ok(!!(usage && usage.session && usage.session.cwd === 'C:/Users/Fenil/proj'), 'session.cwd matches stdin cwd');
ok(!!(usage && usage.session && usage.session.project_key === 'C--Users-Fenil-proj'), 'session.project_key === "C--Users-Fenil-proj"');
ok(!!(usage && usage.five_hour && usage.five_hour.used_percentage === 42), 'five_hour is still persisted');
ok(!!(usage && usage.seven_day && usage.seven_day.used_percentage === 10), 'seven_day is still persisted');

// Cleanup sandbox
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
