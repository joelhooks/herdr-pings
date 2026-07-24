import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { run, spoolPath, type Options } from "./herdr-ping-wait.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "herdr-ping-wait-"));
  temporaryDirectories.push(path);
  return path;
}

function event(paneId: string, marker: string): string {
  return JSON.stringify({ event: "turn_ended", pane_id: paneId, marker });
}

async function appendEvent(stateDir: string, paneId: string, marker: string): Promise<string> {
  const line = event(paneId, marker);
  await appendFile(spoolPath(paneId, stateDir), `${line}\n`, "utf8");
  return line;
}

function waiter(stateDir: string, cursorPath: string, options: Partial<Options> = {}): Options & { lines: string[] } {
  const lines: string[] = [];
  return {
    paneIds: [],
    cursorPath,
    stateDir,
    pollIntervalMs: 20,
    write: (line: string) => {
      lines.push(line);
    },
    lines,
    ...options,
  } as Options & { lines: string[] };
}

async function cursorOffsets(cursorPath: string): Promise<Record<string, number>> {
  return JSON.parse(await readFile(cursorPath, "utf8")) as Record<string, number>;
}

/** Wait until a freshly started waiter has registered every watched spool. */
async function registered(cursorPath: string, stateDir: string, paneIds: string[]): Promise<void> {
  const spools = paneIds.map((paneId) => spoolPath(paneId, stateDir));
  while (true) {
    try {
      const cursor = await cursorOffsets(cursorPath);
      if (spools.every((spool) => spool in cursor)) return;
    } catch {}
    await Bun.sleep(10);
  }
}

describe("herdr-ping-wait cursor integrity", () => {
  test("one-shot waiter consumes exactly one event and advances the cursor", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await writeFile(spoolPath("w1:p1", stateDir), "", "utf8");

    const options = waiter(stateDir, cursorPath, { paneIds: ["w1:p1"], timeoutMs: 3_000 });
    const running = run(options);
    await registered(cursorPath, stateDir, ["w1:p1"]);
    const first = await appendEvent(stateDir, "w1:p1", "one");
    await appendEvent(stateDir, "w1:p1", "two");

    expect(await running).toBe(0);
    expect(options.lines).toEqual([first]);
  });

  test("regression: a long-lived waiter does not rewind offsets consumed by sibling waiters", async () => {
    // The w25:p2V replay (2026-07-24): waiter A held the whole cursor map in
    // memory; when it finally consumed its own event it rewrote the map
    // wholesale, rewinding spools that waiter B had consumed meanwhile, so
    // later waiters replayed B's events.
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await writeFile(spoolPath("w9:pA", stateDir), "", "utf8");
    await writeFile(spoolPath("w9:pB", stateDir), "", "utf8");

    // Waiter A watches both spools while they are empty.
    const optionsA = waiter(stateDir, cursorPath, { paneIds: ["w9:pA", "w9:pB"], timeoutMs: 5_000 });
    const waiterA = run(optionsA);
    await registered(cursorPath, stateDir, ["w9:pA", "w9:pB"]);

    // Waiter B consumes an event on pB while A is still polling.
    const consumedByB = await appendEvent(stateDir, "w9:pB", "b-1");
    const optionsB = waiter(stateDir, cursorPath, { paneIds: ["w9:pB"], timeoutMs: 5_000 });
    expect(await run(optionsB)).toBe(0);
    expect(optionsB.lines).toEqual([consumedByB]);
    const offsetAfterB = (await cursorOffsets(cursorPath))[spoolPath("w9:pB", stateDir)];
    expect(offsetAfterB).toBeGreaterThan(0);

    // Waiter A now consumes an event on pA and exits. It must not touch pB's offset.
    const consumedByA = await appendEvent(stateDir, "w9:pA", "a-1");
    expect(await waiterA).toBe(0);
    expect(optionsA.lines).toEqual([consumedByA]);
    expect((await cursorOffsets(cursorPath))[spoolPath("w9:pB", stateDir)]).toBe(offsetAfterB);

    // A later waiter on pB must time out instead of replaying b-1.
    const optionsLate = waiter(stateDir, cursorPath, { paneIds: ["w9:pB"], timeoutMs: 200 });
    expect(await run(optionsLate)).toBe(2);
    expect(optionsLate.lines).toEqual([]);
  });

  test("concurrent waiters on the same spool never deliver the same event twice", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await writeFile(spoolPath("w3:p1", stateDir), "", "utf8");

    const first = waiter(stateDir, cursorPath, { paneIds: ["w3:p1"], timeoutMs: 5_000 });
    const second = waiter(stateDir, cursorPath, { paneIds: ["w3:p1"], timeoutMs: 5_000 });
    const runs = [run(first), run(second)];
    await registered(cursorPath, stateDir, ["w3:p1"]);
    await appendEvent(stateDir, "w3:p1", "one");
    await appendEvent(stateDir, "w3:p1", "two");

    expect(await Promise.all(runs)).toEqual([0, 0]);
    const delivered = [...first.lines, ...second.lines].sort();
    expect(delivered).toEqual([event("w3:p1", "one"), event("w3:p1", "two")].sort());
  });

  test("timeout consumes nothing and leaves the cursor untouched", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await appendFile(spoolPath("w4:p1", stateDir), `${event("w4:p1", "old")}\n`, "utf8");

    // Startup registers the spool at EOF, so pre-existing history is skipped.
    const options = waiter(stateDir, cursorPath, { paneIds: ["w4:p1"], timeoutMs: 150 });
    expect(await run(options)).toBe(2);
    expect(options.lines).toEqual([]);

    const size = (await readFile(spoolPath("w4:p1", stateDir), "utf8")).length;
    expect((await cursorOffsets(cursorPath))[spoolPath("w4:p1", stateDir)]).toBe(size);
  });

  test("a recreated spool smaller than its stored offset restarts from the top", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    const spool = spoolPath("w5:p1", stateDir);
    await writeFile(cursorPath, `${JSON.stringify({ [spool]: 9_999 })}\n`, "utf8");
    const line = event("w5:p1", "fresh");
    await writeFile(spool, `${line}\n`, "utf8");

    const options = waiter(stateDir, cursorPath, { paneIds: ["w5:p1"], timeoutMs: 3_000 });
    expect(await run(options)).toBe(0);
    expect(options.lines).toEqual([line]);
  });

  test("partial lines stay unconsumed until the newline arrives", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    const spool = spoolPath("w6:p1", stateDir);
    await writeFile(spool, "", "utf8");

    const options = waiter(stateDir, cursorPath, { paneIds: ["w6:p1"], timeoutMs: 3_000 });
    const running = run(options);
    await registered(cursorPath, stateDir, ["w6:p1"]);
    const line = event("w6:p1", "whole");
    await appendFile(spool, line, "utf8");
    await Bun.sleep(80);
    expect(options.lines).toEqual([]);
    await appendFile(spool, "\n", "utf8");

    expect(await running).toBe(0);
    expect(options.lines).toEqual([line]);
  });
});

