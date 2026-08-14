#!/usr/bin/env node
/**
 * The pre-publish content gate. What ships is what was meant to ship: source, licence,
 * readme, manifest. A tarball is opened once — here — rather than discovered by a user.
 *
 * Run at every publish. A file that is neither expected nor explicitly allowed fails the
 * gate, because "it was probably fine" is how a store path, a scratch file, or a key ends
 * up on a registry.
 */
import { execFileSync } from "node:child_process";

const ALLOWED_PREFIXES = ["src/"];
const ALLOWED_EXACT = new Set(["package.json", "README.md", "LICENSE"]);
const FORBIDDEN = [/(^|\/)\.env/, /(^|\/)\.pi\//, /(^|\/)memento\//, /\.tmp-test\//, /(^|\/)test\//, /node_modules\//];

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const files = (packed[0]?.files ?? []).map((f) => f.path);

if (files.length === 0) {
  console.error("tarball gate: npm pack reported no files at all");
  process.exit(1);
}

const problems = [];
for (const file of files) {
  if (FORBIDDEN.some((rx) => rx.test(file))) problems.push(`must never ship: ${file}`);
  else if (!ALLOWED_EXACT.has(file) && !ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
    problems.push(`unexpected: ${file}`);
  }
}
for (const required of ["package.json", "LICENSE", "README.md"]) {
  if (!files.includes(required)) problems.push(`missing: ${required}`);
}
if (!files.some((f) => f.startsWith("src/") && f.endsWith(".ts"))) {
  problems.push("missing: the extension source — Pi packages ship TypeScript, not a build");
}

if (problems.length > 0) {
  console.error(`tarball gate: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.error(`\nwhat npm packed:\n${files.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}

console.log(`tarball gate: ${files.length} files, all expected\n${files.map((f) => `  ${f}`).join("\n")}`);
