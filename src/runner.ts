import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface PresetConfig {
  name: string;
  title: string;
  description: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  outputs: { file: string; kind: string; required: boolean }[];
}

export function loadPreset(presetDir: string): PresetConfig {
  return JSON.parse(readFileSync(join(presetDir, "preset.json"), "utf8"));
}

/**
 * Runs an installed agent end-to-end with no human in the loop.
 *
 * The autonomy contract:
 *  - `permissionMode: "bypassPermissions"` so no tool call ever pauses for approval.
 *  - `AskUserQuestion` is never in `allowedTools`, so the agent literally cannot ask follow-ups.
 *  - The system prompt (AGENT.md) is self-contained business logic; the brief (context.md)
 *    carries everything client-specific. The agent assumes-and-proceeds on anything missing.
 */
export async function runAgent(agentDir: string, preset: PresetConfig): Promise<number> {
  const systemPrompt = readFileSync(join(agentDir, "AGENT.md"), "utf8");
  const contextPath = join(agentDir, "context.md");

  if (!existsSync(contextPath)) {
    console.error(`✗ No context.md found in ${agentDir}. Run \`lean create ${preset.name}\` first.`);
    return 1;
  }

  // The kickoff prompt is deliberately thin — all the logic lives in the system prompt.
  // We just point the agent at its inputs and outputs and let the workflow run.
  const prompt = [
    `Run the ${preset.title} workflow now.`,
    ``,
    `Your working directory is this agent folder. Read \`context.md\` for the client brief,`,
    `follow the workflow in your instructions, and write your results to:`,
    ...preset.outputs.map((o) => `  - ${o.file}`),
    ``,
    `You are headless: do not ask any questions, make reasonable assumptions and record them.`,
    `When both output files are written, stop.`,
  ].join("\n");

  console.log(`\n▶ Running ${preset.title} …`);
  console.log(`  brief:   ${contextPath}`);
  console.log(`  outputs: ${preset.outputs.map((o) => o.file).join(", ")}\n`);

  let lastResult: { subtype?: string; total_cost_usd?: number } | null = null;

  for await (const message of query({
    prompt,
    options: {
      cwd: agentDir,
      model: preset.model,
      systemPrompt,
      allowedTools: preset.allowedTools, // AskUserQuestion intentionally absent
      permissionMode: "bypassPermissions",
      maxTurns: preset.maxTurns,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          process.stdout.write(`  ${block.text.trim()}\n`);
        } else if (block.type === "tool_use") {
          const hint = summariseToolUse(block.name, block.input);
          process.stdout.write(`  · ${block.name}${hint ? ` ${hint}` : ""}\n`);
        }
      }
    } else if (message.type === "result") {
      lastResult = message;
    }
  }

  return reportOutcome(agentDir, preset, lastResult);
}

function summariseToolUse(name: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  if (name === "WebSearch" && typeof i?.query === "string") return `"${i.query}"`;
  if (name === "WebFetch" && typeof i?.url === "string") return i.url as string;
  if ((name === "Write" || name === "Read") && typeof i?.file_path === "string") {
    return (i.file_path as string).split("/").slice(-2).join("/");
  }
  return "";
}

function reportOutcome(
  agentDir: string,
  preset: PresetConfig,
  result: { subtype?: string; total_cost_usd?: number } | null,
): number {
  console.log("");
  const missing = preset.outputs
    .filter((o) => o.required && !existsSync(join(agentDir, o.file)))
    .map((o) => o.file);

  if (result?.subtype && result.subtype !== "success") {
    console.error(`✗ Agent stopped early (${result.subtype}).`);
  }
  if (missing.length) {
    console.error(`✗ Expected outputs not produced: ${missing.join(", ")}`);
    return 1;
  }

  console.log(`✓ Done. Outputs written to ${agentDir}/output/`);
  for (const o of preset.outputs) console.log(`    ${o.file}`);
  if (typeof result?.total_cost_usd === "number") {
    console.log(`  (run cost: $${result.total_cost_usd.toFixed(4)})`);
  }
  return 0;
}
