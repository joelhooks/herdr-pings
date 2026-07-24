# Lifecycle bridge

`lifecycle.js` translates herdr pane lifecycle events into the same append-only spool used by `herdr-turn-ping`, and watches the agent status stream for early crashes.

The plugin manifest routes `pane.exited`, `pane.closed`, and `pane.agent_status_changed` here (see `herdr-plugin.toml`; the historical fragment is in `manifest-snippet.toml`).

## Event semantics

Verified against herdr 0.7.3 / protocol 16 with `herdr api schema --json` and a temporary linked plugin (spool semantics unchanged on 0.7.5 / protocol 17):

- `pane.exited` fires when the pane's terminal process exits without a herdr close command. Replacing a temporary pane's shell with `sleep 300` and sending `SIGKILL` produced only `pane.exited`.
- `pane.closed` fires when herdr deliberately closes a pane with `herdr pane close`. It produced only `pane.closed`.
- Both plugin payloads have the envelope `{"event":"pane_exited|pane_closed","data":{"type":"pane_exited|pane_closed","pane_id":"…","workspace_id":"…"}}` in 0.7.3.
- Neither observed payload included an exit code or detected agent. The bridge preserves `exit_code` and `agent` if a future herdr payload adds them, but does not invent them.

The bridge emits distinct `pane_exited` and `pane_closed` records. It never emits Pi's `turn_ended` or `turn_error` events.

## Early-crash watchdog (`agent_exited_early`)

Field defect (2026-07-24 mega-dev fan-out): a pi worker dying before its first
settled turn leaves no spool file, so no wake fires and steering must poll.
The pane usually survives the crash (the shell prompt comes back), so
`pane.exited` never fires either.

The watchdog closes the gap using `pane.agent_status_changed`:

- While the payload carries a detection label (`agent: "pi"` etc.), the bridge
  records a per-pane sidecar at
  `~/.local/state/herdr-pings/agent-status/<pane-id-with-dashes>.json`.
- When a later status event arrives **without** an agent label, the agent
  process is gone. If the pane's spool was never written, the bridge appends a
  synthetic record so waiters wake:

  ```json
  {"event":"agent_exited_early","synthetic":true,"pane_id":"…","agent":"pi","agent_status":"done","timestamp":"…"}
  ```

- The sidecar is deleted on agent departure, `pane.exited`, and `pane.closed`,
  and the spool-was-empty guard makes the synthetic event fire at most once.

`agent_status` values alone are NOT used as an exit signal: `done` means
"settled while unseen" (herdr `src/app/api_helpers.rs` maps `Idle` +
`seen=false` to `done`), which a healthy worker hits after every unfocused
turn. Only the disappearance of the detection label marks a process exit.

Residual blind spot: an agent that dies so fast that herdr's detection never
saw it leaves no sidecar and therefore no synthetic event. Keep
claim-before-work survival checks in orchestration briefs as the backstop.

## Spool write

The destination is `~/.local/state/herdr-pings/<pane-id-with-dashes>.jsonl`. The bridge creates the directory if needed, opens the file with `O_APPEND`, and performs one write for the complete JSONL record. Invalid payloads and filesystem failures are reported to stderr without throwing an uncaught error.
