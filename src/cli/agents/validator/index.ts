import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession } from "../session";

export interface ValidatorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  basePrompt: string;
  agentOutput: string;
  model: string;
  commitHash: string;
  logDir?: string;
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
}

export interface ValidatorResult {
  output: string;
  done: boolean;
  logPath?: string;
}

export async function validate(options: ValidatorOptions): Promise<ValidatorResult> {
  const { client, basePrompt, agentOutput, model, commitHash, logDir, onText, onToolStatus } = options;

  const logPath = logDir ? join(logDir, `evaluator_${commitHash}.log`) : undefined;

  const evalPrompt = [
    "You are an evaluator. The original task was:",
    "```",
    basePrompt,
    "```",
    "",
    "The agent produced this output:",
    "```",
    agentOutput,
    "```",
    "",
    "Thoroughly explore and test the environment. You need to grade this CRITICALLY.",
    "You shouldn't only look at the agent output, but you should also test the code manually like you're performing UAT.",
    "",
    "Is the task DONE? If the task is fully complete, respond with exactly DONE on its own line.",
    "If NOT done, explain concisely what still needs to be completed.",
  ].join("\n");

  console.log(`[ralph] ── Evaluator on ${commitHash} ──`);
  const { output } = await runSession({
    client,
    prompt: evalPrompt,
    title: `eval_${commitHash}`,
    model,
    phase: "validator",
    logPath,
    onText,
    onToolStatus,
  });

  if (logPath) {
    console.log(`\n[ralph] Evaluator log: ${logPath}`);
  }

  const done = output.includes("DONE");

  return { output, done, logPath };
}
