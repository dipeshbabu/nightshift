export const OPENCODE_VERSION = "v1.1.37";
export const UV_VERSION = "0.9.27";
export const RIPGREP_VERSION = "15.1.0";
export const CMAKE_VERSION = "4.2.3";
export const RUBY_VERSION = "3.3.7";
export const WORKSPACE_PACKAGES = ["numpy", "pandas", "matplotlib", "scikit-learn", "jupyter"];
export const XDG_DIRS = ["config", "share", "cache", "state"];
export const AGENT_LIBRARY_NAME = "nightshift-agent-lib";
export const WORKSPACE_DIRNAME = "workspace";

// Build constants injected at compile time
declare const NIGHTSHIFT_VERSION: string;
declare const NIGHTSHIFT_LIBC: string;

export function getNightshiftVersion(): string {
  return typeof NIGHTSHIFT_VERSION !== "undefined" ? NIGHTSHIFT_VERSION : "dev";
}

export function getNightshiftLibc(): string {
  return typeof NIGHTSHIFT_LIBC !== "undefined" ? NIGHTSHIFT_LIBC : "";
}

