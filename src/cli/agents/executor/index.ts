import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession, getCommitHash } from "../session";

export interface ExecutorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  workspace: string;
  basePrompt: string;
  model: string;
  logDir?: string;
  previousAgentOutput?: string;
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
  const { client, workspace, basePrompt, model, logDir, previousAgentOutput, previousEvalOutput, onText, onToolStatus } = options;

  const commitHash = await getCommitHash(workspace);
  const logPath = logDir ? join(logDir, `agent_${commitHash}.log`) : undefined;

  // Build prompt with context from previous runs
  let prompt = basePrompt;
  if (previousAgentOutput) {
    prompt += `\n\nTHIS IS WHAT HAPPENED LAST RUN:\n${previousAgentOutput}`;
  }
  if (previousEvalOutput) {
    prompt += `\n\nEVALUATOR SAID YOU ARE NOT DONE WITH THIS MESSAGE:\n${previousEvalOutput}`;
  }

  console.log(`\n[ralph] ── Agent run on ${commitHash} ──`);
  const { output } = await runSession({
    client,
    prompt,
    title: `agent_${commitHash}`,
    model,
    phase: "executor",
    logPath,
    onText,
    onToolStatus,
  });

  if (logPath) {
    console.log(`\n[ralph] Agent log: ${logPath}`);
  }

  return { output, commitHash, logPath };
}
