import { join } from "path";
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import type { EventBus } from "./bus";
import type { RalphEvent } from "./events";

type JobStatus = "draft" | "running" | "completed" | "error" | "interrupted";
type RunStatus = "running" | "completed" | "error" | "interrupted" | "unknown";

interface JobFile {
  id: string;
  prompt: string;
  status: JobStatus;
  runId: string | null;
  runIds: string[];
  createdAt: number;
}

interface RalphServerOptions {
  port: number;
  bus: EventBus;
  prefix: string;
  onPrompt: (prompt: string, runId: string) => Promise<void>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getRunStatus(runsDir: string, runId: string): RunStatus {
  const file = join(runsDir, runId, "events.jsonl");
  if (!existsSync(file)) return "unknown";
  const content = readFileSync(file, "utf-8").trimEnd();
  if (!content) return "running";
  const lastLine = content.slice(content.lastIndexOf("\n") + 1);
  try {
    const event = JSON.parse(lastLine);
    if (event.type === "ralph.completed") return "completed";
    if (event.type === "ralph.error") return "error";
    if (event.type === "ralph.interrupted") return "interrupted";
  } catch {}
  return "running";
}

function readJobFile(jobsDir: string, jobId: string): JobFile | null {
  const path = join(jobsDir, `${jobId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJobFile(jobsDir: string, job: JobFile): void {
  writeFileSync(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2) + "\n");
}

function listJobFiles(jobsDir: string): JobFile[] {
  if (!existsSync(jobsDir)) return [];
  const files = readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
  const jobs: JobFile[] = [];
  for (const f of files) {
    try {
      jobs.push(JSON.parse(readFileSync(join(jobsDir, f), "utf-8")));
    } catch {}
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
}

export function startRalphServer(opts: RalphServerOptions) {
  const { port, bus, prefix, onPrompt } = opts;
  const runsDir = join(prefix, "runs");
  const jobsDir = join(prefix, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  // Track which runId directories have been created
  const createdDirs = new Set<string>();

  // Map runId -> jobId for auto-updating job status on terminal events
  const runIdToJobId = new Map<string, string>();

  // Persist every event to disk as JSONL
  bus.subscribeAll((event: RalphEvent) => {
    if (!event.runId) return;
    const runDir = join(runsDir, event.runId);
    if (!createdDirs.has(event.runId)) {
      mkdirSync(runDir, { recursive: true });
      createdDirs.add(event.runId);
    }
    appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n");

    // Auto-update job status on terminal events
    if (
      event.type === "ralph.completed" ||
      event.type === "ralph.error" ||
      event.type === "ralph.interrupted"
    ) {
      const jobId = runIdToJobId.get(event.runId);
      if (jobId) {
        const job = readJobFile(jobsDir, jobId);
        if (job) {
          if (event.type === "ralph.completed") job.status = "completed";
          else if (event.type === "ralph.error") job.status = "error";
          else if (event.type === "ralph.interrupted") job.status = "interrupted";
          writeJobFile(jobsDir, job);
        }
        runIdToJobId.delete(event.runId);
      }
    }
  });

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    routes: {
      "/health": {
        GET: () => Response.json({ status: "ok" }, { headers: CORS_HEADERS }),
      },

      // --- Job CRUD ---
      "/jobs": {
        GET: () => {
          const jobs = listJobFiles(jobsDir);
          return Response.json(jobs, { headers: CORS_HEADERS });
        },
        POST: async (req) => {
          let body: { prompt?: string };
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
          }
          if (!body.prompt || typeof body.prompt !== "string") {
            return Response.json({ error: "Missing 'prompt' string field" }, { status: 400, headers: CORS_HEADERS });
          }
          const job: JobFile = {
            id: crypto.randomUUID(),
            prompt: body.prompt,
            status: "draft",
            runId: null,
            runIds: [],
            createdAt: Date.now(),
          };
          writeJobFile(jobsDir, job);
          return Response.json(job, { status: 201, headers: CORS_HEADERS });
        },
        OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      },
      "/jobs/:jobId": {
        GET: (req) => {
          const job = readJobFile(jobsDir, req.params.jobId);
          if (!job) return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
          return Response.json(job, { headers: CORS_HEADERS });
        },
        PUT: async (req) => {
          const job = readJobFile(jobsDir, req.params.jobId);
          if (!job) return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
          let updates: Partial<JobFile>;
          try {
            updates = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
          }
          if (updates.prompt !== undefined) job.prompt = updates.prompt;
          if (updates.status !== undefined) job.status = updates.status;
          if (updates.runId !== undefined) job.runId = updates.runId;
          if (updates.runIds !== undefined) job.runIds = updates.runIds;
          writeJobFile(jobsDir, job);
          return Response.json(job, { headers: CORS_HEADERS });
        },
        DELETE: (req) => {
          const path = join(jobsDir, `${req.params.jobId}.json`);
          if (!existsSync(path)) return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
          unlinkSync(path);
          return Response.json({ ok: true }, { headers: CORS_HEADERS });
        },
        OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      },

      // --- Run lifecycle ---
      "/runs/status": {
        POST: async (req) => {
          let body: { runIds?: string[] };
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
          }
          if (!Array.isArray(body.runIds)) {
            return Response.json({ error: "Missing 'runIds' array" }, { status: 400, headers: CORS_HEADERS });
          }
          const statuses: Record<string, RunStatus> = {};
          for (const runId of body.runIds) {
            statuses[runId] = getRunStatus(runsDir, runId);
          }
          return Response.json(statuses, { headers: CORS_HEADERS });
        },
        OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      },
      "/runs/:runId/interrupt": {
        POST: async (req) => {
          const { runId } = req.params;
          let body: { reason?: string } = {};
          try {
            body = await req.json();
          } catch {}
          const reason = body.reason === "user_stop" ? "user_stop" : "user_quit";
          const event: RalphEvent = {
            type: "ralph.interrupted",
            timestamp: Date.now(),
            runId,
            reason,
          };
          // Publish on bus (which will persist to JSONL and auto-update job)
          bus.publish(event);
          return Response.json({ ok: true }, { headers: CORS_HEADERS });
        },
        OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      },

      // --- Prompt (modified to accept jobId) ---
      "/prompt": {
        POST: async (req) => {
          let body: { prompt?: string; jobId?: string };
          try {
            body = await req.json();
          } catch {
            return Response.json(
              { error: "Invalid JSON" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          if (!body.prompt || typeof body.prompt !== "string") {
            return Response.json(
              { error: "Missing 'prompt' string field" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          const id = crypto.randomUUID();

          // If jobId provided, update the job file
          if (body.jobId) {
            const job = readJobFile(jobsDir, body.jobId);
            if (job) {
              job.status = "running";
              job.runId = id;
              if (!job.runIds.includes(id)) job.runIds.push(id);
              writeJobFile(jobsDir, job);
              runIdToJobId.set(id, body.jobId);
            }
          }

          // Run asynchronously — don't await
          onPrompt(body.prompt, id).catch((err) => {
            bus.publish({
              type: "ralph.error",
              timestamp: Date.now(),
              runId: id,
              error: String(err),
            });
          });

          return Response.json(
            { status: "started", id },
            { status: 202, headers: CORS_HEADERS },
          );
        },
        OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      },

      // --- Persisted events replay ---
      "/runs/:runId/events": {
        GET: (req) => {
          const runId = req.params.runId;
          const eventsFile = join(runsDir, runId, "events.jsonl");
          if (!existsSync(eventsFile)) {
            return Response.json([], { headers: CORS_HEADERS });
          }
          const content = readFileSync(eventsFile, "utf-8");
          const events = content.trim().split("\n").filter(Boolean).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          return Response.json(events, { headers: CORS_HEADERS });
        },
      },

      // --- SSE event stream ---
      "/events": {
        GET: (req) => {
          const url = new URL(req.url);
          const filterRunId = url.searchParams.get("runId");

          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();

              const cleanup = () => {
                unsub();
                clearInterval(heartbeat);
                try { controller.close(); } catch {}
              };

              const unsub = bus.subscribeAll((event: RalphEvent) => {
                if (filterRunId && event.runId !== filterRunId) return;

                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch {
                  cleanup();
                  return;
                }

                // Auto-close when the filtered run is done
                if (filterRunId && (
                  event.type === "ralph.completed" ||
                  event.type === "ralph.error" ||
                  event.type === "ralph.interrupted"
                )) {
                  cleanup();
                }
              });

              // Send a comment every 5s to keep the connection alive
              const heartbeat = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(`: keepalive\n\n`));
                } catch {
                  cleanup();
                }
              }, 5_000);

              // Clean up on client disconnect
              req.signal.addEventListener("abort", () => cleanup());
            },
          });

          return new Response(stream, {
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        },
      },
    },
  });

  console.log(`[ralph] HTTP server listening on http://localhost:${port}`);
  console.log(`[ralph]   POST /prompt              — start a run`);
  console.log(`[ralph]   GET  /events              — SSE event stream`);
  console.log(`[ralph]   GET  /runs/:runId/events  — replay persisted events`);
  console.log(`[ralph]   POST /runs/:runId/interrupt — interrupt a run`);
  console.log(`[ralph]   POST /runs/status         — batch run status`);
  console.log(`[ralph]   CRUD /jobs                — job persistence`);
  console.log(`[ralph]   GET  /health              — health check`);

  return server;
}
