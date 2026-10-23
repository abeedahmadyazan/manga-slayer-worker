# MANGA SLAYER cloud backend

This Worker provides the Android app API, Firebase email/password and Google authentication, MangaDex catalog access, and account features. Production now runs in **discussion-only mode**: chapter numbers and comments/replies are available, while page viewing, page downloads and translation indexing are disabled. The destination deployment is `manga-slayer-api`. The optional `compat/` Worker forwards old installed APK URLs to this API without an old D1 binding or scheduled indexing.

## Storage and authentication

- Firebase Authentication handles account creation, login, refresh, and ID-token verification.
- Cloudflare D1 stores profiles, device bindings, rate limits, library data, comments/replies/reactions, and compact source metadata.
- The Worker applies authorization, cooldowns, comment caps, and device-to-account rules before touching D1. The app has no direct D1 credentials.
- `FIREBASE_WEB_API_KEY` is the Firebase client configuration key. It is public by design and is used only for Firebase Authentication REST calls; it is not a service-account credential.
- No Firebase service-account private key or Google OAuth credential is required by this Worker. Firestore rules remain deny-all because the app backend no longer uses Firestore.
- A daily scheduled task removes expired rate-limit records so temporary abuse-control state does not accumulate indefinitely.

## Limits

The Cloudflare Workers Free plan currently includes 5 million D1 rows read per day, 100,000 rows written per day, and 500 MB of D1 storage. Requests stop succeeding when a daily or storage quota is reached; usage can be checked in Cloudflare's D1 metrics. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Low-write source architecture

- `DISCUSSIONS_ONLY="true"` in `wrangler.toml` is the production setting. The reader shows a discussion notice, pages return an empty collection and ZIP downloads are disabled, without querying D1 or fetching pages.
- Chapter numbers and their discussion IDs from the migration stay frozen in their existing snapshots. Newly discovered numbers are stored together in one small row per title in `source_discussion_numbers`; refreshing the same numbers performs no writes. Missing upstream chapters never remove saved discussions.
- Only opening a title checks its published numbers, using public JSON cached for six hours. No translated chapter metadata, page URLs, reader lookup buckets or refresh timestamps are written in this mode. Catalog browsing does not write chapter records.
- The 15-minute indexing schedule has been removed. Only daily cleanup of expired rate-limit state remains; the index refresh function also exits immediately in discussion mode.
- Comments, profiles and Google authentication retain their existing protection: ownership checks, two top-level comments per account per chapter and a shared 60-second comment/reply cooldown. Reading comments does not write to D1.
- New accounts, comments, replies, avatars, personal library changes and first-time title mappings still require writes. Existing free quotas still apply; disabling pages cannot make social mutations free or guarantee unlimited usage.

### Optional reader implementation (disabled in production)

The retained reader code is exercised by compatibility tests. Re-enabling it requires changing the production flag and deliberately restoring any desired schedule; discussion-only production does not execute these paths.

- Public image URLs point directly to the upstream image CDN. A page image requires no D1 record or Worker request. The allowlist and reader CSP restrict image origins; old numeric image routes remain supported.
- Public upstream JSON uses the Cache API and a bounded in-memory cache. Profiles, comments and tokens never enter this cache. Cache refreshes do not write D1 rows.
- A catalog page resolves its mappings and newest chapter metadata in batches, instead of indexing every listed title. The cold 30-title regression stays below 12 D1 queries, within Free's 50-query invocation limit.
- Chapter numbers are stored as JSON patches in 16 parts per title and 256 shared lookup buckets. Existing discussion IDs survive migration and translation fallback. A 1,200-chapter import changes fewer than 300 logical rows in the regression; identical refreshes write none.
- Source ingestion reserves a conservative daily write budget of 12,000 before updates. When it is exhausted, saved chapter lists remain readable and source updates pause. This does not reserve an unlimited allowance for user mutations or guarantee availability during upstream outages, abuse, or account-level quota exhaustion.
- When explicitly invoked with reader mode enabled, indexing handles one title per invocation to bound Free subrequests. No periodic indexing is enabled in the shipped configuration.
- Account and comment data stays private in D1. GitHub hosts this source and the APK; it is not a private database or an API runtime.

## Tests and migration

Run `npm ci`, `npm run check`, and `npm test`. All 34 test groups pass, including discussion-only number retention, one-row persistence of 1,200 new numbers, no writes on repeated reads, disabled reader/ZIP/scheduled indexing, and comment reads without writes. Other checks cover legacy reader behavior, query/write budgets, avatar hydration, comment ownership/deletion, and cooldowns.

For account migration, export the old D1 database privately, then use `node scripts/prepare-migration.mjs /private/backup.sql /private/import.sql`. The import preserves user records, image compatibility mappings and chapter IDs while converting chapter storage. Never commit either SQL file. Import into an empty destination database before deployment; do not apply the seed SQL over a live database.

## Deployment

The `manga-slayer-data` D1 database is attached in `wrangler.toml`; schema changes live in `migrations/`.

```powershell
npm install
npm run check
npx wrangler d1 migrations apply manga-slayer-data --remote
npx wrangler deploy
```

The destination API is `https://manga-slayer-api.yz-manga-api-v2.workers.dev/`. Firebase Authentication remains on the existing `yz-manga` project so Google accounts keep their identities. APK downloads are hosted at [GitHub Releases](https://github.com/abeedahmadyazan/manga-slayer-downloads/releases/latest). Cloud deployment is separate from GitHub source hosting; no account data is published to the repository.

Never upload account data, APK signing keys, or service-account files to GitHub. This backend does not need a service-account file.
