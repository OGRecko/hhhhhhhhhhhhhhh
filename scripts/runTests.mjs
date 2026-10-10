/**
 * Test runner for `npm test`.
 *
 * Every suite listed here is EXECUTED as its own process. Each suite exits
 * non-zero on failure, and this runner exits non-zero if any of them did, so
 * a failing suite fails the command.
 *
 * Deliberate properties:
 *   - Nothing here counts or reports assertions itself. The totals printed at
 *     the end are the suites' own exit statuses, not a number this file made
 *     up. There is no way for this runner to print a pass count for a suite
 *     that did not run.
 *   - A suite that crashes on import (a missing export, a syntax error) exits
 *     non-zero and is reported as a failure, not skipped.
 *   - Every suite runs even if an earlier one fails, so one broken suite does
 *     not hide the state of the rest.
 *
 * Adding a test file? Add it to SUITES. A file that is not listed here does
 * not run, and an unlisted test file is the whole reason v27 could report a
 * green `npm test` while `verifySessionClaims` did not exist.
 */

import { spawnSync } from "node:child_process";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Suites are DISCOVERED, not listed. A hand-maintained list is exactly how
// v27 shipped a green `npm test` while server/authUtils.test.ts — which
// referenced a function that did not exist — was simply not in the list.
// Anything matching the patterns below runs; adding a test file is enough to
// make it run.
const TEST_PATTERNS = [/\.test\.ts$/, /\.test\.js$/, /\.spec\.ts$/, /\.spec\.js$/];
const SEARCH_ROOTS = ["server", "src", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "public"]);

/**
 * Non-test files that are nonetheless executable validation suites, kept
 * explicitly because their names do not match the patterns above.
 * roomAcoustics.validation.ts checks computeRT60 against a published worked
 * example and must not be dropped just because it is not called *.test.ts.
 */
const EXTRA_SUITES = ["src/lib/roomAcoustics.validation.ts"];

function discover(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) discover(full, found);
    else if (TEST_PATTERNS.some((re) => re.test(entry.name))) found.push(full);
  }
  return found;
}

const discovered = SEARCH_ROOTS.flatMap((root) => discover(root));
const extras = EXTRA_SUITES.filter((f) => existsSync(f));
const missingExtras = EXTRA_SUITES.filter((f) => !existsSync(f));

const SUITES = [
  // Type checking first: a type error is a failure, and running the suites
  // afterwards gives the real reason rather than a cascade of runtime errors.
  { name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] },
  ...discovered.map((file) => ({ name: file, file })),
  ...extras.map((file) => ({ name: file, file })),
  // A configured suite that has vanished is a failure, not a silent skip.
  ...missingExtras.map((file) => ({ name: file, file })),
];

console.log(`Discovered ${discovered.length} test files + ${extras.length} configured validation suites.`);
for (const f of [...discovered, ...extras]) console.log(`  \u2022 ${f}`);

const results = [];
let anyFailed = false;

for (const suite of SUITES) {
  const cmd = suite.cmd ?? "npx";
  const args = suite.args ?? ["tsx", suite.file];

  if (suite.file && !existsSync(suite.file)) {
    // A listed suite that has vanished is a failure, not a silent skip.
    console.log(`\n\u2500\u2500 ${suite.name} \u2500\u2500 MISSING`);
    results.push({ name: suite.name, status: "MISSING" });
    anyFailed = true;
    continue;
  }

  console.log(`\n\u2500\u2500 ${suite.name} \u2500\u2500`);
  const started = Date.now();
  const proc = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  const ms = Date.now() - started;

  if (proc.error) {
    console.log(`  runner could not start ${suite.name}: ${proc.error.message}`);
    results.push({ name: suite.name, status: "ERROR", ms });
    anyFailed = true;
    continue;
  }
  if (proc.status !== 0) {
    results.push({ name: suite.name, status: `FAIL (exit ${proc.status ?? `signal ${proc.signal}`})`, ms });
    anyFailed = true;
    continue;
  }
  results.push({ name: suite.name, status: "PASS", ms });
}

console.log("\n\u2550\u2550 SUITE RESULTS \u2550\u2550");
for (const r of results) {
  const time = r.ms == null ? "" : ` (${(r.ms / 1000).toFixed(1)}s)`;
  console.log(`  ${r.status.padEnd(22)} ${r.name}${time}`);
}

const failed = results.filter((r) => r.status !== "PASS");
console.log(
  `\n${results.length - failed.length}/${results.length} suites passed` +
  (failed.length ? ` \u2014 ${failed.length} FAILED` : ""),
);

process.exit(anyFailed ? 1 : 0);
