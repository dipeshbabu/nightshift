import { createCliRenderer } from "@opentui/core";
import { createState, getJob } from "./state";
import { RalphClient } from "./client";
import { createJobBoard, type JobBoardHandle } from "./job-board";
import { createRunsView, type RunsViewHandle } from "./runs-view";
import { createJobView, type JobViewHandle } from "./job-view";
import type { RalphEvent } from "../../cli/agents/events";

export async function ralphTui(opts: { serverUrl: string }) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const state = createState();
  const client = new RalphClient(opts.serverUrl);

  // Load persisted jobs from server
  try {
    const jobs = await client.listJobs();
    state.jobs = jobs;
    // Mark any jobs still "running" from a previous session as interrupted
    for (const job of state.jobs) {
      if (job.status === "running") {
        job.status = "interrupted";
        await client.updateJob(job.id, { status: "interrupted" });
      }
    }
  } catch {}

  let boardHandle: JobBoardHandle | null = null;
  let runsViewHandle: RunsViewHandle | null = null;
  let viewHandle: JobViewHandle | null = null;

  // Lightweight SSE watchers for jobs running in the background (from the board)
  const bgWatchers = new Map<string, { abort: () => void }>();

  async function quit() {
    // Interrupt all running jobs before exiting
    const running = state.jobs.filter((j) => j.status === "running" && j.runId);
    await Promise.all(running.map((j) => client.interruptRun(j.runId!, "user_quit")));

    for (const w of bgWatchers.values()) w.abort();
    bgWatchers.clear();
    renderer.destroy();
  }

  // Handle SIGINT for graceful quit
  process.on("SIGINT", () => {
    quit();
  });

  function navigate(view: "job-board" | "runs-view" | "job-view", jobId?: string, runId?: string) {
    boardHandle?.unmount();
    boardHandle = null;
    runsViewHandle?.unmount();
    runsViewHandle = null;
    viewHandle?.unmount();
    viewHandle = null;

    state.view = view;

    if (view === "job-board") {
      state.activeJobId = null;
      boardHandle = createJobBoard(renderer, state, client, {
        onViewJob(id) {
          navigate("runs-view", id);
        },
        onRunJob(id) {
          runJob(id);
        },
        onQuit() {
          quit();
        },
      });
      boardHandle.mount();
    } else if (view === "runs-view" && jobId) {
      state.activeJobId = jobId;
      const job = getJob(state, jobId);
      if (!job) {
        navigate("job-board");
        return;
      }

      runsViewHandle = createRunsView(renderer, job, client, {
        onViewRun(selectedRunId) {
          navigate("job-view", jobId, selectedRunId);
        },
        onBack() {
          navigate("job-board");
        },
      });
      runsViewHandle.mount();
    } else if (view === "job-view" && jobId && runId) {
      state.activeJobId = jobId;
      const job = getJob(state, jobId);
      if (!job) {
        navigate("job-board");
        return;
      }

      viewHandle = createJobView(renderer, opts.serverUrl, job, runId, client, {
        onBack() {
          navigate("runs-view", jobId);
        },
        onJobStatusChange(id, status, newRunId) {
          const j = getJob(state, id);
          if (j) {
            j.status = status;
            if (newRunId) {
              j.runId = newRunId;
              if (!j.runIds.includes(newRunId)) {
                j.runIds.push(newRunId);
              }
            }
          }
          if (status === "running" && newRunId) {
            watchJobCompletion(id, newRunId);
          }
        },
      });
      viewHandle.mount();
    }
  }

  async function runJob(jobId: string) {
    const job = getJob(state, jobId);
    if (!job || job.status === "running") return;

    job.status = "running";
    boardHandle?.refresh();

    try {
      const id = await client.submitPrompt(job.prompt, job.id);
      job.runId = id;
      if (!job.runIds.includes(id)) {
        job.runIds.push(id);
      }
      boardHandle?.refresh();

      // If the user already navigated to this job's view, tell it to start streaming
      if (state.view === "job-view" && state.activeJobId === jobId) {
        viewHandle?.startStreaming(id);
      }

      // Start a lightweight SSE watcher to update status on completion
      watchJobCompletion(jobId, id);
    } catch (err) {
      job.status = "error";
      boardHandle?.refresh();
    }
  }

  function watchJobCompletion(jobId: string, runId: string) {
    bgWatchers.get(jobId)?.abort();
    const controller = new AbortController();
    bgWatchers.set(jobId, { abort: () => controller.abort() });

    (async () => {
      try {
        const res = await fetch(`${opts.serverUrl}/events?runId=${runId}`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          updateJobStatus(jobId, "error");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          const frames = sseBuffer.split("\n\n");
          sseBuffer = frames.pop()!;

          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const event: RalphEvent = JSON.parse(line.slice(6));
                  if (event.type === "ralph.completed") {
                    updateJobStatus(jobId, "completed");
                    return;
                  }
                  if (event.type === "ralph.error") {
                    updateJobStatus(jobId, "error");
                    return;
                  }
                  if (event.type === "ralph.interrupted") {
                    updateJobStatus(jobId, "interrupted");
                    return;
                  }
                } catch {}
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        updateJobStatus(jobId, "error");
      } finally {
        bgWatchers.delete(jobId);
      }
    })();
  }

  function updateJobStatus(jobId: string, status: "completed" | "error" | "interrupted") {
    const job = getJob(state, jobId);
    if (job) {
      job.status = status;
      if (state.view === "job-board") {
        boardHandle?.refresh();
      } else if (state.view === "runs-view" && state.activeJobId === jobId) {
        runsViewHandle?.refresh();
      }
    }
  }

  navigate("job-board");
}
