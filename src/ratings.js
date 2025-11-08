const axios = require('axios'),
	{ XMLParser } = require('fast-xml-parser'),
	dotenv = require('dotenv');

dotenv.config();

const REQUIRED_ENV = ['PLEX_BASE_URL', 'PLEX_TOKEN'],
	missing = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missing.length > 0) {
	console.error(`Missing required environment variables: ${missing.join(', ')}. Set them in .env or your shell.`);
	process.exit(1);
}

const PLEX_BASE_URL = process.env.PLEX_BASE_URL.replace(/\/+$/, ''),
	PLEX_TOKEN = process.env.PLEX_TOKEN,
	DRY_RUN = parseBoolean(process.env.DRY_RUN),
	PLEX_LIBRARY_NAMES = parseLibraryList(process.env.PLEX_LIBRARY_NAMES),
	LIMIT_RUN_SIZE = parsePositiveInteger(process.env.LIMIT_RUN_SIZE, null);

const ARGS = new Set(process.argv.slice(2)),
	CLEAR_MODE = ARGS.has('--clear'),
	ONLY_DEFAULTS = ARGS.has('--only-defaults');

const TARGET_STARS = 2.5,
	TARGET_RATING_VALUE = 5;

const plexClient = axios.create({
	baseURL: PLEX_BASE_URL,
	headers: {
		'X-Plex-Token': PLEX_TOKEN,
		'X-Plex-Client-Identifier': process.env.PLEX_CLIENT_IDENTIFIER || 'plex-default-rating',
		Accept: 'application/xml'
	},
	timeout: 20000,
	validateStatus: (status) => status >= 200 && status < 300
});

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	textNodeName: '_text'
});

async function main() {
	console.log(`Connecting to Plex at ${PLEX_BASE_URL}`);

	if (LIMIT_RUN_SIZE != null) {
		console.log(`Limiting processing to ${LIMIT_RUN_SIZE} movie${LIMIT_RUN_SIZE === 1 ? '' : 's'} per library.`);
	}

	if (ONLY_DEFAULTS && !CLEAR_MODE) {
		console.warn("'--only-defaults' is ignored without '--clear'.");
	}

	const libraries = await fetchMovieLibraries();

	if (libraries.length === 0) {
		console.warn('No Plex movie libraries matched the provided filters.');
		return;
	}

	console.log(`Found ${libraries.length} movie librar${libraries.length === 1 ? 'y' : 'ies'} to process.`);

	let totalCandidates = 0,
		totalUpdated = 0;

	for (const library of libraries) {
		console.log(`Processing library '${library.title}' (key: ${library.key})`);

		const movies = await fetchLibraryMovies(library.key, LIMIT_RUN_SIZE);

		let targets;

		if (CLEAR_MODE) {
			targets = ONLY_DEFAULTS ? movies.filter((m) => m.userRating === TARGET_RATING_VALUE) : movies.filter((m) => m.userRating != null);
		} else {
			targets = movies.filter((m) => m.userRating == null);
		}

		totalCandidates += targets.length;

		if (LIMIT_RUN_SIZE != null) {
			console.log(
				`Found ${movies.length} movie${movies.length === 1 ? '' : 's'} (limited) in '${library.title}', ${targets.length} to ${CLEAR_MODE ? 'clear' : 'set to default'}.`
			);
		} else {
			console.log(`Found ${movies.length} movies in '${library.title}', ${targets.length} to ${CLEAR_MODE ? 'clear' : 'set to default'}.`);
		}

		for (const movie of targets) {
			try {
				const updated = await setUserRating(movie, CLEAR_MODE ? 0 : TARGET_RATING_VALUE);
				totalUpdated += updated ? 1 : 0;
			} catch (error) {
				console.error(
					`${CLEAR_MODE ? 'Failed to clear rating' : 'Failed to rate'} '${movie.title}' (ratingKey ${movie.ratingKey}):`,
					error.message ?? error
				);
			}
		}
	}

	if (CLEAR_MODE) {
		console.log(`Clearing complete. Considered ${totalCandidates} rated movies; cleared ${totalUpdated} rating${totalUpdated === 1 ? '' : 's'}.`);
	} else {
		console.log(
			`Rating complete. Considered ${totalCandidates} unrated movies; set ${totalUpdated} to ${TARGET_STARS} star${TARGET_STARS === 1 ? '' : 's'}.`
		);
	}
}

async function fetchMovieLibraries() {
	const response = await plexClient.get('/library/sections'),
		parsed = xmlParser.parse(response.data),
		directories = ensureArray(parsed?.MediaContainer?.Directory),
		movieLibraries = directories.filter((dir) => dir.type === 'movie');

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
				'X-Plex-Container-Start': start,
				'X-Plex-Container-Size': pageSize,
				includeFields: 'userRating'
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
			const userRatingRaw = video?.userRating;

			movies.push({
				ratingKey: video.ratingKey,
				title: video.title,
				year: video.year,
				userRating: userRatingRaw == null ? null : Number(userRatingRaw),
				librarySectionKey: sectionKey
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

async function setUserRating(movie, ratingValue) {
	if (DRY_RUN) {
		if (ratingValue === 0) {
			console.log(`[DRY RUN] Would clear user rating for '${movie.title}'.`);
		} else {
			console.log(`[DRY RUN] Would set ${TARGET_STARS} stars for '${movie.title}'.`);
		}

		return true;
	}

	const params = {
		key: movie.ratingKey,
		identifier: 'com.plexapp.plugins.library',
		rating: ratingValue
	};

	await plexClient.put('/:/rate', null, { params });

	if (ratingValue === 0) {
		console.log(`Cleared user rating for '${movie.title}'.`);
	} else {
		console.log(`Set ${TARGET_STARS} star${TARGET_STARS === 1 ? '' : 's'} for '${movie.title}'.`);
	}

	return true;
}

function parseBoolean(value) {
	if (!value) {
		return false;
	}

	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseLibraryList(value) {
	if (!value) {
		return null;
	}

	const items = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);

	return items.length > 0 ? items : null;
}

function parsePositiveInteger(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);

	if (Number.isNaN(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
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
	console.error('Unexpected error:', error.message ?? error);
	process.exitCode = 1;
});
