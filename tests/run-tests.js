#!/usr/bin/env node
'use strict';
/*
 * Deadman Rises — packaged test runner.
 *
 * The *.test.js files were copied verbatim from the source tree, where the
 * engine scripts and their tests live side by side. Each test therefore
 * resolves the script under test as a SIBLING (require('./grave.js'),
 * path.join(__dirname, 'status.js'), ...). In this package the engine lives in
 * ../scripts/ while the tests live in ./tests/, so we reconstruct the original
 * flat sibling layout inside a throwaway temp directory and run the tests there.
 *
 * Everything runs sandboxed: HOME and USERPROFILE point at a scratch dir, so
 * grave.js's os.homedir() resolves inside the sandbox and the real
 * ~/.claude/deadman state is never touched.
 *
 * Usage: node tests/run-tests.js
 * Exit code: 0 if every test suite passes, 1 otherwise.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.join(__dirname, '..');
const SCRIPTS = path.join(PKG, 'scripts');
const TESTS = __dirname;

const NODE = process.execPath;
const TEST_FILES = [
  'grave.test.js',
  'diagnose.test.js',
  'status.test.js',
  'statusline.session.test.js',
];

function copyDirFlat(fromDir, filterExt, toDir) {
  for (const f of fs.readdirSync(fromDir)) {
    if (filterExt && !f.endsWith(filterExt)) continue;
    fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
  }
}

function main() {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'deadman-run-'));
  const sandbox = path.join(run, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });

  // Reconstruct the sibling layout: engine scripts + tests together.
  copyDirFlat(SCRIPTS, '.js', run);
  copyDirFlat(TESTS, '.test.js', run);
  // run-tests.js itself is not a *.test.js, so it is not copied — good.

  const env = Object.assign({}, process.env, { HOME: sandbox, USERPROFILE: sandbox });

  let failures = 0;
  for (const t of TEST_FILES) {
    const file = path.join(run, t);
    if (!fs.existsSync(file)) { console.log(`SKIP ${t} (not found)`); continue; }
    console.log(`\n=== ${t} ===`);
    const r = spawnSync(NODE, [file], { env, cwd: run, encoding: 'utf8', stdio: 'inherit' });
    if (r.status !== 0) { failures++; console.log(`--> ${t} FAILED (exit ${r.status})`); }
  }

  try { fs.rmSync(run, { recursive: true, force: true }); } catch (e) { /* best-effort */ }

  console.log(`\n${TEST_FILES.length - failures}/${TEST_FILES.length} suites passed.`);
  process.exit(failures ? 1 : 0);
}

main();
