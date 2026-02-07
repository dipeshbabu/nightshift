// Type wrapper for command definitions - just returns input for passthrough
export function cmd<T>(input: T): T {
  return input
}
