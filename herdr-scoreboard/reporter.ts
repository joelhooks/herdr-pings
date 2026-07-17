import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCOREBOARD_SOURCE = "user:herdr-pings.scoreboard.v1";
export const SCOREBOARD_TTL_MS = 30 * 60 * 1_000;
export const AGE_REFRESH_MS = 12 * 60 * 1_000;
export const RETRY_MS = 15 * 1_000;

export type SettledEvent = {
  timestamp: string;
  turnIndex?: number;
  outcome: "ok" | "error";
};

export type ScoreboardSnapshot = {
  task?: string;
  lastEvent?: SettledEvent;
};

export type StructuredLogRecord = {
  component: "herdr-scoreboard";
  pane_id: string;
  stage: "restore" | "publish" | "schedule" | "shutdown";
  status: "attempt" | "ok" | "error" | "scheduled" | "stopped";
  timestamp: string;
  reason?: string;
  seq?: number;
  delay_ms?: number;
  error?: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type ReporterDependencies = {
  now: () => number;
  runHerdr: (args: string[]) => Promise<void>;
  nextSequence: () => Promise<number>;
  writeLog: (record: StructuredLogRecord) => Promise<void>;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
};

export function safePaneName(paneId: string): string {
  return paneId.replaceAll(":", "-");
}

export function scoreboardStateDirectory(root = homedir()): string {
  return join(root, ".local", "state", "herdr-pings", "scoreboard");
}

export function formatAge(timestamp: string, now: number): string {
  const eventTime = Date.parse(timestamp);
  const elapsed = Number.isFinite(eventTime) ? Math.max(0, now - eventTime) : 0;
  if (elapsed < 60_000) return "just now quiet";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m quiet`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h quiet`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d quiet`;
}

export function nextAgeRefreshDelay(timestamp: string | undefined, now: number): number {
  if (!timestamp) return AGE_REFRESH_MS;
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) return AGE_REFRESH_MS;
  const elapsed = Math.max(0, now - eventTime);
  const nextBoundary = eventTime + (Math.floor(elapsed / AGE_REFRESH_MS) + 1) * AGE_REFRESH_MS;
  return Math.max(1_000, nextBoundary - now);
}

export function nextMonotonicSequence(previous: number, now: number): number {
  return Math.max(previous + 1, Math.floor(now));
}

export function buildMetadataArgs(
  paneId: string,
  snapshot: ScoreboardSnapshot,
  sequence: number,
  now: number,
): string[] {
  const args = ["pane", "report-metadata", paneId, "--source", SCOREBOARD_SOURCE];
  const task = snapshot.task?.replaceAll(/\s+/g, " ").trim();
  if (task) args.push("--token", `task=${task}`);
  else args.push("--clear-token", "task");
  if (snapshot.lastEvent) {
    const turn =
      snapshot.lastEvent.turnIndex === undefined
        ? `turn ? ${snapshot.lastEvent.outcome === "error" ? "💥" : "✅"}`
        : `turn ${snapshot.lastEvent.turnIndex + 1} ${snapshot.lastEvent.outcome === "error" ? "💥" : "✅"}`;
    args.push("--token", `turn=${turn}`);
    args.push("--token", `age=${formatAge(snapshot.lastEvent.timestamp, now)}`);
  } else {
    args.push("--clear-token", "turn", "--clear-token", "age");
  }
  args.push("--state-label", "blocked=NEEDS JOEL");
  args.push("--seq", String(sequence));
  args.push("--ttl-ms", String(SCOREBOARD_TTL_MS));
  return args;
}

export function createFileSequence(
  paneId: string,
  now: () => number = Date.now,
  stateDirectory = scoreboardStateDirectory(),
): () => Promise<number> {
  const path = join(stateDirectory, `${safePaneName(paneId)}.seq`);
  let current: number | undefined;

  return async () => {
    if (current === undefined) {
      try {
        const parsed = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
        current = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
      } catch {
        current = 0;
      }
    }
    current = nextMonotonicSequence(current, now());
    await mkdir(stateDirectory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${current}\n`, "utf8");
    await rename(temporary, path);
    return current;
  };
}

