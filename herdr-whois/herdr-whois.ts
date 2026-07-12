#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const stateDir = join(homedir(), ".local", "state", "herdr-pings");
const includeDead = process.argv.slice(2).includes("--all");
type Item = { name?: string; agent?: string; pane_id?: string; agent_status?: string; label?: string };
type Row = { name: string; label: string; status: string; timestamp: number };
async function herdrList(command: "agent" | "pane"): Promise<Item[]> { const { stdout } = await execFileAsync("herdr", [command, "list"], { timeout: 3_000 }); const value = JSON.parse(stdout) as { result?: { agents?: Item[]; panes?: Item[] } }; return (command === "agent" ? value.result?.agents : value.result?.panes) ?? []; }
function spoolName(id: string): string { return `${id.replaceAll(":", "-")}.jsonl`; }
function paneId(name: string): string { return name.replace(/\.jsonl$/, "").replace("-", ":"); }
function age(timestamp: number): string { const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000)); if (seconds < 60) return `${seconds}s`; if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`; return `${Math.floor(seconds / 86_400)}d`; }
function eventWord(event: string): string { return event === "turn_ended" ? "settled" : event === "turn_error" ? "errored" : event.replaceAll("_", " "); }
async function tail(path: string): Promise<{ event: string; timestamp: number; callsign?: string } | undefined> { const content = await readFile(path, "utf8"); for (const line of content.split("\n").filter(Boolean).reverse()) { try { const value = JSON.parse(line) as { event?: unknown; timestamp?: unknown; callsign?: unknown }; const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN; if (typeof value.event === "string" && !Number.isNaN(timestamp)) return { event: value.event, timestamp, callsign: typeof value.callsign === "string" ? value.callsign : undefined }; } catch {} } return undefined; }
try {
  const [agents, panes] = await Promise.all([herdrList("agent"), herdrList("pane")]);
  const paneMap = new Map(panes.flatMap((pane) => pane.pane_id ? [[pane.pane_id, pane]] : []));
  const agentMap = new Map(agents.flatMap((agent) => agent.pane_id ? [[agent.pane_id, agent]] : []));
  const rows: Row[] = [];
  for (const agent of agents) { if (!agent.pane_id || !paneMap.has(agent.pane_id)) continue; const event = await tail(join(stateDir, spoolName(agent.pane_id))).catch(() => undefined); rows.push({ name: agent.name ?? agent.agent ?? agent.pane_id, label: paneMap.get(agent.pane_id)?.label ?? "(unlabelled pane)", status: event ? `${eventWord(event.event)} ${age(event.timestamp)} ago` : (agent.agent_status ?? "no events"), timestamp: event?.timestamp ?? 0 }); }
  if (includeDead) for (const name of (await readdir(stateDir).catch(() => [] as string[])).filter((entry) => entry.endsWith(".jsonl"))) { const id = paneId(name); if (paneMap.has(id) || agentMap.has(id)) continue; const path = join(stateDir, name); const event = await tail(path).catch(() => undefined); const info = await stat(path); rows.push({ name: event?.callsign ?? id, label: "pane gone", status: event ? `${eventWord(event.event)} ${age(event.timestamp)} ago` : `empty ${age(info.mtimeMs)} ago`, timestamp: event?.timestamp ?? info.mtimeMs }); }
  rows.sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name));
  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length)); const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  for (const row of rows) console.log(`${row.name.padEnd(nameWidth)}  ${row.label.padEnd(labelWidth)}  ${row.status}`);
} catch (error) { console.error(`herdr-whois: ${error instanceof Error ? error.message : String(error)}`); }
