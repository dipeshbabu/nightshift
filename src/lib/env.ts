import { join, delimiter } from "path";
import { existsSync } from "fs";

export function posixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function buildXdgEnv(prefix: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: posixPath(join(prefix, "config")),
    XDG_DATA_HOME: posixPath(join(prefix, "share")),
    XDG_CACHE_HOME: posixPath(join(prefix, "cache")),
    XDG_STATE_HOME: posixPath(join(prefix, "state")),
  };
}

export function buildUvEnv(prefix: string): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: posixPath(join(prefix, "python")),
    UV_PYTHON_PREFERENCE: "only-managed",
  };
}

export function buildPath(prefix: string): string {
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  let pathParts = [binDir];
  if (existsSync(uvToolsBin)) pathParts.unshift(uvToolsBin);
  return `${pathParts.join(delimiter)}${delimiter}${process.env.PATH ?? ""}`;
}
