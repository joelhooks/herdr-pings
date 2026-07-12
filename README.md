# herdr-pings

Turn-level wake events for agents in [herdr](https://github.com/ogulcancelik/herdr) panes.

This repo contains:

- `herdr-turn-ping/`: a Pi extension that appends one event after a run fully settles.
- `herdr-ping-wait/`: a Bun CLI that waits for and consumes the next complete event.

## Spool contract

Events are appended to `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`. Each JSONL record requires:

- `event`: currently `turn_ended` or `turn_error`
- `pane_id`: the raw herdr pane ID
- `timestamp`: an ISO-8601 UTC timestamp

Records may include extra fields such as `session`, `turn_index`, `last_message_tail`, and `error`. Readers must tolerate unknown event names and extra fields. Readers keep byte-offset cursors and never truncate spool files.

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
