import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, delimiter } from "path";
import { tmpdir } from "os";
import { installRubyAndGollum } from "../src/lib/tools";

describe.skipIf(!process.env.E2E)("e2e: installRubyAndGollum", () => {
  const prefix = mkdtempSync(join(tmpdir(), "nightshift-e2e-"));

  afterAll(() => {
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
  }, 300_000);  // 5 min timeout
});
