/* eslint-disable no-console */
const axios = require("axios"),
	{ XMLParser } = require("fast-xml-parser"),
	dotenv = require("dotenv");

dotenv.config();

const REQUIRED_ENV = ["PLEX_BASE_URL", "PLEX_TOKEN"],
	missing = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missing.length > 0) {
	console.error(`Missing required environment variables: ${missing.join(", ")}. Set them in .env or your shell.`);
	process.exit(1);
}

const PLEX_BASE_URL = process.env.PLEX_BASE_URL?.replace(/\/+$/, ""),
	PLEX_TOKEN = process.env.PLEX_TOKEN,
	DRY_RUN = parseBoolean(process.env.DRY_RUN),
	LIMIT_RUN_SIZE = parsePositiveInteger(process.env.LIMIT_RUN_SIZE, null),
	CLI = parseCli(process.argv.slice(2));

if (!CLI.hubName && !CLI.listHubs) {
	console.error("Usage: node src/preserve.js --list-hubs | --hub \"Fearmongers\" [--label \"Halloween\"]");
	process.exit(1);
}

const plex = axios.create({
	baseURL: PLEX_BASE_URL,
	headers: {
		"X-Plex-Token": PLEX_TOKEN,
		"X-Plex-Client-Identifier": process.env.PLEX_CLIENT_IDENTIFIER || "plex-tmdb-sync",
		Accept: "application/xml"
	},
	timeout: 20000,
	validateStatus: (s) => s >= 200 && s < 300
});

const xml = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	textNodeName: "_text"
});

async function main() {
	console.log(`Connecting to Plex at ${PLEX_BASE_URL}`);

	const libraries = await fetchMovieLibraries();

	if (libraries.length === 0) {
		console.error("No movie libraries found.");
		process.exit(1);
	}


	if (CLI.listHubs) {
		if (CLI.listHubsTarget) {
			await listHubMovies(libraries, CLI.listHubsTarget);
		} else {
			await listAllHubs(libraries);
		}
		return;
	}

	let matchedAny = false;

	for (const lib of libraries) {
		/* eslint-disable no-await-in-loop */
		const hubInfo = await findHubInLibrary(lib.key, CLI.hubName);

		if (!hubInfo) {
			if (CLI.debug) {
				console.log(`No hub titled '${CLI.hubName}' found in '${lib.title}'.`);
			}
			continue;
		}

		console.log(`Matched hub '${hubInfo.title}' in '${lib.title}' (identifier=${hubInfo.identifier}, seed=${hubInfo.curatedHubSeed})`);

		const preview = await plex.get("/hubs/items", {
			params: {
				identifier: hubInfo.identifier,
				curatedHubSeed: hubInfo.curatedHubSeed,
				contentDirectoryID: lib.key,
				includeCollections: 0,
				includeExternalMedia: 0,
				includeAdvanced: 0,
				includeMeta: 0,
				"X-Plex-Container-Start": 0,
				"X-Plex-Container-Size": 1
			}
		});

		if (CLI.debug || CLI.debugRaw) {
			console.log("HUB XML (preview):");
			console.log(preview.data);
		}

		const previewContainer = safeParse(preview.data)?.MediaContainer,
			total = Number(previewContainer?.totalSize ?? previewContainer?.size ?? 0) || 500;

		const full = await plex.get("/hubs/items", {
			params: {
				identifier: hubInfo.identifier,
				curatedHubSeed: hubInfo.curatedHubSeed,
				contentDirectoryID: lib.key,
				includeCollections: 0,
				includeExternalMedia: 0,
				includeAdvanced: 0,
				includeMeta: 0,
				"X-Plex-Container-Start": 0,
				"X-Plex-Container-Size": total
			}
		});

		if (CLI.debug || CLI.debugRaw) {
			console.log("HUB XML (full):");
			console.log(full.data);
		}

		const container = safeParse(full.data)?.MediaContainer,
			videos = ensureArray(container?.Video),
			ratingKeys = videos.map(v => v.ratingKey).filter(Boolean);

		console.log(`Parsed ${ratingKeys.length} ratingKeys from hub.`);

		if (ratingKeys.length === 0) {
			continue;
		}

		const label = CLI.label || CLI.hubName,
			limit = LIMIT_RUN_SIZE ?? ratingKeys.length;

		let processed = 0,
			labeled = 0;

		for (const rk of ratingKeys) {
			if (processed >= limit) {
				break;
			}

			const movie = await fetchMovie(rk);

			if (!movie) {
				processed += 1;
				continue;
			}

			const has = new Set(movie.labels);

			if (has.has(label)) {
				processed += 1;
				continue;
			}

			if (DRY_RUN) {
				console.log(`[DRY RUN] Would ensure label '${label}' on '${movie.title}'.`);
				labeled += 1;
				processed += 1;
				continue;
			}

			await updateLabels(movie, [label, ...movie.labels]);
			console.log(`Ensured label '${label}' on '${movie.title}'.`);
			labeled += 1;
			processed += 1;
		}

		console.log(`Done. Considered ${processed} item(s); labeled ${labeled}.`);
		matchedAny = true;
	}

	if (!matchedAny) {
		console.warn(`No hub named '${CLI.hubName}' found in any movie library.`);
	}
}

