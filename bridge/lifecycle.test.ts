import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const LIFECYCLE = join(import.meta.dir, "lifecycle.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fakeHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "herdr-lifecycle-"));
  temporaryDirectories.push(path);
  return path;
}

function stateDir(home: string): string {
  return join(home, ".local", "state", "herdr-pings");
}

function spoolFile(home: string, paneId: string): string {
  return join(stateDir(home), `${paneId.replaceAll(":", "-")}.jsonl`);
}

function sidecarFile(home: string, paneId: string): string {
  return join(stateDir(home), "agent-status", `${paneId.replaceAll(":", "-")}.json`);
}

function runLifecycle(home: string, event: string, data: Record<string, unknown>): { stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", LIFECYCLE], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      HERDR_PLUGIN_EVENT: event,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event, data }),
      // Label lookup must fail fast instead of talking to the real herdr server.
      HERDR_BIN: "/usr/bin/false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stderr: result.stderr.toString(), exitCode: result.exitCode ?? -1 };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function spoolEvents(home: string, paneId: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(spoolFile(home, paneId), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("early-crash watchdog (agent_exited_early)", () => {
  test("an agent status event with an agent label records a sidecar, not a spool write", async () => {
    const home = await fakeHome();
    const run = runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent_status: "working",
      agent: "pi",
    });
    expect(run.exitCode).toBe(0);

    const sidecar = JSON.parse(await readFile(sidecarFile(home, "w1:p2"), "utf8")) as Record<string, unknown>;
    expect(sidecar.agent).toBe("pi");
    expect(await exists(spoolFile(home, "w1:p2"))).toBe(false);
  });

  test("agent label vanishing before the first spool write emits a synthetic agent_exited_early", async () => {
    const home = await fakeHome();
    runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent_status: "working",
      agent: "pi",
    });
    // The pi process dies before any turn settles: next status event has no agent.
    const run = runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent_status: "unknown",
    });
    expect(run.exitCode).toBe(0);

    const events = await spoolEvents(home, "w1:p2");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "agent_exited_early",
      synthetic: true,
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "unknown",
    });
    expect(await exists(sidecarFile(home, "w1:p2"))).toBe(false);
  });

  test("no synthetic event when the spool already has turn history", async () => {
    const home = await fakeHome();
    runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w2:p3",
      agent_status: "working",
      agent: "pi",
    });
    await writeFile(
      spoolFile(home, "w2:p3"),
      `${JSON.stringify({ event: "turn_ended", pane_id: "w2:p3" })}\n`,
      "utf8",
    );

    const run = runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w2:p3",
      agent_status: "done",
    });
    expect(run.exitCode).toBe(0);

    const events = await spoolEvents(home, "w2:p3");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("turn_ended");
    expect(await exists(sidecarFile(home, "w2:p3"))).toBe(false);
  });

  test("no synthetic event for panes where no agent was ever detected (plain shell churn)", async () => {
    const home = await fakeHome();
    const run = runLifecycle(home, "pane.agent_status_changed", {
      pane_id: "w3:p1",
      agent_status: "done",
    });
    expect(run.exitCode).toBe(0);
    expect(await exists(spoolFile(home, "w3:p1"))).toBe(false);
    expect(await exists(sidecarFile(home, "w3:p1"))).toBe(false);
  });

  test("repeated agent-gone events emit at most one synthetic event", async () => {
    const home = await fakeHome();
    runLifecycle(home, "pane.agent_status_changed", { pane_id: "w4:p1", agent_status: "working", agent: "pi" });
    runLifecycle(home, "pane.agent_status_changed", { pane_id: "w4:p1", agent_status: "unknown" });
    runLifecycle(home, "pane.agent_status_changed", { pane_id: "w4:p1", agent_status: "done" });

    const events = await spoolEvents(home, "w4:p1");
    expect(events.filter((event) => event.event === "agent_exited_early")).toHaveLength(1);
  });
});

describe("pane lifecycle events (regression)", () => {
  test("pane.exited still appends pane_exited and clears any sidecar", async () => {
    const home = await fakeHome();
    await mkdir(join(stateDir(home), "agent-status"), { recursive: true });
    await writeFile(sidecarFile(home, "w5:p1"), `${JSON.stringify({ agent: "pi" })}\n`, "utf8");

    const run = runLifecycle(home, "pane.exited", {
      pane_id: "w5:p1",
      workspace_id: "w5",
      exit_code: 1,
      agent: "pi",
    });
    expect(run.exitCode).toBe(0);

    const events = await spoolEvents(home, "w5:p1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "pane_exited", pane_id: "w5:p1", exit_code: 1, agent: "pi" });
    expect(await exists(sidecarFile(home, "w5:p1"))).toBe(false);
  });

  test("pane.closed still appends pane_closed", async () => {
    const home = await fakeHome();
    const run = runLifecycle(home, "pane.closed", { pane_id: "w6:p1", workspace_id: "w6" });
    expect(run.exitCode).toBe(0);
    const events = await spoolEvents(home, "w6:p1");
    expect(events[0]).toMatchObject({ event: "pane_closed", pane_id: "w6:p1" });
  });

  test("unsupported events are ignored", async () => {
    const home = await fakeHome();
    const run = runLifecycle(home, "pane.created", { pane_id: "w7:p1" });
    expect(run.stderr).toContain("ignored unsupported plugin event");
    expect(await exists(spoolFile(home, "w7:p1"))).toBe(false);
  });
});
