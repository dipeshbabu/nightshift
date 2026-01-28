const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
const dateFormatter = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "numeric",
})

export namespace Locale {
  export function relative(timestamp: number): string {
    const now = Date.now()
    const diff = timestamp - now
    const seconds = Math.round(diff / 1000)
    const minutes = Math.round(seconds / 60)
    const hours = Math.round(minutes / 60)
    const days = Math.round(hours / 24)

    if (Math.abs(seconds) < 60) {
      return relativeFormatter.format(seconds, "second")
    }
    if (Math.abs(minutes) < 60) {
      return relativeFormatter.format(minutes, "minute")
    }
    if (Math.abs(hours) < 24) {
      return relativeFormatter.format(hours, "hour")
    }
    return relativeFormatter.format(days, "day")
  }

  export function time(timestamp: number): string {
    return dateFormatter.format(new Date(timestamp))
  }

  export function format(timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  export function titlecase(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
  }

  export function datetime(timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str
    return str.slice(0, maxLength - 3) + "..."
  }

  export function truncateMiddle(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str
    const half = Math.floor((maxLength - 3) / 2)
    return str.slice(0, half) + "..." + str.slice(-half)
  }

  export function pluralize(count: number, singular: string, plural?: string): string {
    return count === 1 ? singular : (plural ?? singular + "s")
  }

  export function todayTimeOrDateTime(timestamp: number): string {
    const date = new Date(timestamp)
    const today = new Date()
    if (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    ) {
      return dateFormatter.format(date)
    }
    return new Date(timestamp).toLocaleString()
  }

  export function duration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (minutes < 60) {
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
    }
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return `${hours}h ${remainingMinutes}m`
  }

  const numberFormatter = new Intl.NumberFormat("en")

  export function number(value: number): string {
    return numberFormatter.format(value)
  }
}
