/* eslint-disable no-console */
const axios = require("axios"),
	{ XMLParser } = require("fast-xml-parser"),
	dotenv = require("dotenv");

dotenv.config();

const REQUIRED_ENV = ["PLEX_BASE_URL", "PLEX_TOKEN", "TMDB_API_KEY"],
	missing = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missing.length > 0) {
	console.error(`Missing required environment variables: ${missing.join(", ")}. Set them in .env or your shell.`);
	process.exit(1);
}

const PLEX_BASE_URL = process.env.PLEX_BASE_URL.replace(/\/+$/, ""),
	PLEX_TOKEN = process.env.PLEX_TOKEN,
	TMDB_API_KEY = process.env.TMDB_API_KEY,
	DRY_RUN = parseBoolean(process.env.DRY_RUN),
	PLEX_LIBRARY_NAMES = parseLibraryList(process.env.PLEX_LIBRARY_NAMES),
	LIMIT_RUN_SIZE = parsePositiveInteger(process.env.LIMIT_RUN_SIZE, null);

const plexClient = axios.create({
	baseURL: PLEX_BASE_URL,
	headers: {
		"X-Plex-Token": PLEX_TOKEN,
		"X-Plex-Client-Identifier": process.env.PLEX_CLIENT_IDENTIFIER || "plex-tmdb-sync",
		Accept: "application/xml"
	},
	timeout: 20000,
	validateStatus: (status) => status >= 200 && status < 300
});

const tmdbClient = axios.create({
	baseURL: "https://api.themoviedb.org/3",
	timeout: 10000
});

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	textNodeName: "_text"
});

async function main() {
	console.log(`Connecting to Plex at ${PLEX_BASE_URL}`);

	if (LIMIT_RUN_SIZE != null) {
		console.log(`Limiting processing to ${LIMIT_RUN_SIZE} movie${LIMIT_RUN_SIZE === 1 ? "" : "s"} per library.`);
	}

	const libraries = await fetchMovieLibraries();

	if (libraries.length === 0) {
		console.warn("No Plex movie libraries matched the provided filters.");
		return;
	}

	console.log(`Found ${libraries.length} movie librar${libraries.length === 1 ? "y" : "ies"} to process.`);

	let totalMovies = 0,
		totalLabelsAdded = 0;

	for (const library of libraries) {
		console.log(`Processing library '${library.title}' (key: ${library.key})`);
		/* eslint-disable no-await-in-loop */
		const movies = await fetchLibraryMovies(library.key, LIMIT_RUN_SIZE);

		if (LIMIT_RUN_SIZE != null) {
			console.log(`Found ${movies.length} movie${movies.length === 1 ? "" : "s"} limited from '${library.title}'.`);
		} else {
			console.log(`Found ${movies.length} movies in '${library.title}'.`);
		}

		for (const movie of movies) {
			totalMovies += 1;

			try {
				const added = await syncMovieKeywords(movie);
				totalLabelsAdded += added;
			} catch (error) {
				console.error(`Failed to sync '${movie.title}' (ratingKey ${movie.ratingKey}):`, error.message ?? error);
			}
		}
		/* eslint-enable no-await-in-loop */
	}

	console.log(`Sync complete. Processed ${totalMovies} movies; added ${totalLabelsAdded} new keyword labels.`);
}

async function fetchMovieLibraries() {
	const response = await plexClient.get("/library/sections"),
		parsed = xmlParser.parse(response.data),
		directories = ensureArray(parsed?.MediaContainer?.Directory),
		movieLibraries = directories.filter((dir) => dir.type === "movie");

	if (!PLEX_LIBRARY_NAMES) {
		return movieLibraries.map((dir) => ({
			key: dir.key,
			title: dir.title
		}));
	}

	return movieLibraries
		.filter((dir) => PLEX_LIBRARY_NAMES.includes(dir.title))
		.map((dir) => ({
			key: dir.key,
			title: dir.title
		}));
}

async function fetchLibraryMovies(sectionKey, limit = null) {
	const movies = [],
		pageSize = 200;

	let start = 0,
		totalSize = Infinity;

	while (start < totalSize && (limit == null || movies.length < limit)) {
		const response = await plexClient.get(`/library/sections/${sectionKey}/all`, {
			params: {
				"X-Plex-Container-Start": start,
				"X-Plex-Container-Size": pageSize,
				includeGuids: 1,
				includeFields: "guid",
				includeLabels: 1
			}
		});

		const parsed = xmlParser.parse(response.data),
			container = parsed?.MediaContainer,
			videos = ensureArray(container?.Video);

		if (container?.totalSize != null) {
			totalSize = Number(container.totalSize);
		} else if (container?.size != null) {
			totalSize = Number(container.size);
		} else if (totalSize === Infinity) {
			totalSize = videos.length;
		}

		for (const video of videos) {
			movies.push({
				ratingKey: video.ratingKey,
				title: video.title,
				year: video.year,
				guids: extractGuids(video),
				labels: extractLabels(video),
				librarySectionKey: sectionKey,
				librarySectionId: video.librarySectionID ?? container?.librarySectionID,
				type: video.type,
				typeCode: resolveMetadataType(video.type)
			});

			if (limit != null && movies.length >= limit) {
				break;
			}
		}

		if (videos.length === 0) {
			break;
		}

		start += videos.length;
	}

	return movies;
}

