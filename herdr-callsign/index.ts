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

// The Pratchett-dex: 300 Discworld residents. Add freely; order matters only
// for the deterministic pane-id hash, so append rather than reshuffle.
const CALLSIGNS = [
	"Vimes", "Sybil", "Ramkin", "Carrot", "Ironfoundersson", "Angua", "Nobby", "Nobbs",
	"Colon", "Detritus", "Cheery", "Littlebottom", "Dorfl", "Reg", "Visit", "Igor",
	"Igorina", "Sally", "Humpeding", "Swires", "Buggy", "Pessimal", "Willikins", "Keel",
	"Quirke", "Snapcase", "Winder", "Swing", "Stoneface", "Feeney", "Upshot", "Stratford",
	"Flutter", "Stinky", "YoungSam", "Cuddy", "Hancock", "Gaskin", "Boggis", "Wonse",
	"Vetinari", "Havelock", "Drumknott", "Rufus", "Downey", "Slant", "Cruces", "Teatime",
	"Inigo", "Skimmer", "Rincewind", "Ridcully", "Mustrum", "Hughnon", "Ponder", "Stibbons",
	"Librarian", "Ook", "Bursar", "Windle", "Poons", "Hex", "Hix", "Runes",
	"Turnipseed", "Skazz", "Coin", "Ipslore", "Trymon", "Galder", "Spelter", "Worblehat",
	"Henry", "Ludmilla", "Schleppel", "Cake", "Bucket", "Whitlow", "Modo", "Twoflower",
	"Bethan", "Cohen", "Hrun", "Kring", "Luggage", "Granny", "Weatherwax", "Esme",
	"Esmerelda", "Nanny", "Ogg", "Gytha", "Magrat", "Garlick", "Agnes", "Nitt",
	"Perdita", "Tiffany", "Aching", "Petulia", "Annagramma", "Tick", "Treason", "Level",
	"Proust", "Earwig", "Diamanda", "Lilith", "Aliss", "Hodgesaargh", "Greebo", "Shawn",
	"Jason", "Verence", "Felmet", "Tomjon", "Hwel", "Oats", "Mightily", "Vlad",
	"Lacrimosa", "Magpyr", "Scraps", "Casanunda", "Millie", "Letitia", "Preston", "Roland",
	"Amber", "Horace", "Jeannie", "Rob", "Wullie", "Hamish", "BigYan", "WeeMadArthur",
	"Death", "Mort", "Ysabell", "Albert", "Susan", "Binky", "Quoth", "Lobsang",
	"LuTze", "Jeremy", "Myria", "Unity", "Kaos", "Ronnie", "Azrael", "War",
	"Famine", "Pestilence", "Cutwell", "Keli", "Imp", "Buddy", "Glod", "Cliff",
	"Asphalt", "Wen", "Clodpool", "Twyla", "Gawain", "Banjo", "Chickenwire", "Violet",
	"Bilious", "Moist", "Lipwig", "Adora", "Dearheart", "Groat", "Stanley", "Pump",
	"Anghammarad", "Gilt", "Bent", "Cosmo", "Pucci", "Fusspot", "Hubert", "Topsy",
	"Spools", "Gladys", "Tiddles", "Simnel", "Girder", "Thunderbolt", "Harry", "William",
	"Deworde", "Sacharissa", "Cripslock", "Otto", "Chriek", "Goodmountain", "Dibbler", "Throat",
	"Pin", "Tulip", "Brutha", "Om", "Vorbis", "Didactylos", "Urn", "Simony",
	"Teppic", "Ptraci", "Dios", "Youbastard", "Ptaclusp", "Chidder", "Eric", "Astfgl",
	"Quezovercoatl", "Victor", "Ginger", "Soll", "Gaffer", "Laddie", "Truckle", "Caleb",
	"Saveloy", "Willie", "Butterfly", "Ahmed", "Goriff", "Jabbar", "Scrappy", "Wolfgang",
	"Serafine", "Gavin", "Dee", "Rhys", "Albrecht", "Polly", "Perks", "Jackrum",
	"Blouse", "Maladict", "Wazzer", "Tonker", "Shufti", "Lofty", "Strappi", "Froc",
	"Nutt", "Glenda", "Trev", "Likely", "Juliet", "Pepe", "Sharn", "Bledlow",
	"Maurice", "Beans", "Peaches", "Darktan", "Sardines", "Hamnpork", "Malicia", "Keith",
	"Brick", "Ardent", "Shine", "Bashfullsson", "Tawneee", "Hamcrusher", "Chrysoprase", "Bloodaxe",
	"Ironhammer", "Coalface", "Anoia", "Offler", "Io", "Fate", "Nuggan", "Errol",
	"Wuffles", "Gaspode", "Atuin", "Berilia", "Tubul", "Jerakeen", "Leonard", "Cribbins",
	"Rosie", "Palm", "Tilden", "Jethro", "Conina", "Nijel", "Creosote", "Abrim",
	"Carding", "Ella", "Saturday", "Legba",
];

