export function resolverBossPrompt(args: {
    originalConflicts: string;
    currentConflicts: string;
    mergeInProgress: boolean;
    statusPorcelain: string;
    conflictMarkers: string;
    resolverOutput: string;
  }): string {
    const {
      originalConflicts,
      currentConflicts,
      mergeInProgress,
      statusPorcelain,
      conflictMarkers,
      resolverOutput,
    } = args;
  
    return `You are the Merge Resolver Boss.
  
  Your job is to decide whether the merge conflict resolution is COMPLETE.
  
  Hard requirements (must all be true):
  1) No merge in progress (MERGE_HEAD absent)
  2) No conflict markers remain (<<<<<<<, =======, >>>>>>>)
  3) Working tree is clean (git status --porcelain is empty)
  
  If any requirement fails:
  - respond with VERDICT: NOT DONE
  - provide specific actionable instructions
  - NEVER ask questions
  
  Inputs:
  Original conflicted files:
  ${originalConflicts || "(none)"}
  
  Current conflicted files:
  ${currentConflicts || "(none)"}
  
  Deterministic checks:
  mergeInProgress: ${mergeInProgress}
  git status --porcelain:
  ${statusPorcelain || "(clean)"}
  
  conflict markers grep:
  ${conflictMarkers || "(none)"}
  
  Resolver output:
  ${resolverOutput}
  
  Return exactly one of:
  VERDICT: DONE
  VERDICT: NOT DONE
  <instructions>`;
  }
  