import type { RalphEvent } from "../../cli/agents/events";
import { formatEvent } from "./format";
import type { OutputBuffer } from "./output";
import { extname } from "node:path";

const EXT_TO_FILETYPE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".md": "markdown",
  ".sh": "bash",
  ".bash": "bash",
};

function inferFiletype(tool: string, input?: unknown, metadata?: Record<string, unknown>): string | undefined {
  // Try to get file path from input or metadata
  const filePath = (input as any)?.filePath as string | undefined;
  if (filePath) {
    const ext = extname(filePath);
    return EXT_TO_FILETYPE[ext];
  }
  // For apply_patch, try the first file in metadata.files
  const files = metadata?.files as Array<{ filePath?: string; relativePath?: string }> | undefined;
  if (files?.[0]) {
    const p = files[0].relativePath || files[0].filePath;
    if (p) return EXT_TO_FILETYPE[extname(p)];
  }
  return undefined;
}

export interface StreamCallbacks {
  onEnd: () => void;
}

export interface StreamHandle {
  abort: () => void;
}

/**
 * Render a single event into the output buffer.
 * Shared by both live streaming and persisted-event replay.
 */
export function renderEvent(event: RalphEvent, buf: OutputBuffer) {
  if (event.type === "session.text.delta") {
    buf.appendTextDelta(event.delta);
    return;
  }

  buf.flush();

  // Render apply_patch / edit diffs with the DiffRenderable
  if (event.type === "session.tool.status" && event.status === "completed") {
    const diff = event.metadata?.diff as string | undefined;
    if ((event.tool === "apply_patch" || event.tool === "edit") && diff) {
      const title = event.detail || event.tool;
      const duration = event.duration;
      let header = `✓ ${title}`;
      if (duration !== undefined) header += ` (${duration.toFixed(1)}s)`;
      buf.appendLine(header);
      const filetype = inferFiletype(event.tool, event.input, event.metadata);
      buf.appendDiff(diff, filetype);
      return;
    }
  }

  const formatted = formatEvent(event);
  if (formatted) buf.appendLine(formatted);
}

export function streamEvents(
  serverUrl: string,
  runId: string,
  buf: OutputBuffer,
  callbacks: StreamCallbacks,
): StreamHandle {
  const controller = new AbortController();
  let ended = false;

  function endStream() {
    if (ended) return;
    ended = true;
    controller.abort();
    buf.flush();
    callbacks.onEnd();
  }

  function handleEvent(event: RalphEvent) {
    renderEvent(event, buf);

    if (event.type === "ralph.completed" || event.type === "ralph.error" || event.type === "ralph.interrupted") {
      endStream();
    }
  }

  (async () => {
    try {
      const res = await fetch(`${serverUrl}/events?runId=${runId}`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        buf.appendLine(`[error] SSE connection failed: ${res.status}`);
        endStream();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      function processFrames(raw: string) {
        const frames = raw.split("\n\n");
        sseBuffer = frames.pop()!;

        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const event: RalphEvent = JSON.parse(line.slice(6));
                handleEvent(event);
              } catch {}
            }
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        processFrames(sseBuffer);
      }

      // Process any remaining data after stream closes
      if (sseBuffer.trim()) {
        sseBuffer += "\n\n";
        processFrames(sseBuffer);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      buf.appendLine("[connection lost]");
    } finally {
      endStream();
    }
  })();

  return { abort: () => endStream() };
}
