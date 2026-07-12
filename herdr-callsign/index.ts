import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Gives every pi worker a stable, memorable identity: a Discworld callsign
 * set as its herdr AGENT name. Agent names double as herdr send/wait targets,
 * so orchestrators can `herdr agent wait Vimes` instead of juggling pane ids.
 *
 * The callsign is deterministic from the pane id (a pane keeps its callsign
 * across sessions), walking forward past names already in use by other panes.
 * If the agent already has a name, it is adopted, never overwritten.
 *
 * The chosen callsign is exported as HERDR_CALLSIGN so sibling extensions
 * (herdr-turn-ping) can stamp it onto spool events.
 */

const CALLSIGNS = [
	"Vimes", "Vetinari", "Rincewind", "Ridcully", "Granny", "Nanny", "Magrat", "Tiffany",
	"Carrot", "Angua", "Nobby", "Colon", "Detritus", "Cheery", "Dorfl", "Moist",
	"Adora", "Gaspode", "Twoflower", "Ponder", "Librarian", "Luggage", "Binky", "Susan",
	"Mort", "Ysabell", "Albert", "Dibbler", "Leonard", "Drumknott", "Sybil", "Willikins",
	"Igor", "Otto", "William", "Sacharissa", "Greebo", "Agnes", "Perdita", "Brutha",
	"Om", "Cohen", "Teatime", "Hex", "Glenda", "Nutt", "LuTze", "Lobsang",
	"Anoia", "Errol", "Wuffles", "Downey", "Slant", "Groat", "Stanley", "Pessimal",
	"Casanunda", "Hwel", "Tomjon", "Verence", "Shawn", "Esk", "Simon", "Death",
];

function hash(value: string): number {
	let h = 5381;
	for (let i = 0; i < value.length; i += 1) h = (h * 33) ^ value.charCodeAt(i);
	return h >>> 0;
}

type AgentEntry = { pane_id?: unknown; name?: unknown };

function herdrJson(args: string[]): unknown {
	const output = execFileSync("herdr", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
	});
	return JSON.parse(output);
}

export default function herdrCallsign(pi: ExtensionAPI) {
	const paneId = process.env.HERDR_PANE_ID?.trim();
	if (!paneId || !process.env.HERDR_SOCKET_PATH) return;

	let assigned = false;

	const tryAssign = () => {
		if (assigned) return;
		try {
			const list = herdrJson(["agent", "list"]) as {
				result?: { agents?: AgentEntry[] };
			};
			const agents = list.result?.agents ?? [];
			const self = agents.find((agent) => agent.pane_id === paneId);
			if (!self) return; // detection hasn't seen this pane yet; retry on next event

			const existing = typeof self.name === "string" ? self.name.trim() : "";
			if (existing) {
				process.env.HERDR_CALLSIGN = existing;
				assigned = true;
				return;
			}

			const taken = new Set(
				agents
					.filter((agent) => agent.pane_id !== paneId)
					.map((agent) => (typeof agent.name === "string" ? agent.name.trim() : ""))
					.filter(Boolean),
			);
			const start = hash(paneId) % CALLSIGNS.length;
			let callsign: string | undefined;
			for (let step = 0; step < CALLSIGNS.length; step += 1) {
				const candidate = CALLSIGNS[(start + step) % CALLSIGNS.length];
				if (!taken.has(candidate)) {
					callsign = candidate;
					break;
				}
			}
			if (!callsign) callsign = `${CALLSIGNS[start]}-${paneId.replaceAll(":", "-")}`;

			execFileSync("herdr", ["agent", "rename", paneId, callsign], {
				stdio: "ignore",
				timeout: 2_000,
			});
			process.env.HERDR_CALLSIGN = callsign;
			assigned = true;
		} catch {
			// herdr busy/absent — retry at the next turn boundary
		}
	};

	pi.on("agent_start", tryAssign);
	pi.on("agent_settled", tryAssign);
}
