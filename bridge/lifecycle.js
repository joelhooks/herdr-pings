#!/usr/bin/env bun

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EVENT_NAMES = new Map([
  ["pane.exited", "pane_exited"],
  ["pane.closed", "pane_closed"],
]);

function paneData(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.data && typeof payload.data === "object") return payload.data;
  return payload;
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

  const spoolDirectory = path.join(os.homedir(), ".local", "state", "herdr-pings");
  const spoolPath = path.join(spoolDirectory, `${paneId.replaceAll(":", "-")}.jsonl`);
  let descriptor;
  try {
    fs.mkdirSync(spoolDirectory, { recursive: true });
    descriptor = fs.openSync(
      spoolPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    );
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(`herdr-pings: could not append ${spoolPath}: ${error.message}`);
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

main();
