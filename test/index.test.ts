import { test, expect } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  configSearchPaths,
  expandHome,
  detectPlatform,
  opencodeUrl,
  extractExtraArgs,
  resolveRunOptions,
  buildAttachTuiArgs,
  readFullConfig,
  generateRootPyproject,
  generateUtilsPy,
  generateTestUtilsPy,
  generateReadme,
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
  const config = await readFullConfig("/nonexistent/path");
  expect(config).toBeNull();
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
