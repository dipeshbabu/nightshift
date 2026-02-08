// Discriminated union event types for ralph event stream

interface BaseEvent {
  timestamp: number;
  runId?: string;
}

export interface RalphStartedEvent extends BaseEvent {
  type: "ralph.started";
  workspace: string;
  agentModel: string;
  evalModel: string;
}

export interface RalphCompletedEvent extends BaseEvent {
  type: "ralph.completed";
  iterations: number;
  done: boolean;
}

export interface RalphErrorEvent extends BaseEvent {
  type: "ralph.error";
  error: string;
}

export interface ServerReadyEvent extends BaseEvent {
  type: "server.ready";
  name: string;
  port: number;
  reused: boolean;
}

export interface ServerCleanupEvent extends BaseEvent {
  type: "server.cleanup";
  name: string;
  pid: number;
}

export interface LoopIterationStartEvent extends BaseEvent {
  type: "loop.iteration.start";
  iteration: number;
}

export interface LoopDoneEvent extends BaseEvent {
  type: "loop.done";
  iteration: number;
}

export interface LoopNotDoneEvent extends BaseEvent {
  type: "loop.not_done";
  iteration: number;
  feedback: string;
}

export interface LoopMaxIterationsEvent extends BaseEvent {
  type: "loop.max_iterations";
  maxIterations: number;
}

export interface WorkerStartEvent extends BaseEvent {
  type: "worker.start";
  commitHash: string;
}

export interface WorkerCompleteEvent extends BaseEvent {
  type: "worker.complete";
  commitHash: string;
  logPath?: string;
}

export interface BossStartEvent extends BaseEvent {
  type: "boss.start";
  commitHash: string;
}

export interface BossCompleteEvent extends BaseEvent {
  type: "boss.complete";
  commitHash: string;
  done: boolean;
  logPath?: string;
}

export interface SessionTextDeltaEvent extends BaseEvent {
  type: "session.text.delta";
  phase: "executor" | "validator";
  delta: string;
}

export interface SessionToolStatusEvent extends BaseEvent {
  type: "session.tool.status";
  phase: "executor" | "validator";
  tool: string;
  status: "running" | "completed" | "error";
  detail?: string;
  input?: unknown;
  output?: string;
  duration?: number;
}

export interface SessionPermissionEvent extends BaseEvent {
  type: "session.permission";
  phase: "executor" | "validator";
  permission: string;
  description: string;
}

export type RalphEvent =
  | RalphStartedEvent
  | RalphCompletedEvent
  | RalphErrorEvent
  | ServerReadyEvent
  | ServerCleanupEvent
  | LoopIterationStartEvent
  | LoopDoneEvent
  | LoopNotDoneEvent
  | LoopMaxIterationsEvent
  | WorkerStartEvent
  | WorkerCompleteEvent
  | BossStartEvent
  | BossCompleteEvent
  | SessionTextDeltaEvent
  | SessionToolStatusEvent
  | SessionPermissionEvent;

export type RalphEventType = RalphEvent["type"];
