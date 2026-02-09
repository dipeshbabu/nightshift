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
  view: "job-board" | "runs-view" | "job-view" | "boot-board" | "boot-runs-view" | "boot-view";
  activeJobId: string | null;
  jobs: Job[];
  boardFocus: "list" | "editor";
  editingJobId: string | null;
  boots: Job[];
  bootBoardFocus: "list" | "editor";
  editingBootId: string | null;
  activeBootId: string | null;
}

export function createState(): AppState {
  return {
    view: "job-board",
    activeJobId: null,
    jobs: [],
    boardFocus: "list",
    editingJobId: null,
    boots: [],
    bootBoardFocus: "list",
    editingBootId: null,
    activeBootId: null,
  };
}

export function getJob(state: AppState, id: string): Job | undefined {
  return state.jobs.find((j) => j.id === id);
}

export function hasRunningJobs(state: AppState): boolean {
  return state.jobs.some((j) => j.status === "running");
}

export function getBoot(state: AppState, id: string): Job | undefined {
  return state.boots.find((j) => j.id === id);
}

export function hasRunningBoots(state: AppState): boolean {
  return state.boots.some((j) => j.status === "running");
}
