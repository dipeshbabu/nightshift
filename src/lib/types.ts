export interface Platform {
  os: "darwin" | "linux";
  arch: "x86_64" | "aarch64";
}

export interface NightshiftConfig {
  activePrefix?: string;
  prefix?: string;
  workspacePath?: string;
  libraryName?: string;
  workspacePackages?: string[];
}

export interface BinaryMapping {
  /** Name of the symlink in bin/ */
  linkName: string;
  /** Path to the real binary relative to tools/<name>/ */
  target: string;
}

export interface ScaffoldOptions {
  skipAgentsMd?: boolean;
}

export interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export type ToolCompletionPart = {
  tool: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
    title?: string;
  };
  id: string;
};
