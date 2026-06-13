#!/usr/bin/env -S npx tsx
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreset, runAgent } from "./runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS_DIR = join(ROOT, "presets");
const AGENTS_DIR = join(ROOT, "agents");

const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

function listPresets(): string[] {
  if (!existsSync(PRESETS_DIR)) return [];
  return readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PRESETS_DIR, d.name, "preset.json")))
    .map((d) => d.name);
}

function usage(): void {
  const presets = listPresets();
  console.log(`lean — install and run preset business agents

Usage:
  lean create <agent>     Install an agent into ./agents/<agent> with a context file to fill in
  lean run <agent>        Run an installed agent end-to-end and write its outputs
  lean list               List available agent presets

Available presets:${presets.length ? "\n  " + presets.join("\n  ") : " (none)"}`);
}

function cmdCreate(name: string): number {
  const presetDir = join(PRESETS_DIR, name);
  if (!existsSync(join(presetDir, "preset.json"))) {
    console.error(`✗ Unknown agent "${name}". Available: ${listPresets().join(", ") || "(none)"}`);
    return 1;
  }
  const preset = loadPreset(presetDir);
  const agentDir = join(AGENTS_DIR, name);

  if (existsSync(agentDir)) {
    console.error(`✗ ${agentDir} already exists. Edit its context.md and run \`lean run ${name}\`,`);
    console.error(`  or delete the folder to reinstall.`);
    return 1;
  }

  mkdirSync(join(agentDir, "output"), { recursive: true });
  cpSync(join(presetDir, "AGENT.md"), join(agentDir, "AGENT.md"));
  cpSync(join(presetDir, "context.template.md"), join(agentDir, "context.md"));
  writeFileSync(
    join(agentDir, "preset.json"),
    JSON.stringify(preset, null, 2) + "\n",
  );

  console.log(`✓ Installed "${preset.title}" → ${agentDir}

Next:
  1. Open ${join(agentDir, "context.md")} and fill in this client's details.
  2. Run:  lean run ${name}`);
  return 0;
}

async function cmdRun(name: string): Promise<number> {
  const agentDir = join(AGENTS_DIR, name);
  const presetPath = join(agentDir, "preset.json");
  if (!existsSync(presetPath)) {
    console.error(`✗ "${name}" is not installed. Run \`lean create ${name}\` first.`);
    return 1;
  }
  const preset = JSON.parse(readFileSync(presetPath, "utf8"));
  return runAgent(agentDir, preset);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  let code = 0;
  switch (cmd) {
    case "create":
      if (!arg) { usage(); code = 1; break; }
      code = cmdCreate(arg);
      break;
    case "run":
      if (!arg) { usage(); code = 1; break; }
      code = await cmdRun(arg);
      break;
    case "list":
      console.log(listPresets().join("\n") || "(no presets)");
      break;
    default:
      usage();
      code = cmd ? 1 : 0;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
