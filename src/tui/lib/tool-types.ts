// Type exports for tool interfaces used in TUI display
// These are used for type checking tool parts in the UI
// Simplified for client-only mode - just displays what server sends

export namespace Tool {
  export interface Info {
    name: string
    [key: string]: unknown
  }

  // Simplified type inference for TUI display
  export type InferParameters<T> = Record<string, any>
  export type InferMetadata<T> = Record<string, any>
}

// Tool definitions - used with typeof for component props
export const ReadTool = { name: "Read" as const }
export const WriteTool = { name: "Write" as const }
export const EditTool = { name: "Edit" as const }
export const BashTool = { name: "Bash" as const }
export const GlobTool = { name: "Glob" as const }
export const GrepTool = { name: "Grep" as const }
export const ListTool = { name: "LS" as const }
export const ApplyPatchTool = { name: "ApplyPatch" as const }
export const WebFetchTool = { name: "WebFetch" as const }
export const TaskTool = { name: "Task" as const }
export const QuestionTool = { name: "AskFollowupQuestion" as const }
export const TodoWriteTool = { name: "TodoWrite" as const }

// Type aliases for compatibility
export type ReadTool = typeof ReadTool
export type WriteTool = typeof WriteTool
export type EditTool = typeof EditTool
export type BashTool = typeof BashTool
export type GlobTool = typeof GlobTool
export type GrepTool = typeof GrepTool
export type ListTool = typeof ListTool
export type ApplyPatchTool = typeof ApplyPatchTool
export type WebFetchTool = typeof WebFetchTool
export type TaskTool = typeof TaskTool
export type QuestionTool = typeof QuestionTool
export type TodoWriteTool = typeof TodoWriteTool
