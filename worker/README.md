# MANGA SLAYER cloud backend

This Worker provides the Android app API, Firebase email/password and Google authentication, MangaDex catalog access, and account features. It is configured as `yz-manga-api-v2` so the older `yz-manga-api` deployment remains untouched.

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

- Public image URLs point directly to the upstream image CDN. A page image requires no D1 record or Worker request. The allowlist and reader CSP restrict image origins; old numeric image routes remain supported.
- Public upstream JSON uses the Cache API and a bounded in-memory cache. Profiles, comments and tokens never enter this cache. Cache refreshes do not write D1 rows.
- A catalog page resolves its mappings and newest chapter metadata in batches, instead of indexing every listed title. The cold 30-title regression stays below 12 D1 queries, within Free's 50-query invocation limit.
- Chapter numbers are stored as JSON patches in 16 parts per title and 256 shared lookup buckets. Existing discussion IDs survive migration and translation fallback. A 1,200-chapter import changes fewer than 300 logical rows in the regression; identical refreshes write none.
- Source ingestion reserves a conservative daily write budget of 12,000 before updates. When it is exhausted, saved chapter lists remain readable and source updates pause. This does not reserve an unlimited allowance for user mutations or guarantee availability during upstream outages, abuse, or account-level quota exhaustion.
- Background indexing handles one title per invocation to bound Free subrequests. Opening a title uses the saved list immediately when fresh, and can return it during a provider or write-budget failure.
- Account and comment data stays private in D1. GitHub hosts this source and the APK; it is not a private database or an API runtime.

## Tests and migration

Run `npm ci`, `npm run check`, and `npm test`. Tests cover query/write budgets, direct images, chapter continuity, multilingual fallback, avatar hydration, comment ownership/deletion, and cooldown behavior.

For account migration, export the old D1 database privately, then use `node scripts/prepare-migration.mjs /private/backup.sql /private/import.sql`. The import preserves user records, image compatibility mappings and chapter IDs while converting chapter storage. Never commit either SQL file. Import into an empty destination database before deployment; do not apply the seed SQL over a live database.

## Deployment

The `yz-manga-data-v2` D1 database is attached in `wrangler.toml`; schema changes live in `migrations/`.

```powershell
npm install
npm run check
npx wrangler d1 migrations apply yz-manga-data-v2 --remote
npx wrangler deploy
```

The current deployment is live at `https://yz-manga-api-v2.yznabyd.workers.dev/`. The companion APK is `../YZ-Manga-v2.apk`, installed and checked on SM-S938B. See `../LIVE-VERIFICATION.md` for exact phone and production API checks and their limits.

Never upload account data, APK signing keys, or service-account files to GitHub. This backend does not need a service-account file.
