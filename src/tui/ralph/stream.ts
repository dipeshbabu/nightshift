import type { RalphEvent } from "../../cli/agents/events";
import { formatEvent } from "./format";
import type { OutputBuffer } from "./output";

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

    if (event.type === "ralph.completed" || event.type === "ralph.error") {
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
