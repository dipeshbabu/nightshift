export function formatDuration(seconds: number): string {
  if (seconds < 0) return ""
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`
  }
  return `${hours}h`
}
