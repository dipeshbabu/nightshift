// Lazy initialization utility

export function lazy<T>(fn: () => T): () => T {
  let value: T | undefined
  let initialized = false
  return () => {
    if (!initialized) {
      value = fn()
      initialized = true
    }
    return value!
  }
}
