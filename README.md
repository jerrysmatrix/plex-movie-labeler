# Plex TMDB Keyword Sync

This Node.js toolkit helps manage Plex movie metadata:

- Syncs keyword metadata from [TMDB](https://www.themoviedb.org/) into Plex labels.
- Preserves movies from a Plex curated hub into a persistent label.
- Sets or clears default user ratings on movies.

## Prerequisites

- Node.js 18 or newer.
- A Plex server reachable from the machine running these scripts.

## Environment Variables

Set via `.env` (see `.env.example`) or your shell.

- `PLEX_BASE_URL` (required): Plex base URL, e.g. `http://127.0.0.1:32400`.
- `PLEX_TOKEN` (required): Plex authentication token.
- `TMDB_API_KEY` (required for keyword sync only): TMDB API key from your TMDB account.
- `PLEX_CLIENT_IDENTIFIER` (optional): Client identifier sent to Plex. Defaults to `plex-tmdb-sync`.
- `PLEX_LIBRARY_NAMES` (optional, most tools): Comma‑separated movie library names to include. When omitted, all movie libraries are processed.
- `DRY_RUN` (optional): `true` to preview changes without writing to Plex.
- `LIMIT_RUN_SIZE` (optional): Maximum number of movies per library to process; blank means no limit.

## Setup

1. Install dependencies:
    ```bash
    npm install
    ```
2. Copy `.env.example` to `.env` and populate values:
    ```bash
    cp .env.example .env
    ```

## Keyword Sync (TMDB ➜ Plex labels)

Syncs TMDB keywords into Plex movie labels. Requires `TMDB_API_KEY`.

```bash
npm start
```

Respects `PLEX_LIBRARY_NAMES`, `DRY_RUN`, and `LIMIT_RUN_SIZE`. Already-present labels are skipped; nothing is removed.

## Curated Hubs

Tools for inspecting curated hubs and preserving their membership as labels. Does not require `TMDB_API_KEY`.

- List hubs per library:

    ```bash
    node src/preserve.js --list-hubs
    # or with a target title to list movies in that hub across libraries
    node src/preserve.js --list-hubs "Fearmongers"
    # aliases: --list, --list-hubs=<title>
    ```

    Flags:
    - `--all`: Include all hub types (not just curated movie hubs).
    - `--debug`: Extra diagnostics (e.g., when hubs aren’t found).
    - `--debug-raw`: Dump raw XML responses for troubleshooting.

- Preserve a curated hub into labels:
    ```bash
    node src/preserve.js --hub "Fearmongers" --label "Halloween"
    # aliases: --preserve, --hub=<title>, --label=<name>
    ```
    Notes:
    - Default label name is the hub title if `--label` isn’t provided.
    - Respects `DRY_RUN` for preview-only mode and `LIMIT_RUN_SIZE` to cap work.

## Default Ratings

Set a default user rating for unrated movies, or clear user ratings. Does not require `TMDB_API_KEY`.

- Set default rating (2.5 stars) for unrated movies:

    ```bash
    node src/ratings.js
    ```

- Clear user ratings:
    ```bash
    node src/ratings.js --clear
    # Only clear ratings that equal the default (2.5 stars)
    node src/ratings.js --clear --only-defaults
    ```

Respects `PLEX_LIBRARY_NAMES`, `DRY_RUN`, and `LIMIT_RUN_SIZE`.

## Notes

- Keyword sync only adds labels that are missing; it does not remove labels.
- Plex rate-limits metadata updates; for large libraries consider filtering by `PLEX_LIBRARY_NAMES` or setting `LIMIT_RUN_SIZE`.
