#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readLastSettledEvent,
  safePaneName,
  scoreboardStateDirectory,
} from "../herdr-scoreboard/reporter.ts";

const execFileAsync = promisify(execFile);

async function currentPaneId(): Promise<string | undefined> {
  const fromEnvironment = process.env.HERDR_PANE_ID?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const { stdout } = await execFileAsync("herdr", ["pane", "current"], { timeout: 3_000 });
    const response = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    return typeof response.result?.pane?.pane_id === "string"
      ? response.result.pane.pane_id
      : undefined;
  } catch {
    return undefined;
  }
}

const explicitPane = process.argv[2]?.trim();
const paneId = explicitPane || (await currentPaneId());
if (!paneId) {
  console.error("usage: herdr-scoreboard-trace [pane_id]");
  process.exit(2);
}

try {
  const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId], { timeout: 3_000 });
  const response = JSON.parse(stdout) as {
    result?: { pane?: { tokens?: unknown; state_labels?: unknown } };
  };
  const logPath = join(scoreboardStateDirectory(), `${safePaneName(paneId)}.jsonl`);
  let recentLogs: unknown[] = [];
  try {
    recentLogs = (await readFile(logPath, "utf8"))
      .trimEnd()
      .split("\n")
      .slice(-20)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  } catch {}
  console.log(
    JSON.stringify(
      {
        component: "herdr-scoreboard-trace",
        pane_id: paneId,
        tokens: response.result?.pane?.tokens ?? {},
        state_labels: response.result?.pane?.state_labels ?? {},
        last_event: await readLastSettledEvent(paneId, homedir()),
        reporter_logs: recentLogs,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      component: "herdr-scoreboard-trace",
      pane_id: paneId,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
