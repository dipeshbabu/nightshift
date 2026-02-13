import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createBus } from "../../cli/agents/bus";
import { startRalphServer } from "../../cli/agents/ralph-server";
import { RalphClient } from "./client";
import type { EventBus } from "../../cli/agents/bus";

let tmpDir: string;
let bus: EventBus;
let server: ReturnType<typeof startRalphServer>;
let client: RalphClient;
let caffinateExitCalls: number;

beforeEach(() => {
  tmpDir = join("/tmp", `ralph-client-test-${crypto.randomUUID()}`);
  mkdirSync(join(tmpDir, "jobs"), { recursive: true });
  mkdirSync(join(tmpDir, "runs"), { recursive: true });
  bus = createBus();
  caffinateExitCalls = 0;
  server = startRalphServer({
    port: 0,
    bus,
    prefix: tmpDir,
    onPrompt: async () => {},
    onCaffinateExit: () => { caffinateExitCalls++; },
  });
  client = new RalphClient(`http://localhost:${server.port}`);
});

afterEach(() => {
  server.stop(true);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("caffinate() calls POST /caffinate successfully", async () => {
  await client.caffinate();
  // With no jobs, caffeinate triggers immediate exit
  expect(caffinateExitCalls).toBe(1);
});

test("shutdown() calls POST /shutdown without throwing", async () => {
  const exitCalls: number[] = [];
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
  }) as any;

  try {
    await client.shutdown();
    await new Promise((r) => setTimeout(r, 100));
    expect(exitCalls).toHaveLength(1);
  } finally {
    process.exit = originalExit;
  }
});

test("caffinate() + job completion triggers auto-exit via client", async () => {
  // Create and start a job
  const job = await client.createJob("test prompt");
  const runId = await client.submitPrompt("test prompt", job.id);

  await client.caffinate();
  expect(caffinateExitCalls).toBe(0);

  // Complete the job via bus
  bus.publish({
    type: "ralph.completed",
    timestamp: Date.now(),
    runId,
    iterations: 1,
    done: true,
  });

  expect(caffinateExitCalls).toBe(1);
});
