import { test, expect } from "bun:test";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import {
  configSearchPaths,
  expandHome,
  detectPlatform,
  opencodeUrl,
  extractExtraArgs,
  resolveRunOptions,
  buildAttachTuiArgs,
  buildXdgEnv,
  readFullConfig,
  saveActivePrefix,
  generateRootPyproject,
  generateUtilsPy,
  generateTestUtilsPy,
  generateReadme,
  generateAgentsMd,
  generateOpencodeConfig,
  checkSandboxAvailability,
  WORKSPACE_PACKAGES,
} from "../src/index";

test("expandHome leaves non-tilde paths unchanged", () => {
  expect(expandHome("/tmp/data")).toBe("/tmp/data");
});

test("expandHome expands ~ and ~/", () => {
  const home = homedir();
  expect(expandHome("~")).toBe(home);
  expect(expandHome("~/projects")).toBe(join(home, "projects"));
});

test("expandHome ignores other tildes", () => {
  expect(expandHome("~other")).toBe("~other");
});

test("configSearchPaths includes cwd and home config locations", () => {
  const cwd = "/tmp/nightshift";
  const home = homedir();
  const paths = configSearchPaths(cwd);
  expect(paths[0]).toBe(join(cwd, "nightshift.json"));
  expect(paths[1]).toBe(join(home, ".config", "nightshift", "nightshift.json"));
});

test("detectPlatform returns supported os/arch strings", () => {
  const platform = detectPlatform();
  expect(["darwin", "linux"]).toContain(platform.os);
  expect(["x86_64", "aarch64"]).toContain(platform.arch);
});

test("opencodeUrl encodes platform data", () => {
  const darwin = opencodeUrl({ os: "darwin", arch: "aarch64" });
  expect(darwin.url).toContain("opencode-darwin-arm64.zip");
  const linux = opencodeUrl({ os: "linux", arch: "x86_64" });
  expect(linux.url).toContain("opencode-linux-x64.tar.gz");
});

test("extractExtraArgs returns args after --", () => {
  expect(extractExtraArgs(["bun", "src/index.ts"])).toEqual([]);
  expect(extractExtraArgs(["bun", "src/index.ts", "--", "serve", "-v"]))
    .toEqual(["serve", "-v"]);
});

test("resolveRunOptions captures tui flag and extra args", () => {
  const argv = { "run-nightshift-tui": true };
  const result = resolveRunOptions(argv, ["bun", "src/index.ts", "--", "serve"]);
  expect(result.useNightshiftTui).toBe(true);
  expect(result.extra).toEqual(["serve"]);
});

test("resolveRunOptions captures sandbox flag", () => {
  const argv = { sandbox: true };
  const result = resolveRunOptions(argv, ["bun", "src/index.ts"]);
  expect(result.sandboxEnabled).toBe(true);
});

test("resolveRunOptions sandbox defaults to false", () => {
  const argv = {};
  const result = resolveRunOptions(argv, ["bun", "src/index.ts"]);
  expect(result.sandboxEnabled).toBe(false);
});

test("buildAttachTuiArgs includes session when provided", () => {
  const withSession = buildAttachTuiArgs("http://localhost:4000", "abc", "/tmp");
  expect(withSession.args.sessionID).toBe("abc");
  const withoutSession = buildAttachTuiArgs("http://localhost:4000", undefined, "/tmp");
  expect(withoutSession.args.sessionID).toBeUndefined();
});

test("WORKSPACE_PACKAGES contains expected packages", () => {
  expect(WORKSPACE_PACKAGES).toContain("numpy");
  expect(WORKSPACE_PACKAGES).toContain("pandas");
  expect(WORKSPACE_PACKAGES).toContain("matplotlib");
  expect(WORKSPACE_PACKAGES).toContain("scikit-learn");
  expect(WORKSPACE_PACKAGES).toContain("jupyter");
});

test("readFullConfig returns null when no config exists", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "nightshift-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    const config = await readFullConfig("/nonexistent/path");
    expect(config).toBeNull();
  } finally {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true });
  }
});

test("saveActivePrefix writes to global config file", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "nightshift-test-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = tempHome;
  // Change to temp dir so no local config interferes
  process.chdir(tempHome);

  try {
    await saveActivePrefix("/test/prefix");

    const configPath = join(tempHome, ".config", "nightshift", "nightshift.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.activePrefix).toBe("/test/prefix");
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true });
  }
});

test("saveActivePrefix preserves existing config fields", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "nightshift-test-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = tempHome;
  // Change to temp dir so no local config interferes
  process.chdir(tempHome);

  try {
    // Create existing config with other fields
    const configDir = join(tempHome, ".config", "nightshift");
    const configPath = join(configDir, "nightshift.json");
    const { mkdirSync } = await import("fs");
    mkdirSync(configDir, { recursive: true });
    await Bun.write(configPath, JSON.stringify({ libraryName: "my-lib", workspacePath: "/some/path" }));

    await saveActivePrefix("/new/prefix");

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.activePrefix).toBe("/new/prefix");
    expect(config.libraryName).toBe("my-lib");
    expect(config.workspacePath).toBe("/some/path");
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true });
  }
});

