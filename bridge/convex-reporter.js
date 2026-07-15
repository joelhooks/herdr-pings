/**
 * Optional, memory-only delivery to the local Convex pane event endpoint.
 * It deliberately never reads or writes herdr-pings spool files.
 */
const DEFAULT_MAX_BUFFERED_EVENTS = 100;
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_FLUSH_DELAY_MS = 250;
const SUMMARY_LIMIT = 280;

function configuredEndpoint(url = process.env.HERDR_PINGS_CONVEX_URL) {
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  return base ? `${base}/herdr-pings/ingest` : undefined;
}

function boundedSummary(value) {
  if (typeof value !== "string") return undefined;
  const firstLine = value.trim().split("\n", 1)[0];
  return firstLine ? firstLine.slice(0, SUMMARY_LIMIT) : undefined;
}

function asNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function paneEvent(kind, data = {}) {
  const paneId = typeof data.pane_id === "string" ? data.pane_id.trim() : "";
  if (!paneId) return undefined;

  const event = {
    eventId: crypto.randomUUID(),
    kind,
    paneId,
    timestamp: Date.now(),
  };
  const stringFields = [
    ["session", "session"],
    ["workspaceId", "workspace_id"],
    ["tabId", "tab_id"],
    ["label", "label"],
    ["agentKind", "agent"],
    ["status", "agent_status"],
    ["error", "error"],
  ];
  for (const [target, source] of stringFields) {
    if (typeof data[source] === "string" && data[source].trim()) {
      event[target] = data[source].trim().slice(0, SUMMARY_LIMIT);
    }
  }
  if ((kind === "pane_closed" || kind === "pane_exited") && !event.status) {
    event.status = "closed";
  }
  for (const [target, source] of [
    ["turnIndex", "turn_index"],
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["cacheReadTokens", "cache_read_tokens"],
    ["totalTokens", "total_tokens"],
  ]) {
    const value = asNonNegativeInteger(data[source]);
    if (value !== undefined) event[target] = value;
  }
  const summaryLine = boundedSummary(data.summary_line ?? data.last_message_tail);
  if (summaryLine) event.summaryLine = summaryLine;
  return event;
}

function pluginData(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

function pluginEventFromEnvironment(environment = process.env) {
  const kindByPluginEvent = new Map([
    ["pane.created", "pane_created"],
    ["pane.closed", "pane_closed"],
    ["pane.exited", "pane_exited"],
    ["pane.agent_status_changed", "agent_status_changed"],
  ]);
  const kind = kindByPluginEvent.get(environment.HERDR_PLUGIN_EVENT);
  if (!kind) return undefined;
  try {
    return paneEvent(kind, pluginData(JSON.parse(environment.HERDR_PLUGIN_EVENT_JSON || "{}")));
  } catch {
    return undefined;
  }
}

class ConvexReporter {
  constructor({
    url = process.env.HERDR_PINGS_CONVEX_URL,
    token = process.env.HERDR_PINGS_CONVEX_TOKEN,
    fetchImpl = globalThis.fetch,
    maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    onDrop = () => {},
  } = {}) {
    this.endpoint = configuredEndpoint(url);
    this.token = typeof token === "string" ? token.trim() : "";
    this.fetchImpl = fetchImpl;
    this.maxBufferedEvents = maxBufferedEvents;
    this.maxBatchSize = maxBatchSize;
    this.flushDelayMs = flushDelayMs;
    this.onDrop = onDrop;
    this.queue = [];
    this.droppedEvents = 0;
    this.flushTimer = undefined;
    this.flushing = false;
  }

  get enabled() {
    return Boolean(this.endpoint && this.token && this.fetchImpl);
  }

  enqueue(event) {
    if (!this.enabled || !event) return false;
    if (this.queue.length >= this.maxBufferedEvents) {
      this.drop(1, "buffer full");
      return false;
    }
    this.queue.push(event);
    if (!this.flushTimer && !this.flushing) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, this.flushDelayMs);
      this.flushTimer.unref?.();
    }
    return true;
  }

  async flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  async flush() {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const events = this.queue.splice(0, this.maxBatchSize);
        try {
          const response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ events }),
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          this.drop(events.length, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  drop(count, reason) {
    this.droppedEvents += count;
    this.onDrop({ count, droppedEvents: this.droppedEvents, reason });
  }
}

module.exports = {
  ConvexReporter,
  boundedSummary,
  configuredEndpoint,
  paneEvent,
  pluginEventFromEnvironment,
};
