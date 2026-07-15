/**
 * Optional, memory-only delivery to the local Convex pane event endpoint.
 * It deliberately never reads or writes herdr-pings spool files.
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const DEFAULT_MAX_BUFFERED_EVENTS = 100;
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_FLUSH_DELAY_MS = 250;
const HERDR_LOOKUP_TIMEOUT_MS = 750;
const SUMMARY_LIMIT = 280;

// Bridge processes are spawned fresh per pane event by the herdr server, whose own env
// can't change without a server restart (which would take Joel's pane wall with it).
// A config file read at spawn time is the restart-free path; env vars still win.
function fileConfig() {
  try {
    const home = process.env.HOME;
    if (!home) return {};
    const raw = require("node:fs").readFileSync(
      `${home}/.local/state/herdr-pings/convex.json`,
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

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

function sourceText(data, ...keys) {
  for (const key of keys) {
    if (typeof data[key] === "string" && data[key].trim()) {
      return data[key].trim().slice(0, SUMMARY_LIMIT);
    }
  }
  return undefined;
}

function listResult(stdout, key, idKey) {
  try {
    const parsed = JSON.parse(stdout);
    const rows = parsed?.result?.[key];
    if (!Array.isArray(rows)) return new Map();
    return new Map(
      rows.flatMap((row) => {
        const id = sourceText(row ?? {}, idKey);
        const label = sourceText(row ?? {}, "label");
        return id && label ? [[id, label]] : [];
      }),
    );
  } catch {
    return new Map();
  }
}

function herdrBinary() {
  if (process.env.HERDR_BIN) return process.env.HERDR_BIN;
  const local = process.env.HOME && `${process.env.HOME}/.local/bin/herdr`;
  return local && existsSync(local) ? local : "herdr";
}

function readHerdrLabels(run = (args) =>
  execFileSync(herdrBinary(), args, {
    encoding: "utf8",
    timeout: HERDR_LOOKUP_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }),
) {
  let workspaces = new Map();
  let tabs = new Map();
  try {
    workspaces = listResult(run(["workspace", "list"]), "workspaces", "workspace_id");
  } catch {}
  try {
    tabs = listResult(run(["tab", "list"]), "tabs", "tab_id");
  } catch {}
  return { workspaces, tabs };
}

function createHerdrLabelLookup(read = readHerdrLabels) {
  let labels;
  return (data = {}) => {
    labels ??= read();
    const workspaceId = sourceText(data, "workspace_id", "workspaceId");
    const tabId = sourceText(data, "tab_id", "tabId");
    const workspaceLabel = workspaceId ? labels.workspaces.get(workspaceId) : undefined;
    const tabLabel = tabId ? labels.tabs.get(tabId) : undefined;
    return {
      ...(workspaceLabel === undefined ? {} : { workspaceLabel }),
      ...(tabLabel === undefined ? {} : { tabLabel }),
    };
  };
}

const herdrLabelLookup = createHerdrLabelLookup();

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
    ["session", ["session"]],
    ["workspaceId", ["workspace_id", "workspaceId"]],
    ["workspaceLabel", ["workspace_label", "workspaceLabel"]],
    ["tabId", ["tab_id", "tabId"]],
    ["tabLabel", ["tab_label", "tabLabel"]],
    ["label", ["label"]],
    ["agentKind", ["agent"]],
    ["status", ["agent_status", "status"]],
    ["error", ["error"]],
  ];
  for (const [target, sources] of stringFields) {
    const value = sourceText(data, ...sources);
    if (value) event[target] = value;
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

function paneEventWithHerdrLabels(kind, data = {}, lookup = herdrLabelLookup) {
  const labels = lookup(data);
  return paneEvent(kind, {
    ...data,
    ...(labels.workspaceLabel === undefined
      ? {}
      : { workspace_label: labels.workspaceLabel }),
    ...(labels.tabLabel === undefined ? {} : { tab_label: labels.tabLabel }),
  });
}

function pluginEventFromEnvironment(environment = process.env, lookup = herdrLabelLookup) {
  const kindByPluginEvent = new Map([
    ["pane.created", "pane_created"],
    ["pane.closed", "pane_closed"],
    ["pane.exited", "pane_exited"],
    ["pane.agent_status_changed", "agent_status_changed"],
  ]);
  const kind = kindByPluginEvent.get(environment.HERDR_PLUGIN_EVENT);
  if (!kind) return undefined;
  try {
    return paneEventWithHerdrLabels(
      kind,
      pluginData(JSON.parse(environment.HERDR_PLUGIN_EVENT_JSON || "{}")),
      lookup,
    );
  } catch {
    return undefined;
  }
}

class ConvexReporter {
  constructor({
    url = process.env.HERDR_PINGS_CONVEX_URL ?? fileConfig().url,
    token = process.env.HERDR_PINGS_CONVEX_TOKEN ?? fileConfig().token,
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
  createHerdrLabelLookup,
  paneEvent,
  paneEventWithHerdrLabels,
  pluginEventFromEnvironment,
  readHerdrLabels,
};
