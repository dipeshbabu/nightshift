import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, delimiter } from "path";
import { tmpdir } from "os";
import { installRubyAndGollum } from "../src/lib/tools";
import { startGollumServer, type GollumHandle } from "../src/cli/agents/gollum";

describe.skipIf(!process.env.E2E)("e2e: installRubyAndGollum", () => {
  const prefix = mkdtempSync(join(tmpdir(), "nightshift-e2e-"));
  let gollumHandle: GollumHandle | null = null;

  afterAll(() => {
    gollumHandle?.kill();
    rmSync(prefix, { recursive: true, force: true });
  });

  test("installs cmake, ruby, gem, and gollum into prefix", async () => {
    await installRubyAndGollum(prefix);

    // Gollum needs GEM_HOME and PATH to locate its gem dependencies.
    const env = {
      ...process.env,
      GEM_HOME: join(prefix, "gems"),
      PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH}`,
    };

    // All expected binaries exist and run
    for (const [bin, versionFlag, expected] of [
      ["cmake", "--version", "cmake version"],
      ["ruby", "--version", "ruby 3.3.7"],
      ["gollum", "--version", ""],  // just check exit 0
    ] as const) {
      const proc = Bun.spawn(
        [join(prefix, "bin", bin), versionFlag],
        { stdout: "pipe", stderr: "pipe", env },
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      if (expected) {
        const out = await new Response(proc.stdout).text();
        expect(out).toContain(expected);
      }
    }
  }, 300_000);

  test("gollum server starts and serves HTTP", async () => {
    // Create a workspace with a git repo for gollum to serve
    const workspace = join(prefix, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# Test Workspace\n");
    await Bun.spawn(["git", "init", "-b", "main"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "add", "-A"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;

    // Use a random high port; the e2e suite runs in isolation so collision risk is minimal.
    const gollumPort = 40000 + Math.floor(Math.random() * 20000);
    gollumHandle = await startGollumServer({ prefix, workspace, port: gollumPort });
    expect(gollumHandle.proc).not.toBeNull();

    // Poll until the server is ready (gollum takes a moment to boot)
    let res: Response | null = null;
    for (let i = 0; i < 30; i++) {
      try {
        res = await fetch(gollumHandle.url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) break;
      } catch { }
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);

    const html = await res!.text();
    expect(html).toContain("Test Workspace");
  }, 60_000);
});