describe("herdr-ping-wait follow mode", () => {
  test("streams every event across spools without duplicates until aborted", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await writeFile(spoolPath("w7:p1", stateDir), "", "utf8");
    await writeFile(spoolPath("w7:p2", stateDir), "", "utf8");

    const controller = new AbortController();
    const options = waiter(stateDir, cursorPath, {
      paneIds: ["w7:p1", "w7:p2"],
      follow: true,
      signal: controller.signal,
    });
    const running = run(options);
    await registered(cursorPath, stateDir, ["w7:p1", "w7:p2"]);

    const expected = [
      await appendEvent(stateDir, "w7:p1", "one"),
      await appendEvent(stateDir, "w7:p2", "two"),
      await appendEvent(stateDir, "w7:p1", "three"),
    ];
    while (options.lines.length < 3) await Bun.sleep(20);
    controller.abort();

    expect(await running).toBe(0);
    expect(options.lines.sort()).toEqual([...expected].sort());
  });

  test("bounded follow session exits 0 after delivering, 2 when nothing arrived", async () => {
    const stateDir = await temporaryDirectory();
    const cursorPath = join(stateDir, "cursor.json");
    await writeFile(spoolPath("w8:p1", stateDir), "", "utf8");

    const empty = waiter(stateDir, cursorPath, { paneIds: ["w8:p1"], follow: true, timeoutMs: 150 });
    expect(await run(empty)).toBe(2);

    const busy = waiter(stateDir, cursorPath, { paneIds: ["w8:p1"], follow: true, timeoutMs: 600 });
    const running = run(busy);
    await registered(cursorPath, stateDir, ["w8:p1"]);
    await appendEvent(stateDir, "w8:p1", "one");
    expect(await running).toBe(0);
    expect(busy.lines).toHaveLength(1);
  });
});
