import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession } from "../session";
import { bossPrompt } from "../../../lib/prompts/boss";
import type { EventPublisher } from "../bus";

export interface ValidatorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  basePrompt: string;
  model: string;
  commitHash: string;
  logDir?: string;
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
  bus?: EventPublisher;
}

export interface ValidatorResult {
  output: string;
  done: boolean;
  logPath?: string;
}

export async function validate(options: ValidatorOptions): Promise<ValidatorResult> {
  const { client, basePrompt, model, commitHash, logDir, onText, onToolStatus, bus } = options;

  const logPath = logDir ? join(logDir, `evaluator_${commitHash}.log`) : undefined;

  const evalPrompt = bossPrompt(basePrompt);

  if (bus) {
    bus.publish({ type: "boss.start", timestamp: Date.now(), commitHash });
  } else {
    console.log(`[ralph] ── Boss on ${commitHash} ──`);
  }

  const { output } = await runSession({
    client,
    prompt: evalPrompt,
    title: `eval_${commitHash}`,
    model,
    phase: "validator",
    logPath,
    onText,
    onToolStatus,
    bus,
  });

  const done = output.includes("VERDICT: DONE");

  if (bus) {
    bus.publish({ type: "boss.complete", timestamp: Date.now(), commitHash, done, logPath });
  } else if (logPath) {
    console.log(`\n[ralph] Boss log: ${logPath}`);
  }

  return { output, done, logPath };
}
