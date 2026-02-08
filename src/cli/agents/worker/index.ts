import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { runSession, getCommitHash } from "../session";
import { workerPrompt } from "../../../lib/prompts/worker";
import type { EventPublisher } from "../bus";

export interface ExecutorOptions {
  client: ReturnType<typeof createOpencodeClient>;
  workspace: string;
  basePrompt: string;
  model: string;
  logDir?: string;
  previousEvalOutput?: string;
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
  bus?: EventPublisher;
}

export interface ExecutorResult {
  output: string;
  commitHash: string;
  logPath?: string;
}

export async function execute(options: ExecutorOptions): Promise<ExecutorResult> {
  const { client, workspace, basePrompt, model, logDir, previousEvalOutput, onText, onToolStatus, bus } = options;

  const commitHash = await getCommitHash(workspace);
  const logPath = logDir ? join(logDir, `agent_${commitHash}.log`) : undefined;

  const prompt = workerPrompt(basePrompt, previousEvalOutput);

  if (bus) {
    bus.publish({ type: "worker.start", timestamp: Date.now(), commitHash });
  } else {
    console.log(`\n[ralph] ── Worker run on ${commitHash} ──`);
  }

  const { output } = await runSession({
    client,
    prompt,
    title: `worker_${commitHash}`,
    model,
    phase: "executor",
    logPath,
    onText,
    onToolStatus,
    bus,
  });

  if (bus) {
    bus.publish({ type: "worker.complete", timestamp: Date.now(), commitHash, logPath });
  } else if (logPath) {
    console.log(`\n[ralph] Worker log: ${logPath}`);
  }

  return { output, commitHash, logPath };
}
