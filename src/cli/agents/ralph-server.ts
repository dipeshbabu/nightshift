import type { EventBus } from "./bus";
import type { RalphEvent } from "./events";

interface RalphServerOptions {
  port: number;
  bus: EventBus;
  onPrompt: (prompt: string, runId: string) => Promise<void>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startRalphServer(opts: RalphServerOptions) {
  const { port, bus, onPrompt } = opts;

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    routes: {
      "/health": {
        GET: () => Response.json({ status: "ok" }, { headers: CORS_HEADERS }),
      },
      "/prompt": {
        POST: async (req) => {
          let body: { prompt?: string };
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

          // Run asynchronously — don't await
          onPrompt(body.prompt, id).catch((err) => {
            bus.publish({
              type: "ralph.error",
              timestamp: Date.now(),
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
                if (filterRunId && (event.type === "ralph.completed" || event.type === "ralph.error")) {
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
  console.log(`[ralph]   POST /prompt   — start a run`);
  console.log(`[ralph]   GET  /events   — SSE event stream`);
  console.log(`[ralph]   GET  /health   — health check`);

  return server;
}
