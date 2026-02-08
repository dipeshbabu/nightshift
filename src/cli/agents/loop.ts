import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { execute } from "./worker";
import { validate } from "./boss";

export interface AgentLoopOptions {
  workerClient: ReturnType<typeof createOpencodeClient>;
  bossClient: ReturnType<typeof createOpencodeClient>;
  workspace: string;
  prompt: string;
  agentModel: string;
  evalModel: string;
  logDir?: string;
  maxIterations?: number;
  onText?: (phase: "executor" | "validator", text: string) => void;
}

export interface AgentLoopResult {
  iterations: number;
  finalOutput: string;
  done: boolean;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    workerClient,
    bossClient,
    workspace,
    prompt,
    agentModel,
    evalModel,
    logDir,
    maxIterations = 50,
    onText,
  } = options;

  let previousEvalOutput: string | undefined;
  let iterations = 0;
  let finalOutput = "";

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    // worker
    const execResult = await execute({
      client: workerClient,
      workspace,
      basePrompt: prompt,
      model: agentModel,
      logDir,
      previousEvalOutput,
      onText: onText ? (text) => onText("executor", text) : undefined,
    });

    // boss
    const valResult = await validate({
      client: bossClient,
      basePrompt: prompt,
      model: evalModel,
      commitHash: execResult.commitHash,
      logDir,
      onText: onText ? (text) => onText("validator", text) : undefined,
    });

    if (valResult.done) {
      console.log("[ralph] Boss says DONE. Exiting.");
      finalOutput = execResult.output;
      return { iterations, finalOutput, done: true };
    }

    console.log("[ralph] Not done yet. Looping...");
    previousEvalOutput = valResult.output;
    finalOutput = execResult.output;
  }

  console.log(`[ralph] Reached max iterations (${maxIterations}). Exiting.`);
  return { iterations, finalOutput, done: false };
}