test("saveActivePrefix updates local config when it exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "nightshift-test-"));
  const tempHome = await mkdtemp(join(tmpdir(), "nightshift-test-home-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = tempHome;
  process.chdir(tempDir);

  try {
    // Create local config
    const localConfigPath = join(tempDir, "nightshift.json");
    await Bun.write(localConfigPath, JSON.stringify({ activePrefix: "/old/prefix", libraryName: "local-lib" }));

    await saveActivePrefix("/new/prefix");

    // Local config should be updated
    const localConfig = JSON.parse(await Bun.file(localConfigPath).text());
    expect(localConfig.activePrefix).toBe("/new/prefix");
    expect(localConfig.libraryName).toBe("local-lib");

    // Global config should NOT exist (we didn't create it and saveActivePrefix should use local)
    const globalConfigPath = join(tempHome, ".config", "nightshift", "nightshift.json");
    const globalFile = Bun.file(globalConfigPath);
    expect(await globalFile.exists()).toBe(false);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true });
    await rm(tempHome, { recursive: true });
  }
});

test("generateRootPyproject includes library name and dependencies", () => {
  const pyproject = generateRootPyproject("agent_lib", ["numpy", "pandas"]);
  expect(pyproject).toContain('name = "agent_lib"');
  expect(pyproject).toContain('"numpy"');
  expect(pyproject).toContain('"pandas"');
  expect(pyproject).toContain('packages = ["src/agent_lib"]');
  expect(pyproject).toContain("hatchling");
});

test("generateRootPyproject converts dashes to underscores in package path", () => {
  const pyproject = generateRootPyproject("my-lib", ["numpy"]);
  expect(pyproject).toContain('name = "my-lib"');
  expect(pyproject).toContain('packages = ["src/my_lib"]');
});

test("generateUtilsPy includes library name in docstring and hello function", () => {
  const utils = generateUtilsPy("agent_lib");
  expect(utils).toContain("Utility functions for agent_lib");
  expect(utils).toContain('return "Hello from agent_lib!"');
  expect(utils).toContain("import numpy");
  expect(utils).toContain("import pandas");
});

test("generateTestUtilsPy imports from correct module", () => {
  const testUtils = generateTestUtilsPy("agent_lib");
  expect(testUtils).toContain("from agent_lib.utils import");
  expect(testUtils).toContain("def test_hello()");
  expect(testUtils).toContain("def test_create_sample_dataframe()");
});

test("generateTestUtilsPy converts dashes to underscores in import", () => {
  const testUtils = generateTestUtilsPy("my-lib");
  expect(testUtils).toContain("from my_lib.utils import");
  expect(testUtils).toContain('assert hello() == "Hello from my-lib!"');
});

test("generateReadme includes library name and usage example", () => {
  const readme = generateReadme("agent_lib");
  expect(readme).toContain("# agent_lib");
  expect(readme).toContain("from agent_lib.utils import");
  expect(readme).toContain("pytest");
});

test("generateReadme converts dashes to underscores in import example", () => {
  const readme = generateReadme("my-lib");
  expect(readme).toContain("# my-lib");
  expect(readme).toContain("from my_lib.utils import");
});

test("generateAgentsMd includes uv instructions", () => {
  const agentsMd = generateAgentsMd("agent_lib");
  expect(agentsMd).toContain("uv add");
  expect(agentsMd).toContain("uv sync");
  expect(agentsMd).toContain("uv run");
  expect(agentsMd).toContain("src/agent_lib");
  expect(agentsMd).toContain("never pip");
});

test("generateAgentsMd converts dashes to underscores in paths", () => {
  const agentsMd = generateAgentsMd("my-lib");
  expect(agentsMd).toContain("src/my_lib");
});

test("generateOpencodeConfig returns valid JSON with expected permissions", () => {
  const configStr = generateOpencodeConfig();
  const config = JSON.parse(configStr);
  expect(config.$schema).toBe("https://opencode.ai/config.json");
  expect(config.permission.edit).toBe("ask");
  expect(config.permission.bash).toBe("ask");
  expect(config.permission.read).toBe("allow");
  expect(config.permission.write).toBe("allow");
  expect(config.permission.glob).toBe("allow");
  expect(config.permission.grep).toBe("ask");
});

test("buildXdgEnv returns correct XDG paths for prefix", () => {
  const xdgEnv = buildXdgEnv("/home/user/.nightshift");
  expect(xdgEnv.XDG_CONFIG_HOME).toBe("/home/user/.nightshift/config");
  expect(xdgEnv.XDG_DATA_HOME).toBe("/home/user/.nightshift/share");
  expect(xdgEnv.XDG_CACHE_HOME).toBe("/home/user/.nightshift/cache");
  expect(xdgEnv.XDG_STATE_HOME).toBe("/home/user/.nightshift/state");
});

test("buildXdgEnv works with different prefix paths", () => {
  const xdgEnv = buildXdgEnv("/tmp/test-nightshift");
  expect(xdgEnv.XDG_CONFIG_HOME).toBe("/tmp/test-nightshift/config");
  expect(xdgEnv.XDG_DATA_HOME).toBe("/tmp/test-nightshift/share");
  expect(xdgEnv.XDG_CACHE_HOME).toBe("/tmp/test-nightshift/cache");
  expect(xdgEnv.XDG_STATE_HOME).toBe("/tmp/test-nightshift/state");
});

test("checkSandboxAvailability returns available on darwin", async () => {
  if (process.platform === "darwin") {
    const result = await checkSandboxAvailability();
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  }
});

test("checkSandboxAvailability returns object with available property", async () => {
  const result = await checkSandboxAvailability();
  expect(typeof result.available).toBe("boolean");
  if (!result.available) {
    expect(typeof result.reason).toBe("string");
  }
});
