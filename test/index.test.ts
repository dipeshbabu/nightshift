import { test, expect } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { configSearchPaths, expandHome, detectPlatform, opencodeUrl } from "../src/index";

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
