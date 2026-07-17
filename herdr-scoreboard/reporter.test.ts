import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AGE_REFRESH_MS,
  buildMetadataArgs,
  createFileSequence,
  formatAge,
  nextAgeRefreshDelay,
  readLastSettledEvent,
  SCOREBOARD_SOURCE,
  SCOREBOARD_TTL_MS,
  ScoreboardReporter,
  type StructuredLogRecord,
} from "./reporter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "herdr-scoreboard-"));
  temporaryDirectories.push(path);
  return path;
}

describe("scoreboard metadata", () => {
  test("publishes the decided tokens, state label, lease, and stable source", () => {
    const now = Date.parse("2026-07-17T18:12:00.000Z");
    const args = buildMetadataArgs(
      "w0:p2",
      {
        task: "Probe token TTLs",
        lastEvent: {
          timestamp: "2026-07-17T18:00:00.000Z",
          turnIndex: 52,
          outcome: "ok",
        },
      },
      99,
      now,
    );

    expect(args).toEqual([
      "pane",
      "report-metadata",
      "w0:p2",
      "--source",
      SCOREBOARD_SOURCE,
      "--token",
      "task=Probe token TTLs",
      "--token",
      "turn=turn 53 ✅",
      "--token",
      "age=12m quiet",
      "--state-label",
      "blocked=NEEDS JOEL",
      "--seq",
      "99",
      "--ttl-ms",
      String(SCOREBOARD_TTL_MS),
    ]);
  });

  test("clears owned tokens when their values are absent", () => {
    const args = buildMetadataArgs("w0:p2", {}, 100, Date.parse("2026-07-17T18:12:00.000Z"));
    expect(args).toContain("task");
    expect(args).toContain("turn");
    expect(args).toContain("age");
    expect(args.filter((value) => value === "--clear-token")).toHaveLength(3);
  });

  test("formats quiet age and schedules coarse twelve-minute refreshes", () => {
    const event = "2026-07-17T18:00:00.000Z";
    expect(formatAge(event, Date.parse("2026-07-17T18:00:30.000Z"))).toBe("just now quiet");
    expect(formatAge(event, Date.parse("2026-07-17T18:12:00.000Z"))).toBe("12m quiet");
    expect(formatAge(event, Date.parse("2026-07-17T20:05:00.000Z"))).toBe("2h quiet");
    expect(nextAgeRefreshDelay(event, Date.parse("2026-07-17T18:05:00.000Z"))).toBe(7 * 60_000);
    expect(nextAgeRefreshDelay(undefined, Date.parse("2026-07-17T18:05:00.000Z"))).toBe(
      AGE_REFRESH_MS,
    );
  });
});

describe("scoreboard persistence", () => {
  test("persists monotonic sequence numbers across reporter restarts and clock rollback", async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    const firstReporter = createFileSequence("w0:p2", () => now, directory);
    expect(await firstReporter()).toBe(1_000);
    expect(await firstReporter()).toBe(1_001);

    now = 900;
    const restartedReporter = createFileSequence("w0:p2", () => now, directory);
    expect(await restartedReporter()).toBe(1_002);
  });

  test("restores the newest valid settled spool event", async () => {
    const root = await temporaryDirectory();
    const state = join(root, ".local", "state", "herdr-pings");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "w0-p2.jsonl"),
      [
        JSON.stringify({
          event: "turn_ended",
          pane_id: "w0:p2",
          timestamp: "2026-07-17T18:00:00.000Z",
          turn_index: 7,
        }),
        "not json",
        JSON.stringify({
          event: "turn_error",
          pane_id: "w0:p2",
          timestamp: "2026-07-17T18:12:00.000Z",
          turn_index: 8,
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await readLastSettledEvent("w0:p2", root)).toEqual({
      timestamp: "2026-07-17T18:12:00.000Z",
      turnIndex: 8,
      outcome: "error",
    });
  });
});

describe("scoreboard reporter lifecycle", () => {
  test("recovers after sequence persistence fails", async () => {
    const commands: string[][] = [];
    const logs: StructuredLogRecord[] = [];
    const timers: Array<{ delay: number }> = [];
    let attempts = 0;
    const reporter = new ScoreboardReporter("w0:p2", {
      now: () => Date.parse("2026-07-17T18:12:00.000Z"),
      runHerdr: async (args) => {
        commands.push(args);
      },
      nextSequence: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        return 2;
      },
      writeLog: async (record) => {
        logs.push(record);
      },
      setTimer: ((_callback: () => void, delay: number) => {
        timers.push({ delay });
        return { unref() {} };
      }) as typeof setTimeout,
      clearTimer: () => {},
    });

    await reporter.start({ task: "Build scoreboard" });
    expect(commands).toHaveLength(0);
    expect(timers.at(-1)?.delay).toBe(15_000);
    await reporter.settled({ task: "Build scoreboard" });
    expect(commands).toHaveLength(1);
    expect(logs.some((record) => record.stage === "publish" && record.status === "error")).toBe(
      true,
    );
    await reporter.stop();
  });

  test("serializes reports, advances sequences, and schedules lease replay", async () => {
    const commands: string[][] = [];
    const logs: StructuredLogRecord[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let sequence = 40;
    const now = Date.parse("2026-07-17T18:12:00.000Z");
    const reporter = new ScoreboardReporter("w0:p2", {
      now: () => now,
      runHerdr: async (args) => {
        commands.push(args);
      },
      nextSequence: async () => ++sequence,
      writeLog: async (record) => {
        logs.push(record);
      },
      setTimer: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return { unref() {} };
      }) as typeof setTimeout,
      clearTimer: () => {},
    });

    await reporter.start({
      task: "Build scoreboard",
      lastEvent: { timestamp: "2026-07-17T18:00:00.000Z", turnIndex: 2, outcome: "ok" },
    });
    await reporter.settled({
      task: "Build scoreboard",
      lastEvent: { timestamp: "2026-07-17T18:12:00.000Z", turnIndex: 3, outcome: "error" },
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("41");
    expect(commands[1]).toContain("42");
    expect(commands[1]).toContain("turn=turn 4 💥");
    expect(timers.at(-1)?.delay).toBe(AGE_REFRESH_MS);
    expect(logs.some((record) => record.stage === "publish" && record.status === "ok")).toBe(true);
    await reporter.stop();
  });
});
