#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { access, lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stateDir = join(homedir(), ".local", "state", "herdr-pings");
const cursorPath = join(stateDir, "cursor.json");
const pluginRoot = process.env.HERDR_PLUGIN_ROOT?.trim()
  ? resolve(process.env.HERDR_PLUGIN_ROOT)
  : resolve(import.meta.dir, "..");
const expectedExtension = join(pluginRoot, "herdr-turn-ping");
const expectedCli = join(pluginRoot, "herdr-ping-wait", "herdr-ping-wait.ts");
let failed = false;

function line(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
  if (!ok) failed = true;
}

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

async function validLink(path: string, expected: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return { ok: false, detail: "not a symlink" };
    const target = resolve(dirname(path), await readlink(path));
    await access(target);
    return target === expected
      ? { ok: true, detail: `-> ${target}` }
      : { ok: false, detail: `-> ${target} (expected ${expected})` };
  } catch (error) {
    return { ok: false, detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing or broken" : String(error) };
  }
}

async function activePaneIds(): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("herdr", ["pane", "list"], { timeout: 3_000 });
    const parsed = JSON.parse(stdout) as { result?: { panes?: Array<{ pane_id?: unknown }> } };
    return new Set((parsed.result?.panes ?? []).flatMap((pane) => typeof pane.pane_id === "string" ? [pane.pane_id] : []));
  } catch {
    return undefined;
  }
}

async function inspectSpool(path: string): Promise<{ age: string; malformed: number; partial: boolean }> {
  const info = await stat(path);
  const content = await readFile(path, "utf8");
  const partial = content.length > 0 && !content.endsWith("\n");
  const records = content.split("\n").filter((value, index, all) => value.length > 0 && !(partial && index === all.length - 1));
  let malformed = 0;
  for (const record of records) {
    try {
      const value = JSON.parse(record) as Record<string, unknown>;
      if (typeof value.event !== "string" || typeof value.pane_id !== "string" || typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { age: age(info.mtimeMs), malformed, partial };
}

const extension = await validLink(join(homedir(), ".pi", "agent", "extensions", "herdr-turn-ping"), expectedExtension);
line(extension.ok, "pi extension", extension.detail);

const nameSync = await validLink(join(homedir(), ".pi", "agent", "extensions", "herdr-name-sync"), join(pluginRoot, "herdr-name-sync"));
line(nameSync.ok, "name-sync extension", nameSync.detail);

const cli = await validLink(join(homedir(), ".local", "bin", "herdr-ping-wait"), expectedCli);
let cliOnPath = false;
try {
  const { stdout } = await execFileAsync("sh", ["-lc", "command -v herdr-ping-wait"], { timeout: 2_000 });
  cliOnPath = stdout.trim().length > 0;
} catch {}
line(cli.ok && cliOnPath, "wait CLI", cli.ok ? (cliOnPath ? `${cli.detail}; on PATH` : "valid symlink but not on PATH") : cli.detail);

try {
  await access(stateDir, constants.W_OK);
  const info = await stat(stateDir);
  line(info.isDirectory(), "spool directory", info.isDirectory() ? `${stateDir} writable` : "not a directory");
} catch (error) {
  line(false, "spool directory", (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not writable");
}

let spoolNames: string[] = [];
try {
  spoolNames = (await readdir(stateDir)).filter((name) => name.endsWith(".jsonl")).sort();
} catch {}
const panes = await activePaneIds();
const activeNames = panes && new Set([...panes].map((id) => `${id.replaceAll(":", "-")}.jsonl`));
const stale = activeNames ? spoolNames.filter((name) => !activeNames.has(name)) : [];
line(panes !== undefined, "pane inventory", panes ? `${panes.size} live; ${stale.length} stale spool${stale.length === 1 ? "" : "s"}` : "herdr pane list failed");

let malformed = 0;
let partial = 0;
let staleMalformed = 0;
let stalePartial = 0;
for (const name of spoolNames) {
  const result = await inspectSpool(join(stateDir, name));
  const isActive = activeNames?.has(name) ?? true;
  if (isActive) {
    malformed += result.malformed;
    partial += Number(result.partial);
  } else {
    staleMalformed += result.malformed;
    stalePartial += Number(result.partial);
  }
  const problems = [result.malformed ? `${result.malformed} malformed` : "", result.partial ? "partial trailing" : ""].filter(Boolean).join("; ");
  console.log(`${isActive && problems ? "✗" : "✓"} spool ${basename(name, ".jsonl")}: last event ${result.age} ago${isActive ? "" : "; pane gone"}${problems ? `; ${problems}` : ""}`);
}
line(malformed === 0 && partial === 0, "active spool JSONL", `${spoolNames.length - stale.length} active; ${malformed} malformed; ${partial} partial trailing; stale issues ${staleMalformed + stalePartial}`);

try {
  const info = await stat(cursorPath);
  const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
  let invalid = 0;
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) invalid = 1;
  else {
    for (const [path, offset] of Object.entries(cursor)) {
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) { invalid += 1; continue; }
      try {
        if ((offset as number) > (await stat(path)).size) invalid += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || offset !== 0) invalid += 1;
      }
    }
  }
  line(invalid === 0, "cursor", `${age(info.mtimeMs)} old; ${invalid} invalid entr${invalid === 1 ? "y" : "ies"}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    line(true, "cursor", "not created yet (no waits have run)");
  } else {
    line(false, "cursor", `invalid: ${(error as Error).message}`);
  }
}

process.exitCode = failed ? 1 : 0;
