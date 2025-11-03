# Plex TMDB Keyword Sync

This Node.js tool syncs keyword metadata from [TMDB](https://www.themoviedb.org/) into the labels of your local Plex movie libraries. Each run connects to Plex, inspects every movie, fetches the TMDB keywords for the matching title, and adds any missing keywords as Plex labels.

## Prerequisites
- Node.js 18 or newer.
- A Plex server reachable from the machine running this script.
- A Plex authentication token.
- A TMDB API key. Create one at [TMDB account settings](https://www.themoviedb.org/settings/api).

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and populate your credentials:
   ```bash
   cp .env.example .env
   ```
   > If you prefer, export the variables directly in your shell instead of using a `.env` file.

## Running the sync
```bash
npm start
```

### Optional configuration
- `PLEX_LIBRARY_NAMES`: Comma-separated list of Plex movie library names to sync. When omitted, every movie library is processed.
- `DRY_RUN`: Set to `true` to log intended changes without modifying Plex.
- `LIMIT_RUN_SIZE`: Maximum number of movies per library to process in any mode (default: empty for unlimited).

Logs are written to the console with per-movie detail. Rerun the script as needed; keywords that are already present are skipped.

### Preserve a Curated Hub into Labels
```bash
node src/preserve.js --hub "Fearmongers" --label "Fearmongers"
```
Logs include the hub XML (preview + full), parsed count, and per‑movie updates. `DRY_RUN=true` previews changes. You can cap work with `LIMIT_RUN_SIZE`.

## Notes
- The script only adds keywords that are missing. It does not remove existing labels that are no longer present on TMDB.
- Plex rate-limits metadata updates; if you have a very large library consider breaking runs up by library name.
