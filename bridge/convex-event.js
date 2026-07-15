#!/usr/bin/env bun

const { ConvexReporter, pluginEventFromEnvironment } = require("./convex-reporter.js");

async function main() {
  const event = pluginEventFromEnvironment();
  if (!event) return;
  const reporter = new ConvexReporter({
    onDrop: ({ count, droppedEvents, reason }) =>
      console.error(`herdr-pings: dropped ${count} Convex event(s), ${droppedEvents} total: ${reason}`),
  });
  reporter.enqueue(event);
  await reporter.flushNow();
}

void main();
