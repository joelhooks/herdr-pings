# herdr-ping-wait

Wait for the next complete Pi turn event from one or more herdr pane spools.

## Install

Requires [Bun](https://bun.sh/).

```bash
chmod +x "$HOME/Code/joelhooks/herdr-pings/herdr-ping-wait/herdr-ping-wait.ts"
mkdir -p "$HOME/.local/bin"
ln -sfn "$HOME/Code/joelhooks/herdr-pings/herdr-ping-wait/herdr-ping-wait.ts" \
  "$HOME/.local/bin/herdr-ping-wait"
```

## Usage

```bash
herdr-ping-wait <pane_id...> [--timeout <seconds>] [--cursor <file>] [--follow] [--output <file>]
```

Examples:

```bash
herdr-ping-wait wF:p1 wF:p2
herdr-ping-wait wF:p1 --timeout 30
herdr-ping-wait wF:p1 --cursor ~/.local/state/herdr-pings/claude-orchestrator.json
herdr-ping-wait wF:p1 wF:p2 --follow --output /tmp/worker-events.jsonl
```

- Events are read from `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`.
- The default consumer cursor is `~/.local/state/herdr-pings/cursor.json`.
- A new cursor starts at each spool's current EOF, so old history is not replayed.
- One invocation prints and consumes exactly one complete JSONL line (unless `--follow`).
- Partial lines remain unconsumed until their trailing newline arrives.
- Timeout exits `2` without consuming anything. Bad arguments or runtime failures exit `1`.
- `--state-dir <dir>` overrides the spool directory (tests and smoke checks).

## Cursor integrity

Concurrent waiters are safe. Every cursor read-modify-write happens under an
exclusive lock file (`<cursor>.lock`), the cursor is reloaded from disk inside
the lock, and a consume updates only the consumed spool's offset. A long-lived
waiter can no longer rewind offsets that a sibling waiter advanced meanwhile —
the failure that replayed already-consumed `turn_ended` events during the
2026-07-24 mega-dev fan-out (pane `w25:p2V`).

- A lock older than 10 s is treated as abandoned and stolen.
- A spool smaller than its stored offset (deleted and recreated, e.g. by the
  Luggage) restarts from byte 0 instead of hanging.
- Waiters killed at any point never lose consumed events: the offset is
  persisted before the event is printed.

## Long waits: `--follow` or re-arming

Harness background tasks often cap around 10 minutes, and re-arming a one-shot
waiter every cap costs a wasted wake per quiet window. Two supported patterns:

1. **Detached follow daemon (canonical for steering sessions).** Start one
   follow-mode waiter detached from the harness, then tail its output file
   with whatever file-watching primitive the harness offers (e.g. Claude
   Code's Monitor tool, `tail -f`, or a wait-for-line helper):

   ```bash
   nohup herdr-ping-wait w25:p2 w25:p3 --follow \
     --output ~/.local/state/herdr-pings/steering-events.jsonl \
     >/dev/null 2>&1 & echo $! > /tmp/ping-wait.pid
   ```

   Each consumed event is appended to `--output` as one JSONL line, exactly
   once. Kill the daemon (`kill $(cat /tmp/ping-wait.pid)`) at wrap-up.
   With `--timeout`, follow mode is a bounded session: exit `0` if it
   delivered at least one event, `2` if the window stayed quiet.

2. **One-shot re-arm.** Keep calling the classic form with `--timeout`; the
   locked cursor makes overlapping or repeated invocations safe. Exit `2`
   just means "quiet window", not failure.