async function fetchMovieLibraries() {
	const res = await plex.get("/library/sections"),
		parsed = safeParse(res.data),
		dirs = ensureArray(parsed?.MediaContainer?.Directory);

	return dirs.filter(d => d.type === "movie").map(d => ({ key: d.key, title: d.title }));
}

async function listHubMovies(libraries, hubTitle) {
	let any = false;

	for (const lib of libraries) {
		/* eslint-disable no-await-in-loop */
		const hubInfo = await findHubInLibrary(lib.key, hubTitle);

		if (!hubInfo) {
			if (CLI.debug) {
				console.log(`No hub titled '${hubTitle}' found in '${lib.title}'.`);
			}
			continue;
		}

		const videos = await fetchHubVideos(lib.key, hubInfo);
		console.log(`Movies in hub '${hubInfo.title}' for library '${lib.title}' (key: ${lib.key}):`);

		if (videos.length === 0) {
			console.log("  (none)");
			continue;
		}

		for (const v of videos) {
			const yearPart = v.year ? ` (${v.year})` : "";
			console.log(`  - ${v.title}${yearPart}`);
		}

		any = true;
	}

	if (!any) {
		console.warn(`No hub named '${hubTitle}' found in any movie library.`);
	}
}

async function fetchHubVideos(sectionKey, hubInfo) {
	// Preview to detect total size
	const preview = await plex.get("/hubs/items", {
		params: {
			identifier: hubInfo.identifier,
			curatedHubSeed: hubInfo.curatedHubSeed,
			contentDirectoryID: sectionKey,
			includeCollections: 0,
			includeExternalMedia: 0,
			includeAdvanced: 0,
			includeMeta: 0,
			"X-Plex-Container-Start": 0,
			"X-Plex-Container-Size": 1
		}
	});

	if (CLI.debug || CLI.debugRaw) {
		console.log("HUB XML (preview):");
		console.log(preview.data);
	}

	const previewContainer = safeParse(preview.data)?.MediaContainer,
		total = Number(previewContainer?.totalSize ?? previewContainer?.size ?? 0) || 500;

	const full = await plex.get("/hubs/items", {
		params: {
			identifier: hubInfo.identifier,
			curatedHubSeed: hubInfo.curatedHubSeed,
			contentDirectoryID: sectionKey,
			includeCollections: 0,
			includeExternalMedia: 0,
			includeAdvanced: 0,
			includeMeta: 0,
			"X-Plex-Container-Start": 0,
			"X-Plex-Container-Size": total
		}
	});

	if (CLI.debug || CLI.debugRaw) {
		console.log("HUB XML (full):");
		console.log(full.data);
	}

	const container = safeParse(full.data)?.MediaContainer,
		videos = ensureArray(container?.Video);

	return videos.map((v) => ({
		ratingKey: v.ratingKey,
		title: v.title,
		year: v.year
	})).filter((v) => v.ratingKey && v.title);
}

