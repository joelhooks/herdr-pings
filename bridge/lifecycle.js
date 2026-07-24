#!/usr/bin/env bun

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConvexReporter, paneEventWithHerdrLabels } = require("./convex-reporter.js");

const EVENT_NAMES = new Map([
  ["pane.exited", "pane_exited"],
  ["pane.closed", "pane_closed"],
  ["pane.agent_status_changed", "agent_status_changed"],
]);

const DEATH_LINES = [
  (name) => `THE PANE BELONGING TO ${name} HAS ENDED. DO NOT THINK OF IT AS DYING. THINK OF IT AS LEAVING EARLY TO AVOID THE RUSH.`,
  (name) => `${name}. COME WITH ME.`,
  () => "THERE IS NO JUSTICE. THERE IS JUST ME. AND ONE FEWER PANE.",
  (name) => `I AM HERE FOR ${name}. IT APPEARS THE PANE HAS FINISHED BEFORE THE REST OF YOU.`,
  (name) => `${name} HAS REACHED THE END. THIS OFTEN HAPPENS TO THINGS THAT BEGIN.`,
  (name) => `DO NOT BE ALARMED. ${name} IS NO LONGER RUNNING. I AM TOLD HUMANS FIND THIS INCONVENIENT.`,
  (name) => `THE PANE CALLED ${name} HAS STOPPED. I HAVE ALWAYS FOUND STOPPING TO BE VERY FINAL.`,
  (name) => `${name} HAS DEPARTED. THERE WAS NO NEED TO PACK.`,
];

function deathLine(label) {
  const name = label.toUpperCase();
  return DEATH_LINES[Math.floor(Math.random() * DEATH_LINES.length)](name);
}

function paneData(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.data && typeof payload.data === "object") return payload.data;
  return payload;
}

function showErrorNotification(label, body) {
  if (!process.env.HERDR_SOCKET_PATH) return;

  try {
    const child = spawn(
      "herdr",
      [
        "notification",
        "show",
        `${label} errored`,
        "--body",
        body.slice(0, 200),
        "--sound",
        "request",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function stateDirectory() {
  return path.join(os.homedir(), ".local", "state", "herdr-pings");
}

function spoolFile(paneId) {
  return path.join(stateDirectory(), `${paneId.replaceAll(":", "-")}.jsonl`);
}

function sidecarFile(paneId) {
  return path.join(stateDirectory(), "agent-status", `${paneId.replaceAll(":", "-")}.json`);
}

function appendToSpool(paneId, record) {
  const spoolPath = spoolFile(paneId);
  let descriptor;
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    descriptor = fs.openSync(
      spoolPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    );
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    console.error(`herdr-pings: could not append ${spoolPath}: ${error.message}`);
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        console.error(`herdr-pings: could not close ${spoolPath}: ${error.message}`);
      }
    }
  }
}

function spoolIsEmpty(paneId) {
  try {
    return fs.statSync(spoolFile(paneId)).size === 0;
  } catch {
    return true;
  }
}

function readSidecar(paneId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarFile(paneId), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSidecar(paneId, value) {
  try {
    fs.mkdirSync(path.dirname(sidecarFile(paneId)), { recursive: true });
    fs.writeFileSync(sidecarFile(paneId), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`herdr-pings: could not write sidecar for ${paneId}: ${error.message}`);
  }
}

function deleteSidecar(paneId) {
  try {
    fs.unlinkSync(sidecarFile(paneId));
  } catch {}
}

function makeReporter() {
  return new ConvexReporter({
    onDrop: ({ count, droppedEvents, reason }) =>
      console.error(`herdr-pings: dropped ${count} Convex event(s), ${droppedEvents} total: ${reason}`),
  });
}

function handlePaneGone(event, data, paneId) {
  const record = {
    event,
    pane_id: paneId,
    timestamp: new Date().toISOString(),
  };
  if (typeof data.workspace_id === "string" && data.workspace_id) {
    record.workspace_id = data.workspace_id;
  }
  if (Number.isInteger(data.exit_code)) record.exit_code = data.exit_code;
  if (typeof data.agent === "string" && data.agent) record.agent = data.agent;

  if (!appendToSpool(paneId, record)) return;
  deleteSidecar(paneId);
  const convex = makeReporter();
  convex.enqueue(paneEventWithHerdrLabels(event, { ...data, ...record }));
  void convex.flushNow();
  if (event === "pane_exited") {
    const label =
      (typeof data.label === "string" && data.label.trim()) ||
      (typeof data.agent === "string" && data.agent.trim()) ||
      paneId;
    showErrorNotification(label, deathLine(label));
  }
}

/**
 * Early-crash blind spot (defect observed 2026-07-24): an agent that dies
 * before its first settled turn leaves no spool file, so nothing wakes the
 * waiters. The status stream is the only signal: the detection label
 * (`agent`) is present while the process runs and absent once it is gone.
 * A per-pane sidecar remembers that an agent was seen; when the label
 * disappears and the spool was never written, a synthetic
 * `agent_exited_early` event is appended so `herdr-ping-wait` fires.
 *
 * `agent_status` alone cannot be used: "done" means "settled unseen", not
 * "process exited".
 */
function handleAgentStatusChanged(data, paneId) {
  const agent = typeof data.agent === "string" && data.agent.trim() ? data.agent.trim() : undefined;

  const convex = makeReporter();
  convex.enqueue(paneEventWithHerdrLabels("agent_status_changed", data));

  if (agent) {
    writeSidecar(paneId, { agent, last_seen: new Date().toISOString() });
    void convex.flushNow();
    return;
  }

  const sidecar = readSidecar(paneId);
  if (sidecar) {
    deleteSidecar(paneId);
    if (spoolIsEmpty(paneId)) {
      const record = {
        event: "agent_exited_early",
        synthetic: true,
        pane_id: paneId,
        timestamp: new Date().toISOString(),
      };
      if (typeof data.workspace_id === "string" && data.workspace_id) {
        record.workspace_id = data.workspace_id;
      }
      if (typeof sidecar.agent === "string" && sidecar.agent) record.agent = sidecar.agent;
      if (typeof data.agent_status === "string" && data.agent_status) {
        record.agent_status = data.agent_status;
      }
      if (appendToSpool(paneId, record)) {
        convex.enqueue(paneEventWithHerdrLabels("agent_exited_early", { ...data, ...record }));
        const label = record.agent || paneId;
        showErrorNotification(label, `${label} exited before its first turn settled.`);
      }
    }
  }
  void convex.flushNow();
}

function main() {
  const pluginEvent = process.env.HERDR_PLUGIN_EVENT || "";
  const event = EVENT_NAMES.get(pluginEvent);
  if (!event) {
    console.error(`herdr-pings: ignored unsupported plugin event ${JSON.stringify(pluginEvent)}`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  } catch (error) {
    console.error(`herdr-pings: invalid HERDR_PLUGIN_EVENT_JSON: ${error.message}`);
    return;
  }

  const data = paneData(payload);
  const paneId = typeof data?.pane_id === "string" ? data.pane_id.trim() : "";
  if (!paneId) {
    console.error(`herdr-pings: ${pluginEvent} payload has no pane_id`);
    return;
  }

  if (event === "agent_status_changed") {
    handleAgentStatusChanged(data, paneId);
  } else {
    handlePaneGone(event, data, paneId);
  }
}

main();
