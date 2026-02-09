import { join } from "path";

interface CreateWorktreeOptions {
  repoPath: string;
  worktreesDir: string;
  branchName: string;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { repoPath, worktreesDir, branchName } = opts;
  const worktreePath = join(worktreesDir, branchName.replace(/\//g, "-"));

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

interface RemoveWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { repoPath, worktreePath, branchName } = opts;

  // Remove the worktree
  const removeProc = Bun.spawn(
    ["git", "worktree", "remove", "--force", worktreePath],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await removeProc.exited;

  // Delete the task branch
  const branchProc = Bun.spawn(
    ["git", "branch", "-d", branchName],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await branchProc.exited;
}
