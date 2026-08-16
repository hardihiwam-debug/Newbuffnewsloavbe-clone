#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const p = "supabase/functions/pipeline/index.ts";
let s = readFileSync(p, "utf8");

function replaceOnce(src, oldStr, newStr, label) {
  const idx = src.indexOf(oldStr);
  if (idx < 0) throw new Error(`NOT FOUND: ${label}`);
  const count = src.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`EXPECTED 1 MATCH, GOT ${count}: ${label}`);
  return src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
}

const old1 = [
  '    if (mode === "ingest") {',
  '      const settings = await getSettings();',
  '      if (!settings) throw new Error("Settings row missing");',
  "      const stats = await runIngest(settings);",
].join("\n");
const new1 = [
  '    if (mode === "ingest") {',
  '      const settings = await getSettings();',
  '      if (!settings) throw new Error("Settings row missing");',
  '      // Same hard budget as the cron cycle: a manual "Fetch now" must never',
  "      // get killed by the worker limit either.",
  '      const stats = await runIngest(settings, "all", { deadline: Date.now() + 125_000 });',
].join("\n");

s = replaceOnce(s, old1, new1, "mode=ingest deadline");
writeFileSync(p, s);
console.log("OK — 1 replacement applied.");
