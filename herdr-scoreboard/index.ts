import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFileSequence,
  createStructuredLogger,
  readLastSettledEvent,
  ScoreboardReporter,
  type StructuredLogRecord,
} from "./reporter.js";

const execFileAsync = promisify(execFile);

type CachedAssistant = {
  stopReason?: string;
};

export default function herdrScoreboard(pi: ExtensionAPI) {
  const paneId = process.env.HERDR_PANE_ID?.trim();
  if (!paneId || !process.env.HERDR_SOCKET_PATH) return;

  const now = Date.now;
  const writeLog = createStructuredLogger(paneId);
  const reporter = new ScoreboardReporter(paneId, {
    now,
    nextSequence: createFileSequence(paneId, now),
    writeLog,
    runHerdr: async (args) => {
      await execFileAsync("herdr", args, {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1_024,
      });
    },
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  let latestAssistant: CachedAssistant | undefined;
  let latestTurnIndex: number | undefined;

  const task = (): string | undefined => {
    try {
      return pi.getSessionName()?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const logRestore = async (status: StructuredLogRecord["status"], reason: string) => {
    try {
      await writeLog({
        component: "herdr-scoreboard",
        pane_id: paneId,
        stage: "restore",
        status,
        timestamp: new Date(now()).toISOString(),
        reason,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "herdr-scoreboard",
          pane_id: paneId,
          stage: "restore",
          status: "error",
          timestamp: new Date(now()).toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  pi.on("session_start", async () => {
    const lastEvent = await readLastSettledEvent(paneId);
    await logRestore("ok", lastEvent ? "spool_event_restored" : "no_spool_event");
    await reporter.start({ task: task(), lastEvent });
  });

  pi.on("agent_start", () => {
    latestAssistant = undefined;
    latestTurnIndex = undefined;
  });

  pi.on("agent_end", (event) => {
    latestAssistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant") as CachedAssistant | undefined;
  });

  pi.on("turn_end", (event) => {
    latestTurnIndex = event.turnIndex;
  });

  pi.on("agent_settled", () =>
    reporter.settled({
      task: task(),
      lastEvent: {
        timestamp: new Date(now()).toISOString(),
        turnIndex: latestTurnIndex,
        outcome: latestAssistant?.stopReason === "error" ? "error" : "ok",
      },
    }),
  );

  pi.on("session_shutdown", () => reporter.stop());
}
