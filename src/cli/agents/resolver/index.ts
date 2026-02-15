import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { runSession } from "../session";
import { resolverPrompt } from "../../../lib/prompts/resolver";
import { resolverBossPrompt } from "../../../lib/prompts/resolverBoss";
import type { EventPublisher } from "../bus";

export interface ResolverOptions {
  workerClient: ReturnType<typeof createOpencodeClient>;
  bossClient: ReturnType<typeof createOpencodeClient>;
  worktreePath: string;
  conflicts: string;
  model: string;
  evalModel: string;
  maxIterations?: number; // default 4
  bus?: EventPublisher;
}

export interface ResolverResult {
  output: string;
  done: boolean;
}

async function execGit(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  return { code, stdout, stderr };
}

async function getMergeState(worktreePath: string): Promise<{
  mergeInProgress: boolean;
  statusPorcelain: string;
  conflictMarkers: string;
  conflictedFiles: string;
}> {
  const mergeHead = await execGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktreePath);
  const mergeInProgress = mergeHead.code === 0;

  const status = await execGit(["status", "--porcelain"], worktreePath);

  // 0 = found markers, 1 = none, 2 = error
  const markers = await execGit(["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."], worktreePath);
  const conflictMarkers = markers.code === 0 ? markers.stdout : "";

  const conflicts = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);

  return {
    mergeInProgress,
    statusPorcelain: status.stdout,
    conflictMarkers,
    conflictedFiles: conflicts.stdout.trim(),
  };
}

export async function resolve(options: ResolverOptions): Promise<ResolverResult> {
  const {
    workerClient,
    bossClient,
    worktreePath,
    conflicts: originalConflicts,
    model,
    evalModel,
    maxIterations = 4,
    bus,
  } = options;

  if (bus) {
    bus.publish({ type: "resolver.start", timestamp: Date.now(), conflicts: originalConflicts });
  }

  let feedback = "";
  let lastOutput = "";

  for (let iter = 1; iter <= maxIterations; iter++) {
    const stateBefore = await getMergeState(worktreePath);
    const currentConflicts = stateBefore.conflictedFiles || originalConflicts;

    const prompt =
      resolverPrompt(currentConflicts) +
      (feedback ? `\n\n## Boss feedback\n${feedback}` : "");

    const { output } = await runSession({
      client: workerClient,
      prompt,
      title: `merge-resolver-${iter}`,
      model,
      phase: "resolver",
      bus,
    });

    lastOutput = output;

    const stateAfter = await getMergeState(worktreePath);

    // Deterministic checks are the source of truth.
    const done =
      !stateAfter.mergeInProgress &&
      !stateAfter.conflictMarkers &&
      !stateAfter.statusPorcelain;

    if (done) {
      if (bus) bus.publish({ type: "resolver.complete", timestamp: Date.now() });
      return { output: lastOutput, done: true };
    }

    // Boss provides targeted instructions (non-interactive).
    const bossPrompt = resolverBossPrompt({
      originalConflicts,
      currentConflicts: stateAfter.conflictedFiles,
      mergeInProgress: stateAfter.mergeInProgress,
      statusPorcelain: stateAfter.statusPorcelain,
      conflictMarkers: stateAfter.conflictMarkers,
      resolverOutput: lastOutput.slice(-8000),
    });

    const boss = await runSession({
      client: bossClient,
      prompt: bossPrompt,
      title: `merge-resolver-boss-${iter}`,
      model: evalModel,
      phase: "validator",
      bus,
      timeoutMs: 10 * 60 * 1000,
    });

    const bossSaysDone = boss.output.includes("VERDICT: DONE");

    if (bossSaysDone) {
      // Boss can't change state, but re-checking here makes the logic explicit and robust.
      const stateNow = await getMergeState(worktreePath);
      const doneNow =
        !stateNow.mergeInProgress &&
        !stateNow.conflictMarkers &&
        !stateNow.statusPorcelain;

      if (doneNow) {
        if (bus) bus.publish({ type: "resolver.complete", timestamp: Date.now() });
        return { output: lastOutput, done: true };
      }

      feedback =
        `Deterministic checks still failing.\n` +
        `mergeInProgress=${stateNow.mergeInProgress}\n` +
        `dirty=${Boolean(stateNow.statusPorcelain)}\n` +
        `markers=${Boolean(stateNow.conflictMarkers)}\n` +
        `Fix remaining conflicts, git add, and git commit.`;
    } else {
      feedback = boss.output;
    }
  }

  if (bus) bus.publish({ type: "resolver.complete", timestamp: Date.now() });
  return { output: lastOutput, done: false };
}