async function listAllHubs(libraries) {
	for (const lib of libraries) {
		/* eslint-disable no-await-in-loop */
		const { hubs, rawXml, fallbackUsed } = await fetchLibraryHubs(lib.key);

		console.log(`Hubs in library '${lib.title}' (key: ${lib.key}):`);

		if ((CLI.debug || CLI.debugRaw) && rawXml) {
			console.log("-- raw hubs XML --");
			console.log(rawXml);
			console.log("-- end raw hubs XML --");
		}

		const filtered = CLI.all ? hubs : hubs.filter((h) => h.curatedHubSeed && (h.type ? h.type.toLowerCase() === "movie" : true));

		if (filtered.length === 0) {
			console.log("  (none)");
			continue;
		}

		if (fallbackUsed) {
			console.log("  (fetched via /hubs fallback)");
		}

		for (const h of filtered) {
			const seedPart = h.curatedHubSeed ? `, seed=${h.curatedHubSeed}` : "";
			const typePart = h.type ? `, type=${h.type}` : "";
			console.log(`  - ${h.title} (identifier=${h.identifier}${seedPart}${typePart})`);
		}
	}
}

async function fetchLibraryHubs(sectionKey) {
	const res = await plex.get(`/hubs/sections/${sectionKey}`, {
		params: {
			includeMeta: 1,
			includeCollections: 1,
			includeAdvanced: 1,
			includeExternalMedia: 1
		}
	});

	let parsed = safeParse(res.data),
		hubsNodes = ensureArray(parsed?.MediaContainer?.Hub),
		results = [];

	for (const hub of hubsNodes) {
		const title = normalize(hub?.title),
			identifier = normalize(hub?.identifier) || normalize(hub?.hubIdentifier) || extractQueryParam(hub?.key, "identifier");

		if (!title || !identifier) {
			continue;
		}

		const seed = extractQueryParam(hub?.key, "curatedHubSeed") || normalize(hub?.curatedHubSeed) || normalize(hub?.hubGuid) || normalize(hub?.seed) || normalize(hub?.hubSeed);

		results.push({ title, identifier, curatedHubSeed: seed, type: normalize(hub?.type) });
	}

	// Fallback: some servers expose curated hubs via /hubs with contentDirectoryID
	if (results.length === 0) {
		const res2 = await plex.get("/hubs", {
			params: {
				includeMeta: 1,
				includeCollections: 1,
				includeAdvanced: 1,
				includeExternalMedia: 1,
				contentDirectoryID: sectionKey,
				"X-Plex-Container-Start": 0,
				"X-Plex-Container-Size": 100
			}
		});

		parsed = safeParse(res2.data);
		hubsNodes = ensureArray(parsed?.MediaContainer?.Hub);

		for (const hub of hubsNodes) {
			const title = normalize(hub?.title),
				identifier = normalize(hub?.identifier) || normalize(hub?.hubIdentifier) || extractQueryParam(hub?.key, "identifier");

			if (!title || !identifier) {
				continue;
			}

			const seed = extractQueryParam(hub?.key, "curatedHubSeed") || normalize(hub?.curatedHubSeed) || normalize(hub?.hubGuid) || normalize(hub?.seed) || normalize(hub?.hubSeed);

			results.push({ title, identifier, curatedHubSeed: seed, type: normalize(hub?.type) });
		}

		return { hubs: results, rawXml: res2.data, fallbackUsed: true };
	}

	return { hubs: results, rawXml: res.data, fallbackUsed: false };
}

async function findHubInLibrary(sectionKey, hubTitle) {
	const { hubs } = await fetchLibraryHubs(sectionKey);
	const target = String(hubTitle).trim().toLowerCase();

	for (const h of hubs) {
		if (h.title && h.title.toLowerCase() === target) {
			if (h.identifier && h.curatedHubSeed) {
				return { identifier: h.identifier, curatedHubSeed: h.curatedHubSeed, title: h.title };
			}
		}
	}

	return null;
}

