import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Mirrors the pi session name onto the herdr pane label. Sessions set their
 * name reliably (set_session_name is mandatory in the system prompt); pane
 * naming was prompt-compliance-only. This makes it plumbing: whenever the
 * session name changes, the pane label follows.
 *
 * Pi exposes no session-rename event, so the name is sampled at turn
 * boundaries — the set_session_name tool call lands within a turn, so the
 * label syncs when that turn settles.
 */
export default function herdrNameSync(pi: ExtensionAPI) {
	const paneId = process.env.HERDR_PANE_ID?.trim();
	if (!paneId || !process.env.HERDR_SOCKET_PATH) return;

	let lastSynced: string | undefined;

	const sync = () => {
		let name: string | undefined;
		try {
			name = pi.getSessionName();
		} catch {
			return;
		}
		if (!name || name === lastSynced) return;
		lastSynced = name;
		try {
			const child = spawn("herdr", ["pane", "rename", paneId, name], {
				detached: true,
				stdio: "ignore",
			});
			child.on("error", () => {});
			child.unref();
		} catch {}
	};

	pi.on("agent_start", sync);
	pi.on("agent_settled", sync);
	pi.on("session_shutdown", sync);
}
