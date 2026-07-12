# Lifecycle bridge

`lifecycle.js` translates herdr pane lifecycle events into the same append-only spool used by `herdr-turn-ping`.

The proposed plugin manifest fragment is in `manifest-snippet.toml`. It intentionally listens only for `pane.exited` and `pane.closed`. `pane.agent_status_changed` reports heuristic agent state changes, not pane death, so it adds noise rather than a reliable lifecycle signal.

## Event semantics

Verified against herdr 0.7.3 / protocol 16 with `herdr api schema --json` and a temporary linked plugin:

- `pane.exited` fires when the pane's terminal process exits without a herdr close command. Replacing a temporary pane's shell with `sleep 300` and sending `SIGKILL` produced only `pane.exited`.
- `pane.closed` fires when herdr deliberately closes a pane with `herdr pane close`. It produced only `pane.closed`.
- Both plugin payloads have the envelope `{"event":"pane_exited|pane_closed","data":{"type":"pane_exited|pane_closed","pane_id":"…","workspace_id":"…"}}` in 0.7.3.
- Neither observed payload included an exit code or detected agent. The bridge preserves `exit_code` and `agent` if a future herdr payload adds them, but does not invent them.

The bridge emits distinct `pane_exited` and `pane_closed` records. It never emits Pi's `turn_ended` or `turn_error` events.

## Spool write

The destination is `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`. The bridge creates the directory if needed, opens the file with `O_APPEND`, and performs one write for the complete JSONL record. Invalid payloads and filesystem failures are reported to stderr without throwing an uncaught error.
