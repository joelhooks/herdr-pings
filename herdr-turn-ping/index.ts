import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAIL_LIMIT = 500;
const TOAST_BODY_LIMIT = 200;

const HEX_ERRORS = [
	"+++ Out Of Cheese Error. Redo From Start +++",
	"+++ Divide By Cucumber Error. Please Reinstall Universe And Reboot +++",
	"+++ Melon Melon Melon +++",
	"+++ Whoops! Here Comes The Cheese! +++",
	"+++ Mine! Waah! +++",
	"+++ Error At Address: 14, Treacle Mine Road +++",
];

type CachedAssistant = {
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
};

type CurrentPaneResponse = {
	result?: { pane?: { pane_id?: unknown; label?: unknown } };
};

type PaneIdentity = {
	paneId: string;
	label: string;
};

function resolvePane(): PaneIdentity | undefined {
	const fromEnvironment = process.env.HERDR_PANE_ID?.trim();

	try {
		const output = execFileSync("herdr", ["pane", "current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		});
		const pane = (JSON.parse(output) as CurrentPaneResponse).result?.pane;
		const paneId = typeof pane?.pane_id === "string" ? pane.pane_id.trim() : "";
		if (paneId && (!fromEnvironment || paneId === fromEnvironment)) {
			const label = typeof pane?.label === "string" ? pane.label.trim() : "";
			return { paneId, label: label || paneId };
		}
	} catch {}

	return fromEnvironment ? { paneId: fromEnvironment, label: fromEnvironment } : undefined;
}

function errorToastBody(error: string | undefined): string {
	const garnish = HEX_ERRORS[Math.floor(Math.random() * HEX_ERRORS.length)];
	const separator = " ";
	const available = TOAST_BODY_LIMIT - garnish.length - separator.length;
	const head = error?.split("\n", 1)[0]?.trim() || "Pi turn failed";
	return `${garnish}${separator}${head.slice(0, available)}`;
}

function showErrorNotification(label: string, error: string | undefined): void {
	if (!process.env.HERDR_SOCKET_PATH) return;

	try {
		const child = spawn(
			"herdr",
			[
				"notification",
				"show",
				`${label} errored`,
				"--body",
				errorToastBody(error),
				"--sound",
				"request",
			],
			{ detached: true, stdio: "ignore" },
		);
		child.on("error", () => {});
		child.unref();
	} catch {}
}

function assistantText(message: CachedAssistant | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function tail(value: string): string | undefined {
	if (!value) return undefined;
	return value.slice(-TAIL_LIMIT);
}

function safeFilename(paneId: string): string {
	return `${paneId.replaceAll(":", "-")}.jsonl`;
}

export default function herdrTurnPing(pi: ExtensionAPI) {
	const pane = resolvePane();
	if (!pane) return;
	const { paneId } = pane;

	const spoolDirectory = join(homedir(), ".local", "state", "herdr-pings");
	const spoolPath = join(spoolDirectory, safeFilename(paneId));
	let latestAssistant: CachedAssistant | undefined;
	let latestTurnIndex: number | undefined;
	let session: string | undefined;
	let writeQueue = Promise.resolve();
	let notifiedOfWriteFailure = false;

	pi.on("agent_start", () => {
		latestAssistant = undefined;
		latestTurnIndex = undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		session = ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile();
		latestAssistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant") as CachedAssistant | undefined;
	});

	pi.on("turn_end", (event) => {
		latestTurnIndex = event.turnIndex;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const message = latestAssistant;
		const lastMessageTail = tail(assistantText(message));
		const record: Record<string, unknown> = {
			event: message?.stopReason === "error" ? "turn_error" : "turn_ended",
			pane_id: paneId,
			timestamp: new Date().toISOString(),
		};

		if (session) record.session = session;
		const callsign = process.env.HERDR_CALLSIGN?.trim();
		if (callsign) record.callsign = callsign;
		if (latestTurnIndex !== undefined) record.turn_index = latestTurnIndex;
		if (lastMessageTail !== undefined) record.last_message_tail = lastMessageTail;
		if (message?.stopReason === "error" && message.errorMessage) {
			record.error = message.errorMessage;
		}

		const line = `${JSON.stringify(record)}\n`;
		writeQueue = writeQueue
			.then(async () => {
				await mkdir(spoolDirectory, { recursive: true });
				await appendFile(spoolPath, line, "utf8");
				if (record.event === "turn_error") {
					showErrorNotification(pane.label, message?.errorMessage);
				}
			})
			.catch((error: unknown) => {
				if (notifiedOfWriteFailure) return;
				notifiedOfWriteFailure = true;
				ctx.ui.notify(
					`herdr-turn-ping could not append ${spoolPath}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});

		return writeQueue;
	});
}
