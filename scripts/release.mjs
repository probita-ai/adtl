#!/usr/bin/env node
// Release helpers for the GitHub release workflow.
//
//   node scripts/release.mjs check v0.3.1   # tag, package versions, pins, VERSION constants, CHANGELOG agree
//   node scripts/release.mjs notes v0.3.1   # print that version's CHANGELOG section

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(new URL(p, `file://${root}/`), "utf8");
const PACKAGES = ["labels", "interceptors", "gateway"];
const CONSTANTS = {
  "packages/interceptors/src/adtlInterceptors.ts": /export const VERSION = "([^"]+)"/,
  "packages/gateway/src/gateway.ts": /export const GATEWAY_VERSION = "([^"]+)"/,
};

const [cmd, tag] = process.argv.slice(2);
if (!["check", "notes"].includes(cmd) || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
  console.error("Usage: node scripts/release.mjs check|notes v<major>.<minor>.<patch>[-pre]");
  process.exit(2);
}
const version = tag.slice(1);

function changelogSection() {
  const lines = read("CHANGELOG.md").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

if (cmd === "notes") {
  const notes = changelogSection();
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  console.log(notes);
  process.exit(0);
}

const problems = [];
for (const p of PACKAGES) {
  const pkg = JSON.parse(read(`packages/${p}/package.json`));
  if (pkg.version !== version) problems.push(`${pkg.name} is ${pkg.version}, tag is ${version}`);
  for (const [dep, v] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith("@adtl/") && v !== version) problems.push(`${pkg.name} depends on ${dep}@${v}, expected exactly ${version}`);
  }
}
for (const [file, re] of Object.entries(CONSTANTS)) {
  const v = re.exec(read(file))?.[1];
  if (v !== version) problems.push(`${file} says ${v}, tag is ${version}`);
}
if (!changelogSection()) problems.push(`CHANGELOG.md has no "## ${version}" section`);

if (problems.length) {
  console.error(`Release ${tag} is not consistent:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Release ${tag}: versions, pins, constants and CHANGELOG agree`);
