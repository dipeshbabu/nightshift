import { join } from "path";
import { existsSync } from "fs";

export function buildXdgEnv(prefix: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(prefix, "config"),
    XDG_DATA_HOME: join(prefix, "share"),
    XDG_CACHE_HOME: join(prefix, "cache"),
    XDG_STATE_HOME: join(prefix, "state"),
  };
}

export function buildUvEnv(prefix: string): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: join(prefix, "python"),
    UV_PYTHON_PREFERENCE: "only-managed",
  };
}

export function buildPath(prefix: string): string {
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  let pathParts = [binDir];
  if (existsSync(uvToolsBin)) pathParts.unshift(uvToolsBin);
  return `${pathParts.join(":")}:${process.env.PATH ?? ""}`;
}
