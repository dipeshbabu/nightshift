import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import { join as posixJoin } from "path/posix";
import { tmpdir } from "os";
import { buildBootstrapPrompt } from "../src/lib/bootstrap";
import { buildPath, buildXdgEnv } from "../src/lib/env";
import { waitForServer } from "../src/lib/server";
import { checkPrefixTools, ensurePrefixTools } from "../src/lib/tools";

describe("checkPrefixTools", () => {
  const testPrefix = join(tmpdir(), "nightshift-test-prefixtools");

  beforeEach(() => {
    rmSync(testPrefix, { recursive: true, force: true });
    mkdirSync(join(testPrefix, "bin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testPrefix, { recursive: true, force: true });
  });

  test("reports all tools missing when bin is empty", () => {
    const missing = checkPrefixTools(testPrefix);
    expect(missing).toContain("opencode");
    expect(missing).toContain("uv");
    expect(missing).toContain("rg");
    expect(missing).toContain("ruby");
    expect(missing).toContain("gem");
    expect(missing).toContain("gollum");
  });

  test("reports no missing tools when all binaries exist", () => {
    for (const bin of ["opencode", "uv", "rg", "ruby", "gem", "gollum"]) {
      writeFileSync(join(testPrefix, "bin", bin), "");
    }
    const missing = checkPrefixTools(testPrefix);
    expect(missing).toHaveLength(0);
  });

  test("reports only gollum-related tools missing for pre-v0.1.4 prefix", () => {
    // Simulate a pre-v0.1.4 prefix that has core tools but no gollum
    for (const bin of ["opencode", "uv", "rg"]) {
      writeFileSync(join(testPrefix, "bin", bin), "");
    }
    const missing = checkPrefixTools(testPrefix);
    expect(missing).toEqual(["ruby", "gem", "gollum"]);
  });
});

describe("ensurePrefixTools", () => {
  const testPrefix = join(tmpdir(), "nightshift-test-ensuretools");

  beforeEach(() => {
    rmSync(testPrefix, { recursive: true, force: true });
    mkdirSync(join(testPrefix, "bin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testPrefix, { recursive: true, force: true });
  });

  test("throws for missing core tools", async () => {
    // Empty prefix — core tools missing
    await expect(ensurePrefixTools(testPrefix)).rejects.toThrow(
      /Core tools missing from prefix/,
    );
  });

  test("does nothing when all tools are present", async () => {
    for (const bin of ["opencode", "uv", "rg", "ruby", "gem", "gollum"]) {
      writeFileSync(join(testPrefix, "bin", bin), "");
    }
    // Should resolve without throwing or installing anything
    await ensurePrefixTools(testPrefix);
  });

  test("calls installer when gollum tools are missing from pre-v0.1.4 prefix", async () => {
    // Simulate a pre-v0.1.4 prefix: core tools present, gollum absent
    for (const bin of ["opencode", "uv", "rg"]) {
      writeFileSync(join(testPrefix, "bin", bin), "");
    }

    let installCalled = false;
    const fakeInstaller = async (prefix: string) => {
      installCalled = true;
      // Simulate what installRubyAndGollum produces
      for (const bin of ["ruby", "gem", "gollum"]) {
        writeFileSync(join(prefix, "bin", bin), "");
      }
    };

    await ensurePrefixTools(testPrefix, { installGollum: fakeInstaller });

    expect(installCalled).toBe(true);
    expect(checkPrefixTools(testPrefix)).toHaveLength(0);
  });

  test("throws when installer fails to produce expected binaries", async () => {
    for (const bin of ["opencode", "uv", "rg"]) {
      writeFileSync(join(testPrefix, "bin", bin), "");
    }

    // Installer that does nothing (simulates a failed gem install)
    const brokenInstaller = async () => {};

    await expect(
      ensurePrefixTools(testPrefix, { installGollum: brokenInstaller }),
    ).rejects.toThrow(/still missing tools after upgrade/);
  });
});

describe("buildBootstrapPrompt", () => {
  test("includes user intent in prompt", () => {
    const intent = "managing my personal finances";
    const prompt = buildBootstrapPrompt(intent);

    expect(prompt).toContain(intent);
    expect(prompt).toContain(`"${intent}"`);
  });

  test("includes instructions for installing packages", () => {
    const prompt = buildBootstrapPrompt("data analysis");

    expect(prompt).toContain("uv add");
    expect(prompt).toContain("Install packages");
  });

  test("includes instructions for creating library structure", () => {
    const prompt = buildBootstrapPrompt("web scraping");

    expect(prompt).toContain("src/agent_lib/");
    expect(prompt).toContain("Create library structure");
  });

  test("includes instructions for generating AGENTS.md", () => {
    const prompt = buildBootstrapPrompt("machine learning");

    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("Generate AGENTS.md");
  });

  test("includes AGENTS.md guidelines", () => {
    const prompt = buildBootstrapPrompt("automation");

    expect(prompt).toContain("Project Overview");
    expect(prompt).toContain("Commands");
    expect(prompt).toContain("Tech Stack");
    expect(prompt).toContain("Code Style");
    expect(prompt).toContain("Safety Boundaries");
  });

  test("includes safety boundaries", () => {
    const prompt = buildBootstrapPrompt("testing");

    expect(prompt).toContain("Always do");
    expect(prompt).toContain("Ask first");
    expect(prompt).toContain("Never do");
  });

  test("instructs to interview the user", () => {
    const prompt = buildBootstrapPrompt("deployment");

    expect(prompt).toContain("Interview the User");
  });

});

describe("buildPath", () => {
  const testPrefix = join(tmpdir(), "nightshift-test-buildpath");

  beforeEach(() => {
    // Clean up before each test
    rmSync(testPrefix, { recursive: true, force: true });
    mkdirSync(join(testPrefix, "bin"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testPrefix, { recursive: true, force: true });
  });

  test("includes bin directory", () => {
    const path = buildPath(testPrefix);

    expect(path).toContain(join(testPrefix, "bin"));
  });

  test("includes uv-tools/bin if it exists", () => {
    mkdirSync(join(testPrefix, "uv-tools", "bin"), { recursive: true });

    const path = buildPath(testPrefix);

    expect(path).toContain(join(testPrefix, "uv-tools", "bin"));
  });

  test("does not include uv-tools/bin if it doesn't exist", () => {
    const path = buildPath(testPrefix);

    expect(path).not.toContain("uv-tools");
  });

  test("appends existing PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/usr/local/bin";

    const path = buildPath(testPrefix);

    expect(path).toContain("/usr/bin");
    expect(path).toContain("/usr/local/bin");

    process.env.PATH = originalPath;
  });

  test("uv-tools comes before bin in PATH", () => {
    mkdirSync(join(testPrefix, "uv-tools", "bin"), { recursive: true });

    const path = buildPath(testPrefix);
    const uvToolsIndex = path.indexOf(join(testPrefix, "uv-tools", "bin"));
    const binIndex = path.indexOf(join(testPrefix, "bin"));

    expect(uvToolsIndex).toBeLessThan(binIndex);
  });
});

describe("buildXdgEnv", () => {
  test("creates XDG environment variables", () => {
    const prefix = "/home/user/.nightshift";
    const env = buildXdgEnv(prefix);

    expect(env.XDG_CONFIG_HOME).toBe(posixJoin(prefix, "config"));
    expect(env.XDG_DATA_HOME).toBe(posixJoin(prefix, "share"));
    expect(env.XDG_CACHE_HOME).toBe(posixJoin(prefix, "cache"));
    expect(env.XDG_STATE_HOME).toBe(posixJoin(prefix, "state"));
  });
});

describe("waitForServer", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  test("resolves when server is ready", async () => {
    const port = 19876;
    server = Bun.serve({
      port,
      fetch(req) {
        if (new URL(req.url).pathname === "/global/health") {
          return new Response("OK", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // Should resolve without throwing
    await waitForServer(`http://127.0.0.1:${port}`, 5);
  });

  test("throws when server never becomes ready", async () => {
    const port = 19877; // Port with nothing listening

    await expect(
      waitForServer(`http://127.0.0.1:${port}`, 2)
    ).rejects.toThrow("Server failed to start within timeout");
  });

  test("waits for server to become ready", async () => {
    const port = 19878;
    let requestCount = 0;

    // Server that fails first 2 requests, then succeeds
    server = Bun.serve({
      port,
      fetch(req) {
        requestCount++;
        if (new URL(req.url).pathname === "/global/health") {
          if (requestCount <= 2) {
            return new Response("Not Ready", { status: 503 });
          }
          return new Response("OK", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    await waitForServer(`http://127.0.0.1:${port}`, 10);

    expect(requestCount).toBeGreaterThan(2);
  });
});

describe("bootstrap integration", () => {
  // These tests would require a running opencode server
  // For now, we test the event handling logic in isolation

  test("permission event has expected structure", () => {
    // Mock permission event structure
    const permissionEvent = {
      type: "permission.asked" as const,
      properties: {
        id: "perm-123",
        sessionID: "sess-456",
        permission: "bash",
        patterns: ["uv add pandas"],
        metadata: {
          description: "Install pandas",
        },
        always: [],
      },
    };

    expect(permissionEvent.type).toBe("permission.asked");
    expect(permissionEvent.properties.id).toBeDefined();
    expect(permissionEvent.properties.sessionID).toBeDefined();
    expect(permissionEvent.properties.permission).toBe("bash");
  });

  test("message part event has expected structure", () => {
    // Mock message part event structure
    const partEvent = {
      type: "message.part.updated" as const,
      properties: {
        part: {
          id: "part-123",
          sessionID: "sess-456",
          messageID: "msg-789",
          type: "text" as const,
          text: "Hello, world!",
        },
        delta: "world!",
      },
    };

    expect(partEvent.type).toBe("message.part.updated");
    expect(partEvent.properties.part.type).toBe("text");
    expect(partEvent.properties.delta).toBe("world!");
  });

  test("tool part event has expected structure", () => {
    const toolPartEvent = {
      type: "message.part.updated" as const,
      properties: {
        part: {
          id: "part-456",
          sessionID: "sess-456",
          messageID: "msg-789",
          type: "tool" as const,
          callID: "call-123",
          tool: "bash",
          state: {
            status: "running" as const,
            input: { command: "uv add pandas" },
            title: "Installing pandas",
            time: { start: Date.now() },
          },
        },
      },
    };

    expect(toolPartEvent.properties.part.type).toBe("tool");
    expect(toolPartEvent.properties.part.state.status).toBe("running");
    expect(toolPartEvent.properties.part.tool).toBe("bash");
  });

  test("session idle event has expected structure", () => {
    const idleEvent = {
      type: "session.idle" as const,
      properties: {
        sessionID: "sess-456",
      },
    };

    expect(idleEvent.type).toBe("session.idle");
    expect(idleEvent.properties.sessionID).toBeDefined();
  });
});

// Bootstrap prompt UI tests are in bootstrap-prompt.test.ts

describe("event handling logic", () => {
  test("filters events by session ID", () => {
    const targetSessionId = "sess-target";
    const otherSessionId = "sess-other";

    const events = [
      { type: "permission.asked", properties: { sessionID: targetSessionId, id: "1" } },
      { type: "permission.asked", properties: { sessionID: otherSessionId, id: "2" } },
      { type: "session.idle", properties: { sessionID: targetSessionId } },
      { type: "session.idle", properties: { sessionID: otherSessionId } },
    ];

    const targetEvents = events.filter(
      (e) => (e.properties as any).sessionID === targetSessionId
    );

    expect(targetEvents).toHaveLength(2);
    expect(targetEvents[0].properties.sessionID).toBe(targetSessionId);
    expect(targetEvents[1].properties.sessionID).toBe(targetSessionId);
  });

  test("tracks tool states to avoid duplicates", () => {
    const toolStates = new Map<string, string>();
    const partId = "part-123";

    // First update - running
    const prevState1 = toolStates.get(partId);
    const currentState1 = "running";
    expect(prevState1).toBeUndefined();
    expect(prevState1 !== currentState1).toBe(true);
    toolStates.set(partId, currentState1);

    // Second update - still running (should be filtered)
    const prevState2 = toolStates.get(partId);
    const currentState2 = "running";
    expect(prevState2).toBe("running");
    expect(prevState2 !== currentState2).toBe(false);

    // Third update - completed
    const prevState3 = toolStates.get(partId);
    const currentState3 = "completed";
    expect(prevState3).toBe("running");
    expect(prevState3 !== currentState3).toBe(true);
    toolStates.set(partId, currentState3);
  });

  test("extracts description from permission metadata", () => {
    const getDescription = (request: {
      metadata?: { description?: string; filepath?: string };
      patterns?: string[];
    }) => {
      return (
        request.metadata?.description ||
        request.metadata?.filepath ||
        request.patterns?.[0] ||
        ""
      );
    };

    expect(
      getDescription({ metadata: { description: "Install pandas" } })
    ).toBe("Install pandas");

    expect(
      getDescription({ metadata: { filepath: "/path/to/file.py" } })
    ).toBe("/path/to/file.py");

    expect(getDescription({ patterns: ["*.py"] })).toBe("*.py");

    expect(getDescription({})).toBe("");
  });
});

describe("buildBootstrapPrompt edge cases", () => {
  test("handles empty user intent", () => {
    const prompt = buildBootstrapPrompt("");

    expect(prompt).toContain('""');
    expect(prompt).toContain("uv add");
  });

  test("handles special characters in user intent", () => {
    const intent = 'managing "quotes" and $pecial ch@racters';
    const prompt = buildBootstrapPrompt(intent);

    expect(prompt).toContain(intent);
  });

  test("handles very long user intent", () => {
    const intent = "a".repeat(1000);
    const prompt = buildBootstrapPrompt(intent);

    expect(prompt).toContain(intent);
  });

  test("handles newlines in user intent", () => {
    const intent = "first line\nsecond line";
    const prompt = buildBootstrapPrompt(intent);

    expect(prompt).toContain(intent);
  });
});

describe("waitForServer edge cases", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  test("handles non-200 status codes as not ready", async () => {
    const port = 19879;
    let requestCount = 0;

    server = Bun.serve({
      port,
      fetch(req) {
        requestCount++;
        if (new URL(req.url).pathname === "/global/health") {
          // Return 500 first, then 200
          if (requestCount === 1) {
            return new Response("Error", { status: 500 });
          }
          return new Response("OK", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    await waitForServer(`http://127.0.0.1:${port}`, 5);
    expect(requestCount).toBe(2);
  });

  test("retries on connection refused", async () => {
    const port = 19880;
    let serverStarted = false;

    // Start server after a delay
    setTimeout(() => {
      server = Bun.serve({
        port,
        fetch(req) {
          if (new URL(req.url).pathname === "/global/health") {
            return new Response("OK", { status: 200 });
          }
          return new Response("Not Found", { status: 404 });
        },
      });
      serverStarted = true;
    }, 600);

    await waitForServer(`http://127.0.0.1:${port}`, 10);
    expect(serverStarted).toBe(true);
  });
});