// Pratchett-register emotional states, drawn at random per session and mixed
// with the stable pane name: "Scunnered Vimes" today, "Chipper Vimes" tomorrow.
const MOODS = [
	"Scunnered", "Fashed", "Forfochten", "Swithering", "Thrawn", "Crabbit", "Wabbit", "Glaikit",
	"Dreich", "Ramfeezled", "Vexed", "Perturbed", "Discombobulated", "Overwrought", "Melancholy", "Fretful",
	"Truculent", "Lugubrious", "Dyspeptic", "Splenetic", "Wrathful", "Serene", "Smug", "Baffled",
	"Befuddled", "Bewildered", "Flummoxed", "Crabby", "Cantankerous", "Grumpy", "Cheerful", "Gloomy",
	"Morose", "Jubilant", "Perplexed", "Suspicious", "Indignant", "Sheepish", "Skittish", "Stoic",
	"Manic", "Placid", "Peevish", "Sullen", "Giddy", "Wistful", "Frazzled", "Ornery",
	"Huffy", "Snippy", "Testy", "Jittery", "Antsy", "Mopey", "Chipper", "Zealous",
	"Furtive", "Brooding", "Exasperated", "Flustered", "Rattled", "Weary", "Knackered", "Chuffed",
	"Miffed", "Narked", "Mardy", "Crotchety", "Waspish", "Livid", "Bemused", "Nonplussed",
	"Aggrieved", "Petulant", "Maudlin", "Fey", "Stroppy", "Shirty", "Dour", "Fractious",
	"Querulous", "Irascible", "Choleric", "Sanguine", "Phlegmatic", "Bilious", "Apoplectic", "Distraught",
	"Forlorn", "Doleful", "Woebegone", "Crestfallen", "Despondent", "Elated", "Euphoric", "Insouciant",
	"Blithe", "Jaunty", "Perky", "Twitchy", "Haunted", "Harried", "Hangdog", "Grim",
	"Bursarial", "Gnomic",
];

function hash(value: string): number {
	let h = 5381;
	for (let i = 0; i < value.length; i += 1) h = (h * 33) ^ value.charCodeAt(i);
	return h >>> 0;
}

type AgentEntry = { pane_id?: unknown; name?: unknown };
type CachedAssistant = { stopReason?: string };

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
	let ownsCallsign = false;
	let base: string | undefined;
	let originalMood: string | undefined;
	let currentCallsign: string | undefined;
	let latestAssistant: CachedAssistant | undefined;
	let runStartedAt: number | undefined;
	let consecutiveErrors = 0;
	let consecutiveCleans = 0;
	let errorLevel = 0;

	const rename = (callsign: string) => {
		if (!ownsCallsign || callsign === currentCallsign) return;
		try {
			execFileSync("herdr", ["agent", "rename", paneId, callsign], {
				stdio: "ignore",
				timeout: 2_000,
			});
			currentCallsign = callsign;
			process.env.HERDR_CALLSIGN = callsign;
		} catch {
			// A failed rename is not a transition; retry if a later event wants it.
		}
	};

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

			// Other agents' base names ("Scunnered Vimes" -> "Vimes") block reuse.
			const takenBases = new Set(
				agents
					.filter((agent) => agent.pane_id !== paneId)
					.map((agent) => (typeof agent.name === "string" ? agent.name.trim() : ""))
					.filter(Boolean)
					.map((name) => name.split(" ").at(-1) as string),
			);
			const start = hash(paneId) % CALLSIGNS.length;
			for (let step = 0; step < CALLSIGNS.length; step += 1) {
				const candidate = CALLSIGNS[(start + step) % CALLSIGNS.length];
				if (!takenBases.has(candidate)) {
					base = candidate;
					break;
				}
			}
			if (!base) base = `${CALLSIGNS[start]}-${paneId.replaceAll(":", "-")}`;
			originalMood = MOODS[Math.floor(Math.random() * MOODS.length)];
			const callsign = `${originalMood} ${base}`;

			execFileSync("herdr", ["agent", "rename", paneId, callsign], {
				stdio: "ignore",
				timeout: 2_000,
			});
			process.env.HERDR_CALLSIGN = callsign;
			currentCallsign = callsign;
			ownsCallsign = true;
			assigned = true;
		} catch {
			// herdr busy/absent — retry at the next turn boundary
		}
	};

	pi.on("agent_start", () => {
		tryAssign();
		latestAssistant = undefined;
		runStartedAt = Date.now();
	});

	pi.on("agent_end", (event) => {
		latestAssistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant") as CachedAssistant | undefined;
	});

	pi.on("agent_settled", () => {
		tryAssign();
		if (!ownsCallsign || !base || !originalMood) return;

		const errored = latestAssistant?.stopReason === "error";
		const ranLong = runStartedAt !== undefined && Date.now() - runStartedAt > 10 * 60 * 1_000;
		runStartedAt = undefined;

		if (errored) {
			consecutiveErrors += 1;
			consecutiveCleans = 0;
			errorLevel = Math.min(3, consecutiveErrors);
			if (errorLevel === 1) rename(`Vexed ${base}`);
			else if (errorLevel === 2) rename(`Apoplectic ${base}`);
			else {
				// Rincewind is a temporary demotion; recovery restores the resident base.
				rename("Rincewind");
			}
			return;
		}

		consecutiveCleans += 1;
		consecutiveErrors = 0;
		if (errorLevel >= 2) {
			errorLevel = 1;
			rename(`Vexed ${base}`);
			return;
		}
		if (errorLevel === 1) {
			errorLevel = 0;
			rename(`${originalMood} ${base}`);
			return;
		}
		if (ranLong) {
			rename(`Forfochten ${base}`);
			return;
		}
		if (consecutiveCleans >= 2) rename(`Serene ${base}`);
	});
}
