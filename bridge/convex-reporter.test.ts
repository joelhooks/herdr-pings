import { describe, expect, test } from "bun:test";

import {
  ConvexReporter,
  boundedSummary,
  createHerdrLabelLookup,
  paneEvent,
  pluginEventFromEnvironment,
} from "./convex-reporter.js";

describe("ConvexReporter", () => {
  test("enriches status events with workspace and tab labels without scrollback", () => {
    const event = pluginEventFromEnvironment(
      {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          data: {
            pane_id: "wB:p2",
            workspace_id: "wB",
            tab_id: "wB:t1",
            label: "Bridge worker",
            agent: "pi",
            agent_status: "working",
          },
        }),
      },
      () => ({ workspaceLabel: "Daily paper + memory ops", tabLabel: "Live panes" }),
    );

    expect(event).toMatchObject({
      kind: "agent_status_changed",
      paneId: "wB:p2",
      workspaceId: "wB",
      workspaceLabel: "Daily paper + memory ops",
      tabId: "wB:t1",
      tabLabel: "Live panes",
      label: "Bridge worker",
      agentKind: "pi",
      status: "working",
    });
    expect(event).not.toHaveProperty("lastMessageTail");
  });

  test("omits unavailable workspace and tab labels", () => {
    const event = pluginEventFromEnvironment(
      {
        HERDR_PLUGIN_EVENT: "pane.created",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          data: { pane_id: "wB:p2", workspace_id: "wB", tab_id: "wB:t1" },
        }),
      },
      () => ({}),
    );

    expect(event).toMatchObject({ paneId: "wB:p2", workspaceId: "wB", tabId: "wB:t1" });
    expect(event).not.toHaveProperty("workspaceLabel");
    expect(event).not.toHaveProperty("tabLabel");
  });

  test("caches one Herdr listing per bridge process", () => {
    let reads = 0;
    const lookup = createHerdrLabelLookup(() => {
      reads += 1;
      return {
        workspaces: new Map([["wB", "Daily paper + memory ops"]]),
        tabs: new Map([["wB:t1", "Live panes"]]),
      };
    });

    expect(lookup({ workspace_id: "wB", tab_id: "wB:t1" })).toEqual({
      workspaceLabel: "Daily paper + memory ops",
      tabLabel: "Live panes",
    });
    expect(lookup({ workspace_id: "wB", tab_id: "wB:t1" })).toEqual({
      workspaceLabel: "Daily paper + memory ops",
      tabLabel: "Live panes",
    });
    expect(reads).toBe(1);
  });

  test("marks exited panes closed without changing the spool event", () => {
    expect(paneEvent("pane_exited", { pane_id: "wB:p2" })).toMatchObject({
      kind: "pane_exited",
      paneId: "wB:p2",
      status: "closed",
    });
  });

  test("maps turn usage into bounded telemetry", () => {
    expect(
      paneEvent("turn_ended", {
        pane_id: "wB:p2",
        last_message_tail: "Done.\nThis must not leave the first line.",
        input_tokens: 120,
        output_tokens: 45,
        cache_read_tokens: 80,
        total_tokens: 165,
      }),
    ).toMatchObject({
      kind: "turn_ended",
      paneId: "wB:p2",
      summaryLine: "Done.",
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 80,
      totalTokens: 165,
    });
  });

  test("drops a failed delivery instead of retrying or touching the spool", async () => {
    const dropped: Array<{ count: number; reason: string }> = [];
    const reporter = new ConvexReporter({
      url: "http://convex.test",
      token: "test-token",
      flushDelayMs: 60_000,
      fetchImpl: async () => new Response("down", { status: 503 }),
      onDrop: (drop) => dropped.push(drop),
    });

    reporter.enqueue({ eventId: "e1", kind: "turn_ended", paneId: "wB:p2", timestamp: 1 });
    await reporter.flushNow();

    expect(reporter.droppedEvents).toBe(1);
    expect(dropped).toEqual([{ count: 1, droppedEvents: 1, reason: "HTTP 503" }]);
    expect(reporter.queue).toEqual([]);
  });

  test("keeps only a bounded one-line summary", () => {
    expect(boundedSummary(`first line\n${"secret ".repeat(100)}`)).toBe("first line");
    expect(boundedSummary("x".repeat(400))).toHaveLength(280);
  });
});
