# herdr-pings

Turn-level wake events for agents in [herdr](https://github.com/ogulcancelik/herdr) panes.

This repo contains:

- `herdr-turn-ping/`: a Pi extension that appends one event after a run fully settles.
- `herdr-ping-wait/`: a Bun CLI that waits for and consumes the next complete event.
- `herdr-name-sync/`: a Pi extension that mirrors the session name onto the herdr pane label.
- `herdr-callsign/`: a Pi extension that gives each worker a Discworld identity as its herdr agent name (agent names are herdr send/wait targets), stamped onto spool events as `callsign`. The base name is stable per pane (300-resident Pratchett-dex); a Pratchett-register mood adjective is drawn per session — `Scunnered Vimes` today, `Chipper Vimes` tomorrow.
- `bridge/` + `actions/` + `herdr-plugin.toml`: a herdr plugin that appends `pane_exited`/`pane_closed` to the same spool (crash detection for any pane), raises error-only toasts, and ships `setup`/`doctor` actions.

Preferred install is the herdr plugin: `herdr plugin install joelhooks/herdr-pings`, then invoke the `setup` action. The manual symlink steps below remain for pi-only use.

## The fun parts

- **Whois:** `herdr-whois` gives a live roll call with callsigns, pane labels, and each worker's latest event. Add `--all` to see the departed.
- **The Luggage:** `herdr plugin action invoke luggage --plugin herdr-pings` eats only dead-pane spool debris older than seven days and orphaned cursor entries. It announces the menu before dining.
- **Death notices:** closed and exited panes leave lifecycle events behind, with error-only toasts when a worker dies badly.
- **Hex errors:** a failing doctor signs off with one of Hex's deeply unhelpful errors.
- **Mood drift:** moods drift with events; after three straight errors the worker is renamed Rincewind.
- **GNU Terry Pratchett:** a healthy doctor keeps the clacks overhead moving.

## Spool contract

Events are appended to `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`. Each JSONL record requires:

- `event`: currently `turn_ended` or `turn_error`
- `pane_id`: the raw herdr pane ID
- `timestamp`: an ISO-8601 UTC timestamp

Records may include extra fields such as `session`, `turn_index`, `last_message_tail`, and `error`. Readers must tolerate unknown event names and extra fields. Readers keep byte-offset cursors and never truncate spool files.

## Optional Convex stream

Convex delivery is **off by default** and never reads, writes, delays, or retries through the production spool. Set both values in the environment that starts herdr/Pi to enable it:

```bash
HERDR_PINGS_CONVEX_URL=http://127.0.0.1:3211
HERDR_PINGS_CONVEX_TOKEN=<the configured Convex ingest token>
```

The bridge sends only pane/session metadata, status, bounded one-line turn summaries (280 characters), token counts, and the current Herdr workspace/tab labels. It does not send raw scrollback. Events are batched in a bounded 100-event in-memory queue. If Convex is unavailable, the batch is dropped, a local dropped-events counter is logged, and the wake-loop spool/toasts continue unchanged.

The installed Herdr plugin is a copy, not a symlink. When changing `bridge/`, copy the changed files into `~/.config/herdr/plugins/github/herdr-pings-860238933156/bridge/` before verifying; otherwise the running plugin keeps the old behavior.

The matching Convex endpoint is `POST /herdr-pings/ingest`; it requires `Authorization: Bearer <token>`. The API schema is v1. Event rows expire after seven days and are also hard-capped at 10,000 rows.

Deploy/configure the Convex side before setting bridge variables. Use an existing secret-management value; this repo deliberately does not mint or store secrets:

```bash
cd ~/Code/joelhooks/joelclaw-api
set -a; . /Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex/app-admin.env; set +a
bunx convex env set CONVEX_HERDR_PINGS_INGEST_TOKEN "$EXISTING_HERDR_PINGS_TOKEN"
bun run deploy
```

The local Convex HTTP router also requires its existing Better Auth configuration (including a non-default `BETTER_AUTH_SECRET`) before any HTTP action can answer. Verify with an authenticated POST to `http://127.0.0.1:3211/herdr-pings/ingest`, then query `paneStream:recent` through the same sourced deployment environment.

## Install

Requires [Pi](https://github.com/badlogic/pi-mono), [herdr](https://github.com/ogulcancelik/herdr), and [Bun](https://bun.sh/).

Clone the repo:

```bash
gh repo clone joelhooks/herdr-pings "$HOME/Code/joelhooks/herdr-pings"
```

Install the Pi extension:

```bash
ln -sfn "$HOME/Code/joelhooks/herdr-pings/herdr-turn-ping" "$HOME/.pi/agent/extensions/herdr-turn-ping"
```

Install the wait CLI:

```bash
mkdir -p "$HOME/.local/bin" && ln -sfn "$HOME/Code/joelhooks/herdr-pings/herdr-ping-wait/herdr-ping-wait.ts" "$HOME/.local/bin/herdr-ping-wait"
```

## Usage

```bash
herdr-ping-wait <pane_id...> [--timeout <seconds>] [--cursor <file>]
```

The CLI prints and consumes exactly one complete JSONL event. A timeout exits `2` without consuming an event. Invalid arguments or runtime failures exit `1`.

## License

MIT
