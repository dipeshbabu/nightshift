import { join } from "node:path";

export interface SandboxOptions {
  workspacePath: string;      // Writable directory
  prefixPath: string;         // Tool prefix (needs write for cache/state)
  binDir: string;             // Where bwrap binary lives
  env: Record<string, string>;
}

export function buildSandboxCommand(
  command: string[],
  options: SandboxOptions
): string[] {
  const platform = process.platform;

  if (platform === "linux") {
    return buildBwrapCommand(command, options);
  } else if (platform === "darwin") {
    return buildSandboxExecCommand(command, options);
  }

  // Fallback: no sandboxing (Windows)
  console.warn("Sandbox not available on this platform");
  return command;
}

function buildBwrapCommand(command: string[], opts: SandboxOptions): string[] {
  const bwrap = join(opts.binDir, "bwrap");

  return [
    bwrap,
    // Read-only root filesystem
    "--ro-bind", "/", "/",
    // Writable workspace
    "--bind", opts.workspacePath, opts.workspacePath,
    // Writable prefix (for cache, state, etc.)
    "--bind", opts.prefixPath, opts.prefixPath,
    // Writable /tmp
    "--tmpfs", "/tmp",
    // Required system mounts
    "--dev", "/dev",
    "--proc", "/proc",
    // Working directory
    "--chdir", opts.workspacePath,
    // Pass through environment
    ...Object.entries(opts.env).flatMap(([k, v]) => ["--setenv", k, v]),
    // The actual command
    "--",
    ...command,
  ];
}

function buildSandboxExecCommand(command: string[], opts: SandboxOptions): string[] {
  const profile = generateMacOSProfile(opts);
  const profilePath = join(opts.prefixPath, "sandbox.sb");

  // Write profile synchronously
  Bun.write(profilePath, profile);

  return [
    "sandbox-exec",
    "-f", profilePath,
    ...command,
  ];
}

function generateMacOSProfile(opts: SandboxOptions): string {
  return `(version 1)
(allow default)

; Deny all file writes by default
(deny file-write*)

; Allow writes to workspace
(allow file-write* (subpath "${opts.workspacePath}"))

; Allow writes to prefix (cache, state, etc.)
(allow file-write* (subpath "${opts.prefixPath}"))

; Allow writes to temp directories
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/var/tmp"))
(allow file-write* (subpath "/var/folders"))

; Allow all reads
(allow file-read*)

; Allow network
(allow network*)

; Allow process operations
(allow process*)
`;
}
