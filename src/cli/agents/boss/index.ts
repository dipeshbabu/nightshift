import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession } from "../session";
import { bossPrompt } from "../../../lib/prompts/boss";

export interface ValidatorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  basePrompt: string;
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
  const { client, basePrompt, model, commitHash, logDir, onText, onToolStatus } = options;

  const logPath = logDir ? join(logDir, `evaluator_${commitHash}.log`) : undefined;

  const evalPrompt = bossPrompt(basePrompt);

  console.log(`[ralph] ── Boss on ${commitHash} ──`);
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
    console.log(`\n[ralph] Boss log: ${logPath}`);
  }

  const done = output.includes("VERDICT: DONE");

  return { output, done, logPath };
}
