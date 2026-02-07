export namespace Snapshot {
  export interface FileDiff {
    path: string
    oldPath?: string
    status: "added" | "modified" | "deleted" | "renamed"
    hunks: Hunk[]
  }

  export interface Hunk {
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
    lines: Line[]
  }

  export interface Line {
    type: "context" | "add" | "remove"
    content: string
  }
}
