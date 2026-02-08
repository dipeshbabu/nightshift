import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession, getCommitHash } from "../session";
import { workerPrompt } from "../../../lib/prompts/worker";

export interface ExecutorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  workspace: string;
  basePrompt: string;
  model: string;
  logDir?: string;
  previousEvalOutput?: string;
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
}

export interface ExecutorResult {
  output: string;
  commitHash: string;
  logPath?: string;
}

export async function execute(options: ExecutorOptions): Promise<ExecutorResult> {
  const { client, workspace, basePrompt, model, logDir, previousEvalOutput, onText, onToolStatus } = options;

  const commitHash = await getCommitHash(workspace);
  const logPath = logDir ? join(logDir, `agent_${commitHash}.log`) : undefined;

  const prompt = workerPrompt(basePrompt, previousEvalOutput);

  console.log(`\n[ralph] ── Worker run on ${commitHash} ──`);
  const { output } = await runSession({
    client,
    prompt,
    title: `worker_${commitHash}`,
    model,
    phase: "executor",
    logPath,
    onText,
    onToolStatus,
  });

  if (logPath) {
    console.log(`\n[ralph] Worker log: ${logPath}`);
  }

  return { output, commitHash, logPath };
}
