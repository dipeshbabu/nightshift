import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createBus } from "./bus";
import { startRalphServer } from "./ralph-server";
import type { EventBus } from "./bus";

let tmpDir: string;
let bus: EventBus;
let server: ReturnType<typeof startRalphServer>;
let baseUrl: string;
let caffinateExitCalls: number;

beforeEach(() => {
  tmpDir = join("/tmp", `ralph-test-${crypto.randomUUID()}`);
  mkdirSync(join(tmpDir, "jobs"), { recursive: true });
  mkdirSync(join(tmpDir, "runs"), { recursive: true });
  bus = createBus();
  caffinateExitCalls = 0;
  const port = 10000 + Math.floor(Math.random() * 50000);
  server = startRalphServer({
    port,
    bus,
    prefix: tmpDir,
    onPrompt: async () => {},
    onCaffinateExit: () => { caffinateExitCalls++; },
  });
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => {
  server.stop(true);
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- /health ---

test("GET /health returns ok", async () => {
  const res = await fetch(`${baseUrl}/health`);
  expect(res.ok).toBe(true);
  const body = await res.json();
  expect(body.status).toBe("ok");
});

// --- /caffinate endpoint ---

test("POST /caffinate returns ok", async () => {
  // Immediate exit since no jobs running — captured by callback
  const res = await fetch(`${baseUrl}/caffinate`, { method: "POST" });
  expect(res.ok).toBe(true);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("caffinate immediately triggers exit when no jobs are running", async () => {
  await fetch(`${baseUrl}/caffinate`, { method: "POST" });
  expect(caffinateExitCalls).toBe(1);
});

test("caffinate does not exit while jobs are still running", async () => {
  // Create a running job
  const createRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "test job" }),
  });
  const job = await createRes.json();
  await fetch(`${baseUrl}/jobs/${job.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "running" }),
  });

  await fetch(`${baseUrl}/caffinate`, { method: "POST" });

  // Should NOT exit — a job is still running
  expect(caffinateExitCalls).toBe(0);

  // Server should still be alive
  const healthRes = await fetch(`${baseUrl}/health`);
  expect(healthRes.ok).toBe(true);
});

test("caffeinated daemon auto-exits when last running job completes", async () => {
  // Create a job and start a run
  const createRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "auto-exit test" }),
  });
  const job = await createRes.json();

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "auto-exit test", jobId: job.id }),
  });
  const { id: runId } = await promptRes.json();

  // Caffinate
  await fetch(`${baseUrl}/caffinate`, { method: "POST" });
  expect(caffinateExitCalls).toBe(0);

  // Simulate job completion via bus event
  bus.publish({
    type: "ralph.completed",
    timestamp: Date.now(),
    runId,
    iterations: 1,
    done: true,
  });

  expect(caffinateExitCalls).toBe(1);
});

test("caffeinated auto-exit triggers on ralph.error", async () => {
  const createRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "error test" }),
  });
  const job = await createRes.json();

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "error test", jobId: job.id }),
  });
  const { id: runId } = await promptRes.json();

  await fetch(`${baseUrl}/caffinate`, { method: "POST" });
  expect(caffinateExitCalls).toBe(0);

  bus.publish({
    type: "ralph.error",
    timestamp: Date.now(),
    runId,
    error: "something broke",
  });

  expect(caffinateExitCalls).toBe(1);
});

test("caffeinated auto-exit triggers on ralph.interrupted", async () => {
  const createRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "interrupt test" }),
  });
  const job = await createRes.json();

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "interrupt test", jobId: job.id }),
  });
  const { id: runId } = await promptRes.json();

  await fetch(`${baseUrl}/caffinate`, { method: "POST" });
  expect(caffinateExitCalls).toBe(0);

  bus.publish({
    type: "ralph.interrupted",
    timestamp: Date.now(),
    runId,
    reason: "user_stop",
  });

  expect(caffinateExitCalls).toBe(1);
});

test("without caffinate, terminal events do NOT trigger exit", async () => {
  const createRes = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "no caffinate" }),
  });
  const job = await createRes.json();

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "no caffinate", jobId: job.id }),
  });
  const { id: runId } = await promptRes.json();

  // Do NOT call /caffinate

  bus.publish({
    type: "ralph.completed",
    timestamp: Date.now(),
    runId,
    iterations: 1,
    done: true,
  });

  expect(caffinateExitCalls).toBe(0);
});

test("caffeinated waits until ALL jobs finish before exiting", async () => {
  // Create two jobs
  const res1 = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "job 1" }),
  });
  const job1 = await res1.json();

  const res2 = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "job 2" }),
  });
  const job2 = await res2.json();

  // Start both
  const p1 = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "job 1", jobId: job1.id }),
  });
  const { id: runId1 } = await p1.json();

  const p2 = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "job 2", jobId: job2.id }),
  });
  const { id: runId2 } = await p2.json();

  await fetch(`${baseUrl}/caffinate`, { method: "POST" });

  // Complete job 1 — job 2 still running
  bus.publish({
    type: "ralph.completed",
    timestamp: Date.now(),
    runId: runId1,
    iterations: 1,
    done: true,
  });
  expect(caffinateExitCalls).toBe(0);

  // Complete job 2 — now all done
  bus.publish({
    type: "ralph.completed",
    timestamp: Date.now(),
    runId: runId2,
    iterations: 1,
    done: true,
  });
  expect(caffinateExitCalls).toBe(1);
});

// --- /shutdown endpoint ---

test("POST /shutdown returns ok and triggers process.exit", async () => {
  const exitCalls: number[] = [];
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
  }) as any;

  try {
    const res = await fetch(`${baseUrl}/shutdown`, { method: "POST" });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Wait for the deferred process.exit
    await new Promise((r) => setTimeout(r, 100));
    expect(exitCalls).toHaveLength(1);
    expect(exitCalls[0]).toBe(0);
  } finally {
    process.exit = originalExit;
  }
});
