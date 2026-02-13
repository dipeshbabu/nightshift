import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateGollumConfig, startGollumServer } from "./gollum";

const isWindows = process.platform === "win32";

let tmpDir: string;
let prefix: string;
let workspace: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `gollum-test-${crypto.randomUUID()}`);
  prefix = join(tmpDir, "prefix");
  workspace = join(tmpDir, "workspace");
  mkdirSync(join(prefix, "run"), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  // Create a stub `gollum` script in prefix/bin
  const prefixBin = join(prefix, "bin");
  mkdirSync(prefixBin, { recursive: true });
  if (isWindows) {
    writeFileSync(join(prefixBin, "gollum.cmd"), "@ping -n 60 127.0.0.1 > nul\n");
  } else {
    writeFileSync(join(prefixBin, "gollum"), "#!/bin/sh\nsleep 60\n");
    chmodSync(join(prefixBin, "gollum"), 0o755);
  }

  // Also create prefix/gems so the env setup is valid
  mkdirSync(join(prefix, "gems"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- generateGollumConfig ---

test("generateGollumConfig returns valid ruby config", () => {
  const config = generateGollumConfig();
  expect(config).toContain("Precious::App.set(:wiki_options");
  expect(config).toContain("index_page: 'README'");
  expect(config).toContain("h1_title: true");
  expect(config).toContain("base_path: 'wiki'");
});

// --- startGollumServer ---
// Gollum is a Ruby tool; these tests spawn shell script stubs that require Unix.

describe.skipIf(isWindows)("startGollumServer", () => {
  test("writes PID file and returns handle", async () => {
    const handle = await startGollumServer({ prefix, workspace, port: 19876 });

    try {
      expect(handle.port).toBe(19876);
      expect(handle.url).toBe("http://localhost:19876");
      expect(handle.proc).not.toBeNull();

      // PID file should exist
      const pidFile = Bun.file(join(prefix, "run", "gollum.json"));
      expect(await pidFile.exists()).toBe(true);
      const pidInfo = JSON.parse(await pidFile.text());
      expect(pidInfo.pid).toBe(handle.proc!.pid);
      expect(pidInfo.port).toBe(19876);
    } finally {
      handle.kill();
    }
  });

  test("creates gollum_config.rb if missing", async () => {
    expect(existsSync(join(workspace, "gollum_config.rb"))).toBe(false);

    const handle = await startGollumServer({ prefix, workspace, port: 19877 });

    try {
      expect(existsSync(join(workspace, "gollum_config.rb"))).toBe(true);
      const content = await Bun.file(join(workspace, "gollum_config.rb")).text();
      expect(content).toContain("index_page: 'README'");
    } finally {
      handle.kill();
    }
  });

  test("does not overwrite existing gollum_config.rb", async () => {
    const customConfig = "# custom config\n";
    await Bun.write(join(workspace, "gollum_config.rb"), customConfig);

    const handle = await startGollumServer({ prefix, workspace, port: 19878 });

    try {
      const content = await Bun.file(join(workspace, "gollum_config.rb")).text();
      expect(content).toBe(customConfig);
    } finally {
      handle.kill();
    }
  });

  test("reuses existing live process", async () => {
    const handle1 = await startGollumServer({ prefix, workspace, port: 19879 });

    try {
      // Second call should reuse the existing process
      const handle2 = await startGollumServer({ prefix, workspace, port: 19880 });

      // Should reuse: proc is null, port matches first handle
      expect(handle2.proc).toBeNull();
      expect(handle2.port).toBe(19879);
      expect(handle2.url).toBe("http://localhost:19879");
    } finally {
      handle1.kill();
    }
  });

  test("cleans up stale PID file and starts fresh", async () => {
    // Write a PID file pointing to a dead process
    await Bun.write(
      join(prefix, "run", "gollum.json"),
      JSON.stringify({ pid: 999999, port: 19881 }),
    );

    const handle = await startGollumServer({ prefix, workspace, port: 19882 });

    try {
      // Should have started a fresh process (not reused)
      expect(handle.proc).not.toBeNull();
      expect(handle.port).toBe(19882);
    } finally {
      handle.kill();
    }
  });

  test("kill() removes PID file", async () => {
    const handle = await startGollumServer({ prefix, workspace, port: 19883 });

    const pidPath = join(prefix, "run", "gollum.json");
    expect(existsSync(pidPath)).toBe(true);

    handle.kill();

    expect(existsSync(pidPath)).toBe(false);
  });

  test("defaults to port 3001", async () => {
    const handle = await startGollumServer({ prefix, workspace });

    try {
      expect(handle.port).toBe(3001);
      expect(handle.url).toBe("http://localhost:3001");
    } finally {
      handle.kill();
    }
  });
});
