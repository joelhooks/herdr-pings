#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stateDir = join(homedir(), ".local", "state", "herdr-pings");
const cursorPath = join(stateDir, "cursor.json");
const thresholdMs = 7 * 24 * 60 * 60 * 1_000;

type Meal = { kind: "spool" | "cursor"; path: string; display: string; reason: string };

function paneIdFromSpool(name: string): string {
  return name.replace(/\.jsonl$/, "").replace("-", ":");
}

function daysOld(timestamp: number): number {
  return Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1_000));
}

async function livePaneIds(): Promise<Set<string>> {
  const { stdout } = await execFileAsync("herdr", ["pane", "list"], { timeout: 3_000 });
  const value = JSON.parse(stdout) as { result?: { panes?: Array<{ pane_id?: unknown }> } };
  return new Set((value.result?.panes ?? []).flatMap((pane) => typeof pane.pane_id === "string" ? [pane.pane_id] : []));
}

async function lastEventTimestamp(path: string): Promise<number | undefined> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]!) as { timestamp?: unknown };
      if (typeof event.timestamp === "string") {
        const timestamp = Date.parse(event.timestamp);
        if (!Number.isNaN(timestamp)) return timestamp;
      }
    } catch {}
  }
  return undefined;
}

try {
  const live = await livePaneIds();
  const meals: Meal[] = [];
  for (const name of (await readdir(stateDir).catch(() => [] as string[])).filter((entry) => entry.endsWith(".jsonl"))) {
    const path = join(stateDir, name);
    const paneId = paneIdFromSpool(name);
    if (live.has(paneId)) continue;
    const info = await stat(path);
    const timestamp = (await lastEventTimestamp(path)) ?? info.mtimeMs;
    if (Date.now() - timestamp < thresholdMs) continue;
    const empty = info.size === 0;
    meals.push({ kind: "spool", path, display: name, reason: empty ? `empty for ${daysOld(timestamp)}d, pane long gone` : `last event ${daysOld(timestamp)}d ago, pane long gone` });
  }

  let cursor: Record<string, number> | undefined;
  try {
    const value = JSON.parse(await readFile(cursorPath, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) cursor = value as Record<string, number>;
  } catch {}
  if (cursor) {
    const doomedSpools = new Set(meals.filter((meal) => meal.kind === "spool").map((meal) => meal.path));
    for (const path of Object.keys(cursor)) {
      if (doomedSpools.has(path)) {
        meals.push({ kind: "cursor", path, display: path, reason: "spool was consumed" });
        continue;
      }
      try { await stat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") meals.push({ kind: "cursor", path, display: path, reason: "spool no longer exists" });
      }
    }
  }

  if (meals.length === 0) {
    console.log("The Luggage waits. Nothing worth eating.");
  } else {
    for (const meal of meals) console.log(`The Luggage would eat ${meal.display} (${meal.reason}).`);
    for (const meal of meals.filter((item) => item.kind === "spool")) {
      await unlink(meal.path);
      console.log(`The Luggage ate ${meal.display} (${meal.reason}).`);
    }
    if (cursor) {
      for (const meal of meals.filter((item) => item.kind === "cursor")) {
        delete cursor[meal.path];
        console.log(`The Luggage ate cursor entry ${meal.display} (${meal.reason}).`);
      }
      const temporary = `${cursorPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
      await rename(temporary, cursorPath);
    }
    console.log(`The Luggage is satisfied. ${meals.length} item${meals.length === 1 ? "" : "s"} consumed.`);
  }
} catch (error) {
  console.error(`The Luggage got indigestion: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
