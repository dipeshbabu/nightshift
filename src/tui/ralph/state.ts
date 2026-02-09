export type JobStatus = "draft" | "running" | "completed" | "error" | "interrupted";
export type RunStatus = "running" | "completed" | "error" | "interrupted" | "unknown";

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  runId: string | null;
  runIds: string[];
  createdAt: number;
}

export interface AppState {
  view: "job-board" | "runs-view" | "job-view";
  activeJobId: string | null;
  jobs: Job[];
  boardFocus: "list" | "editor";
  editingJobId: string | null;
}

export function createState(): AppState {
  return {
    view: "job-board",
    activeJobId: null,
    jobs: [],
    boardFocus: "list",
    editingJobId: null,
  };
}

export function getJob(state: AppState, id: string): Job | undefined {
  return state.jobs.find((j) => j.id === id);
}

export function hasRunningJobs(state: AppState): boolean {
  return state.jobs.some((j) => j.status === "running");
}
