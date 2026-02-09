import type { Job, RunStatus } from "./state";

export class RalphClient {
  constructor(private serverUrl: string) {}

  async listJobs(): Promise<Job[]> {
    const res = await fetch(`${this.serverUrl}/jobs`);
    return res.json();
  }

  async createJob(prompt: string): Promise<Job> {
    const res = await fetch(`${this.serverUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    return res.json();
  }

  async updateJob(jobId: string, updates: Partial<Job>): Promise<Job> {
    const res = await fetch(`${this.serverUrl}/jobs/${jobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return res.json();
  }

  async deleteJob(jobId: string): Promise<void> {
    await fetch(`${this.serverUrl}/jobs/${jobId}`, { method: "DELETE" });
  }

  async submitPrompt(prompt: string, jobId?: string): Promise<string> {
    const res = await fetch(`${this.serverUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, jobId }),
    });
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  async getRunStatuses(runIds: string[]): Promise<Record<string, RunStatus>> {
    const res = await fetch(`${this.serverUrl}/runs/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds }),
    });
    return res.json();
  }

  async interruptRun(runId: string, reason: "user_quit" | "user_stop"): Promise<void> {
    await fetch(`${this.serverUrl}/runs/${runId}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  }

  async caffinate(): Promise<void> {
    await fetch(`${this.serverUrl}/caffinate`, { method: "POST" });
  }

  async shutdown(): Promise<void> {
    await fetch(`${this.serverUrl}/shutdown`, { method: "POST" }).catch(() => {});
  }
}
