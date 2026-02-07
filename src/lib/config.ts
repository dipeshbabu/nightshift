import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import type { NightshiftConfig } from "./types";

export function configSearchPaths(cwd: string): string[] {
  const paths = [join(cwd, "nightshift.json")];
  // Use process.env.HOME first (allows testing), fallback to homedir()
  const home = process.env.HOME || homedir();
  if (home) {
    paths.push(join(home, ".config", "nightshift", "nightshift.json"));
  }
  return paths;
}

export function expandHome(input: string): string {
  if (!input.startsWith("~")) return input;
  const home = homedir();
  if (!home) return input;
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

export async function readConfigFile(path: string): Promise<NightshiftConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  try {
    return JSON.parse(text) as NightshiftConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse nightshift.json at ${path}: ${message}`);
  }
}

export async function resolvePrefixFromConfig(cwd: string): Promise<{ prefix: string; source: string }> {
  for (const configPath of configSearchPaths(cwd)) {
    const config = await readConfigFile(configPath);
    if (!config) continue;
    const prefix = config.activePrefix ?? config.prefix;
    if (!prefix) {
      throw new Error(
        `nightshift.json at ${configPath} must include "activePrefix" (or "prefix").`,
      );
    }
    return { prefix: expandHome(prefix), source: configPath };
  }

  const locations = configSearchPaths(cwd).join(", ");
  throw new Error(`No nightshift.json found. Looked in: ${locations}`);
}

export async function readFullConfig(cwd: string): Promise<NightshiftConfig | null> {
  for (const configPath of configSearchPaths(cwd)) {
    const config = await readConfigFile(configPath);
    if (config) return config;
  }
  return null;
}

export async function saveActivePrefix(prefix: string): Promise<void> {
  // Use process.env.HOME first (allows testing), fallback to homedir()
  const home = process.env.HOME || homedir();
  if (!home) return;

  // Check for local config first - if it exists, update it (since it takes precedence)
  const localConfigPath = join(process.cwd(), "nightshift.json");
  const localFile = Bun.file(localConfigPath);
  if (await localFile.exists()) {
    let localConfig: NightshiftConfig = {};
    try {
      localConfig = JSON.parse(await localFile.text());
    } catch {
      // Ignore parse errors, start fresh
    }
    localConfig.activePrefix = prefix;
    await Bun.write(localConfigPath, JSON.stringify(localConfig, null, 2));
    console.log(`  Saved active prefix to ${localConfigPath}`);
    return;
  }

  // No local config, save to global config
  const configDir = join(home, ".config", "nightshift");
  const configPath = join(configDir, "nightshift.json");

  mkdirSync(configDir, { recursive: true });

  // Read existing config to preserve other fields
  let config: NightshiftConfig = {};
  const file = Bun.file(configPath);
  if (await file.exists()) {
    try {
      config = JSON.parse(await file.text());
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  config.activePrefix = prefix;
  await Bun.write(configPath, JSON.stringify(config, null, 2));
  console.log(`  Saved active prefix to ${configPath}`);
}
