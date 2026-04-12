/**
 * Telnyx SMS/MMS Channel — Event Log
 *
 * In-memory ring buffer tracking the last N send/receive events.
 * Each event records: timestamp, direction, phone number, status, error details.
 * Used for diagnostics in the channel status panel and admin review.
 */

export type SmsEventDirection = "inbound" | "outbound";
export type SmsEventStatus = "success" | "error" | "dropped" | "pending-approval";

export interface SmsEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** inbound = received, outbound = sent */
  direction: SmsEventDirection;
  /** E.164 phone number of the remote party */
  phoneNumber: string;
  /** Outcome of the event */
  status: SmsEventStatus;
  /** Telnyx message ID (if available) */
  messageId?: string;
  /** Short text preview (first 80 chars) */
  preview?: string;
  /** Error message if status === "error" */
  error?: string;
  /** HTTP status code from Telnyx API (outbound only) */
  httpStatus?: number;
  /** Drop reason if status === "dropped" */
  dropReason?: string;
}

const DEFAULT_MAX_EVENTS = 20;

class SmsEventLog {
  private events: SmsEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = DEFAULT_MAX_EVENTS) {
    this.maxEvents = maxEvents;
  }

  /** Record a new event, evicting oldest if at capacity. */
  record(event: Omit<SmsEvent, "timestamp">): SmsEvent {
    const full: SmsEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    return full;
  }

  /** Get the last N events (most recent first). */
  recent(count = 5): SmsEvent[] {
    return this.events.slice(-count).reverse();
  }

  /** Get all stored events (most recent first). */
  all(): SmsEvent[] {
    return [...this.events].reverse();
  }

  /** Get events filtered by direction. */
  byDirection(direction: SmsEventDirection, count = 5): SmsEvent[] {
    return this.events
      .filter((e) => e.direction === direction)
      .slice(-count)
      .reverse();
  }

  /** Get events filtered by status. */
  byStatus(status: SmsEventStatus, count = 5): SmsEvent[] {
    return this.events
      .filter((e) => e.status === status)
      .slice(-count)
      .reverse();
  }

  /** Format events as human-readable lines for status display. */
  formatRecent(count = 5): string[] {
    return this.recent(count).map((e) => {
      const dir = e.direction === "inbound" ? "⬇ IN" : "⬆ OUT";
      const time = e.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
      const status =
        e.status === "success"
          ? "✓"
          : e.status === "error"
            ? `✗ ${e.error ?? "unknown"}`
            : e.status === "dropped"
              ? `⊘ ${e.dropReason ?? "dropped"}`
              : "⏳ pending";
      const preview = e.preview ? ` "${e.preview}"` : "";
      return `${time} ${dir} ${e.phoneNumber} ${status}${preview}`;
    });
  }

  /** Clear all events. */
  clear(): void {
    this.events = [];
  }
}

/** Singleton event log instance shared across the extension. */
export const smsEventLog = new SmsEventLog(DEFAULT_MAX_EVENTS);