export function createStructuredLogger(
  paneId: string,
  stateDirectory = scoreboardStateDirectory(),
): (record: StructuredLogRecord) => Promise<void> {
  const path = join(stateDirectory, `${safePaneName(paneId)}.jsonl`);
  return async (record) => {
    await mkdir(stateDirectory, { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  };
}

export async function readLastSettledEvent(
  paneId: string,
  root = homedir(),
): Promise<SettledEvent | undefined> {
  const path = join(root, ".local", "state", "herdr-pings", `${safePaneName(paneId)}.jsonl`);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.trimEnd().split("\n").reverse()) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (
        record.pane_id !== paneId ||
        (record.event !== "turn_ended" && record.event !== "turn_error")
      )
        continue;
      if (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)))
        continue;
      return {
        timestamp: record.timestamp,
        turnIndex: Number.isSafeInteger(record.turn_index)
          ? (record.turn_index as number)
          : undefined,
        outcome: record.event === "turn_error" ? "error" : "ok",
      };
    } catch {}
  }
  return undefined;
}

export class ScoreboardReporter {
  private snapshot: ScoreboardSnapshot = {};
  private lifecycle: "new" | "running" | "stopped" = "new";
  private timer: TimerHandle | undefined;
  private publishQueue = Promise.resolve();

  constructor(
    private readonly paneId: string,
    private readonly dependencies: ReporterDependencies,
  ) {}

  start(snapshot: ScoreboardSnapshot): Promise<void> {
    this.snapshot = snapshot;
    this.lifecycle = "running";
    return this.publish("startup_replay");
  }

  settled(snapshot: ScoreboardSnapshot): Promise<void> {
    this.snapshot = snapshot;
    if (this.lifecycle === "new") this.lifecycle = "running";
    return this.publish("turn_settled");
  }

  stop(): Promise<void> {
    this.lifecycle = "stopped";
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timer = undefined;
    return this.log({ stage: "shutdown", status: "stopped" });
  }

  private publish(reason: string): Promise<void> {
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timer = undefined;
    this.publishQueue = this.publishQueue
      .catch(() => {})
      .then(async () => {
        if (this.lifecycle !== "running") return;
        let sequence: number | undefined;
        try {
          sequence = await this.dependencies.nextSequence();
          const args = buildMetadataArgs(
            this.paneId,
            this.snapshot,
            sequence,
            this.dependencies.now(),
          );
          await this.log({ stage: "publish", status: "attempt", reason, seq: sequence });
          await this.dependencies.runHerdr(args);
          await this.log({ stage: "publish", status: "ok", reason, seq: sequence });
          this.schedule(
            nextAgeRefreshDelay(this.snapshot.lastEvent?.timestamp, this.dependencies.now()),
            "lease_refresh",
          );
        } catch (error) {
          await this.log({
            stage: "publish",
            status: "error",
            reason,
            seq: sequence,
            error: error instanceof Error ? error.message : String(error),
          });
          this.schedule(RETRY_MS, "retry");
        }
      });
    return this.publishQueue;
  }

  private schedule(delayMs: number, reason: string): void {
    if (this.lifecycle !== "running") return;
    if (this.timer) this.dependencies.clearTimer(this.timer);
    void this.log({ stage: "schedule", status: "scheduled", reason, delay_ms: delayMs });
    this.timer = this.dependencies.setTimer(() => {
      this.timer = undefined;
      void this.publish(reason);
    }, delayMs);
    this.timer.unref?.();
  }

  private async log(
    record: Omit<StructuredLogRecord, "component" | "pane_id" | "timestamp">,
  ): Promise<void> {
    try {
      await this.dependencies.writeLog({
        component: "herdr-scoreboard",
        pane_id: this.paneId,
        timestamp: new Date(this.dependencies.now()).toISOString(),
        ...record,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "herdr-scoreboard",
          pane_id: this.paneId,
          stage: "log",
          status: "error",
          timestamp: new Date(this.dependencies.now()).toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