async function syncMovieKeywords(movie) {
	const tmdbId = extractTmdbId(movie.guids);

	if (!tmdbId) {
		console.debug(`Skipping '${movie.title}'; no TMDB GUID found.`);
		return 0;
	}

	const keywords = await fetchTmdbKeywords(tmdbId);

	if (keywords.length === 0) {
		console.log(`No keywords returned for '${movie.title}' (TMDB ${tmdbId}).`);
		return 0;
	}

	const currentLabels = dedupePreserveOrder(movie.labels),
		missing = keywords.filter((keyword) => !currentLabels.includes(keyword));

	if (missing.length === 0) {
		console.debug(`No missing keywords for '${movie.title}'.`);
		return 0;
	}

	const updatedLabels = currentLabels.concat(missing);

	if (DRY_RUN) {
		console.log(`[DRY RUN] Would add ${missing.length} keyword labels to '${movie.title}': ${missing.join(", ")}`);
		return missing.length;
	}

	try {
		await updateMovieLabels(movie, updatedLabels);
		console.log(`Added ${missing.length} keyword label(s) to '${movie.title}'.`);
		return missing.length;
	} catch (error) {
		console.error(`Failed to update labels for '${movie.title}':`, error.message ?? error);
		return 0;
	}
}

async function fetchTmdbKeywords(tmdbId) {
	const response = await tmdbClient.get(`/movie/${tmdbId}/keywords`, {
		params: { api_key: TMDB_API_KEY }
	});

	const keywordsRaw = response.data?.keywords ?? response.data?.results ?? [],
		keywords = [];

	for (const item of keywordsRaw) {
		const name = typeof item === "string" ? item : item?.name;

		if (name && !keywords.includes(name)) {
			keywords.push(name);
		}
	}

	return keywords;
}

async function updateMovieLabels(movie, labels) {
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
	await plexClient.put(endpoint, null, { params });
}

function extractGuids(video) {
	const guidsRaw = ensureArray(video.Guid),
		results = [];

	for (const guid of guidsRaw) {
		if (typeof guid === "string") {
			results.push(guid);
		} else if (guid?.id) {
			results.push(guid.id);
		}
	}

	return results;
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

function extractTmdbId(guids) {
	const prefixes = ["tmdb://", "themoviedb://", "com.plexapp.agents.themoviedb://"];

	for (const raw of guids) {
		if (!raw || typeof raw !== "string") {
			continue;
		}

		const lowered = raw.toLowerCase();

		for (const prefix of prefixes) {
			const index = lowered.indexOf(prefix);

			if (index !== -1) {
				const start = index + prefix.length,
					remainder = raw.substring(start),
					tmdbId = remainder.split("?")[0].trim();

				if (tmdbId) {
					return tmdbId;
				}
			}
		}
	}

	return null;
}

function parseBoolean(value) {
	if (!value) {
		return false;
	}

	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseLibraryList(value) {
	if (!value) {
		return null;
	}

	const items = value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

	return items.length > 0 ? items : null;
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

function resolveMetadataType(type) {
	if (type == null) {
		return 1;
	}

	if (typeof type === "number") {
		return type;
	}

	switch (String(type).toLowerCase()) {
		case "movie":
			return 1;
		case "show":
			return 2;
		case "season":
			return 3;
		case "episode":
			return 4;
		case "artist":
			return 8;
		case "album":
			return 9;
		case "track":
			return 10;
		default: {
			const parsed = Number.parseInt(type, 10);
			return Number.isNaN(parsed) ? 1 : parsed;
		}
	}
}

function dedupePreserveOrder(values) {
	if (!values || values.length === 0) {
		return [];
	}

	const seen = new Set(),
		result = [];

	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}

	return result;
}

function ensureArray(value) {
	if (Array.isArray(value)) {
		return value;
	}

	if (value === undefined || value === null) {
		return [];
	}

	return [value];
}

main().catch((error) => {
	console.error("Unexpected error:", error.message ?? error);
	process.exitCode = 1;
});
