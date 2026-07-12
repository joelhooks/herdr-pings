# herdr-name-sync

Pi extension that mirrors the session name onto the herdr pane label.

Pi sessions name themselves reliably (`set_session_name`). Pane labels relied on
prompt compliance. This extension removes the gap: at each turn boundary it reads
`pi.getSessionName()` and, when it changed, runs
`herdr pane rename <pane> <session name>` (detached, fire-and-forget).

No-ops outside a herdr pane (`HERDR_PANE_ID` / `HERDR_SOCKET_PATH` absent).
A failed rename never affects the session.

## Install

```bash
ln -sfn "$(pwd)/herdr-name-sync" ~/.pi/agent/extensions/herdr-name-sync
```

Or run the repo's `setup` plugin action, which manages this link alongside the others.
