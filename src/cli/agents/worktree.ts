import { join } from "path";

// ── Merge lock (Issue #1) ────────────────────────────────────────────
// Promise-chain mutex that serializes all merge-into-main operations
// across concurrent runs. Error-safe: releases lock on throw.
let _mergeLock = Promise.resolve();

export function withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));

  const prev = _mergeLock;
  _mergeLock = gate;

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release!();
    }
  });
}

// ── Abort merge (Issue #6) ───────────────────────────────────────────
// Runs `git merge --abort`, ignores exit code. Called before each merge
// retry to ensure clean state regardless of whether the resolver committed.
export async function abortMerge(worktreePath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "merge", "--abort"],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited; // ignore exit code — may fail if no merge in progress
}

// ── Create worktree (Issue #5: collision check) ──────────────────────

interface CreateWorktreeOptions {
  repoPath: string;
  worktreesDir: string;
  branchName: string;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { repoPath, worktreesDir, branchName } = opts;
  const worktreePath = join(worktreesDir, branchName.replace(/\//g, "-"));

  // Collision check: if branch already exists (stale from a previous run),
  // prune worktree bookkeeping and force-delete the branch before proceeding.
  const listProc = Bun.spawn(
    ["git", "branch", "--list", branchName],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await listProc.exited;
  const existing = (await new Response(listProc.stdout).text()).trim();

  if (existing) {
    console.warn(`[worktree] Stale branch "${branchName}" found — cleaning up`);
    const pruneProc = Bun.spawn(
      ["git", "worktree", "prune"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    await pruneProc.exited;

    const delProc = Bun.spawn(
      ["git", "branch", "-D", branchName],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    await delProc.exited;
  }

  const proc = Bun.spawn(
    ["git", "worktree", "add", worktreePath, "-b", branchName],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  return worktreePath;
}

// ── Merge helpers ────────────────────────────────────────────────────

export interface MergeResult {
  clean: boolean;
  conflicts?: string;
}

export async function mergeMainIntoWorktree(worktreePath: string): Promise<MergeResult> {
  const proc = Bun.spawn(
    ["git", "merge", "main", "--no-edit"],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return { clean: true };
  }

  // Merge conflict — collect the list of conflicted files
  const diffProc = Bun.spawn(
    ["git", "diff", "--name-only", "--diff-filter=U"],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );
  await diffProc.exited;
  const conflicts = (await new Response(diffProc.stdout).text()).trim();

  return { clean: false, conflicts };
}

export async function mergeWorktreeIntoMain(repoPath: string, branchName: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "merge", branchName, "--no-edit"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to merge ${branchName} into main: ${stderr.trim()}`);
  }
}

// ── Remove worktree (Issue #4: hardened) ─────────────────────────────

export interface RemoveWorktreeResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

interface RemoveWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  const { repoPath, worktreePath, branchName } = opts;

  // Remove the worktree
  const removeProc = Bun.spawn(
    ["git", "worktree", "remove", "--force", worktreePath],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const removeExit = await removeProc.exited;
  const worktreeRemoved = removeExit === 0;
  if (!worktreeRemoved) {
    const stderr = (await new Response(removeProc.stderr).text()).trim();
    console.warn(`[worktree] Failed to remove worktree "${worktreePath}": ${stderr}`);
  }

  // Force-delete the task branch so unmerged branches get cleaned up
  const branchProc = Bun.spawn(
    ["git", "branch", "-D", branchName],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const branchExit = await branchProc.exited;
  const branchDeleted = branchExit === 0;
  if (!branchDeleted) {
    const stderr = (await new Response(branchProc.stderr).text()).trim();
    console.warn(`[worktree] Failed to delete branch "${branchName}": ${stderr}`);
  }

  return { worktreeRemoved, branchDeleted };
}

// ── Prune stale worktrees (Issue #7) ─────────────────────────────────
// Called at startup to clean up any worktrees left behind by a crash.

export async function pruneStaleWorktrees(repoPath: string, worktreesDir: string): Promise<void> {
  // First, prune internal git bookkeeping for worktrees whose dirs are gone
  const pruneProc = Bun.spawn(
    ["git", "worktree", "prune"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await pruneProc.exited;

  // Parse remaining worktrees to find any under our managed dir
  const listProc = Bun.spawn(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await listProc.exited;
  const output = (await new Response(listProc.stdout).text()).trim();
  if (!output) return;

  // Porcelain format: blocks separated by blank lines, each starts with "worktree <path>"
  // followed by optional "HEAD <sha>", "branch refs/heads/<name>", etc.
  const blocks = output.split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));

    if (!worktreeLine) continue;
    const wtPath = worktreeLine.slice("worktree ".length);

    // Only clean up worktrees under our managed directory
    if (!wtPath.startsWith(worktreesDir)) continue;

    const branchName = branchLine
      ? branchLine.slice("branch refs/heads/".length)
      : undefined;

    console.warn(`[worktree] Pruning stale worktree: ${wtPath}${branchName ? ` (branch: ${branchName})` : ""}`);

    // Force-remove the worktree
    const rmProc = Bun.spawn(
      ["git", "worktree", "remove", "--force", wtPath],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    await rmProc.exited;

    // Force-delete the associated branch
    if (branchName) {
      const delProc = Bun.spawn(
        ["git", "branch", "-D", branchName],
        { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
      );
      await delProc.exited;
    }
  }
}
