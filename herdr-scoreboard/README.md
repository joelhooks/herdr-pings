# herdr-scoreboard

Pi extension that publishes the live worker scoreboard into Herdr 0.7.4 custom pane tokens.

At `session_start` and every `agent_settled`, it reports:

- `$task`: current Pi session name
- `$turn`: human turn number plus the last settled outcome (`✅` or `💥`)
- `$age`: time since the last settled event
- blocked state label: `NEEDS JOEL`

The reporter uses source `user:herdr-pings.scoreboard.v1`, a persisted monotonic sequence per pane, and a 30-minute TTL lease. Age and lease replay run on a coarse 12-minute boundary, so `12m quiet` renders without one report per pane per minute. A failed report retries after 15 seconds. The same lease refresh republishes volatile metadata after a Herdr server restart within 12 minutes; the next settled turn republishes immediately.

Structured stage logs live at:

```text
~/.local/state/herdr-pings/scoreboard/<pane-id>.jsonl
```

Trace the current pane with:

```bash
herdr-scoreboard-trace
```

Or name a pane explicitly:

```bash
herdr-scoreboard-trace w0:p2
```

The trace returns current Herdr tokens, the last settled spool event, and recent reporter stage logs as JSON.
