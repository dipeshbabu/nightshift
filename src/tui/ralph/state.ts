export type JobStatus = "draft" | "running" | "completed" | "error";

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  runId: string | null;
  createdAt: number;
}

export interface AppState {
  view: "job-board" | "job-view";
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

export function addJob(state: AppState, prompt: string): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    prompt,
    status: "draft",
    runId: null,
    createdAt: Date.now(),
  };
  state.jobs.push(job);
  return job;
}

export function getJob(state: AppState, id: string): Job | undefined {
  return state.jobs.find((j) => j.id === id);
}

export function removeJob(state: AppState, id: string): void {
  state.jobs = state.jobs.filter((j) => j.id !== id);
}

export function hasRunningJobs(state: AppState): boolean {
  return state.jobs.some((j) => j.status === "running");
}