async function fetchMovie(ratingKey) {
	const res = await plex.get(`/library/metadata/${ratingKey}`, {
		params: {
			includeGuids: 1,
			includeFields: "guid",
			includeLabels: 1
		}
	}),
		parsed = safeParse(res.data),
		video = ensureArray(parsed?.MediaContainer?.Video)[0];

	if (!video) {
		return null;
	}

	return {
		ratingKey: video.ratingKey,
		title: video.title,
		labels: extractLabels(video),
		librarySectionKey: video.librarySectionID ?? parsed?.MediaContainer?.librarySectionID,
		typeCode: 1
	};
}

async function updateLabels(movie, labels) {
	const params = {
		type: movie.typeCode ?? 1,
		id: movie.ratingKey,
		includeExternalMedia: 1,
		"label.locked": 1
	};

	labels.forEach((label, index) => {
		params[`label[${index}].tag.tag`] = label;
	});

	const endpoint = movie.librarySectionKey != null ? `/library/sections/${movie.librarySectionKey}/all` : `/library/metadata/${movie.ratingKey}`;
	await plex.put(endpoint, null, { params });
}

function parseCli(args) {
	let hubName = null,
		label = null,
		listHubs = false,
		debug = false,
		debugRaw = false,
		listHubsTarget = null,
		all = false;

	for (let i = 0; i < args.length; i += 1) {
		const a = args[i];

		if (a === "--list-hubs" || a === "--list") {
			listHubs = true;
			// If next arg is present and not another flag, treat as target hub title
			const next = args[i + 1];
			if (next && !String(next).startsWith("-")) {
				listHubsTarget = normalize(next);
				i += 1;
			}
			continue;
		}

		if (a.startsWith("--list-hubs=")) {
			listHubs = true;
			listHubsTarget = normalize(a.split("=", 2)[1]);
			continue;
		}

		if (a === "--debug") {
			debug = true;
			continue;
		}

		if (a === "--debug-raw") {
			debugRaw = true;
			continue;
		}

		if (a === "--all") {
			all = true;
			continue;
		}

		if (a === "--hub" || a === "--preserve") {
			hubName = normalize(args[i + 1]);
			i += 1;
			continue;
		}

		if (a.startsWith("--hub=") || a.startsWith("--preserve=")) {
			hubName = normalize(a.split("=", 2)[1]);
			continue;
		}

		if (a === "--label") {
			label = normalize(args[i + 1]);
			i += 1;
			continue;
		}

		if (a.startsWith("--label=")) {
			label = normalize(a.split("=", 2)[1]);
			continue;
		}
	}

	return { hubName, label, listHubs, debug, debugRaw, listHubsTarget, all };
}

function parsePositiveInteger(value, fallback) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);

	if (Number.isNaN(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

function parseBoolean(value) {
	if (!value) {
		return false;
	}

	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function safeParse(xmlString) {
	try {
		return xml.parse(xmlString);
	} catch {
		return {};
	}
}

function ensureArray(v) {
	if (Array.isArray(v)) {
		return v;
	}

	if (v === undefined || v === null) {
		return [];
	}

	return [v];
}

function extractLabels(video) {
	const labelsRaw = ensureArray(video.Label),
		results = [];

	for (const label of labelsRaw) {
		if (typeof label === "string") {
			results.push(label);
		} else if (label?.tag) {
			results.push(label.tag);
		}
	}

	return results;
}

function extractQueryParam(rawKey, param) {
	if (!rawKey || !param) {
		return null;
	}

	try {
		const u = new URL(rawKey, "http://placeholder.local");
		return u.searchParams.get(param);
	} catch {
		return null;
	}
}

function normalize(v) {
	if (v === undefined || v === null) {
		return null;
	}

	const s = String(v).trim();
	return s === "" ? null : s;
}

main().catch((err) => {
	console.error("Unexpected error:", err?.message ?? err);
	process.exitCode = 1;
});
