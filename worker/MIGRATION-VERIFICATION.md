# Migration and quota verification — 2026-10-24

Destination: `manga-slayer-api.yz-manga-api-v2.workers.dev`, D1 `manga-slayer-data`, Free plan.

The previous APK endpoint, `yz-manga-api-v2.yznabyd.workers.dev`, now forwards to the destination. Its compatibility deployment has no D1 binding and no scheduled indexing. Firebase Authentication remains on `yz-manga`, preserving Google account identities.

## Data preservation

An offline comparison of the private export and compact import verified 664 unchanged non-chapter documents and 17,365 preserved chapter reader mappings, including one legacy mapping outside the current title lists. User data was not uploaded to GitHub. The largest compact payload was 49,140 bytes. The one-time destination import used 6,183 row writes; this is a migration cost, not a predicted daily usage figure.

## Verified behavior

- TypeScript and 31 local test groups pass. The regression checks include a cold 30-title catalog below 12 D1 queries, a 1,200-chapter import below 300 logical changed rows, zero writes for identical refreshes, and serving saved chapters after the source budget is exhausted.
- Production checks ran against both the destination and the exact legacy endpoint used by installed APKs. They fetched the catalog, at least 678 saved One Piece chapter numbers, and actual page bytes from chapter 1145 directly from the image CDN.
- Separate temporary Firebase accounts verified session authentication, profile creation, avatar upload, comment and reply images, a rejected reply before 60 seconds, an accepted reply after 61 seconds, reloads, and bodyless DELETE for replies/comments. Temporary accounts and their own records were removed.
- Six repeated production reads (catalog and One Piece chapter list, three each) all returned HTTP 200. The D1 Time Travel bookmark before and after was identical, confirming no database changes during those reads.
- The final destination deployment is `1e810c8f-1e60-41a5-8c5b-0bdcfadd3a39`; the legacy forwarding deployment is `6aa2604e-4a9c-4ba0-80d0-c3bcaceaaafc`.

## Practical limits

Public source JSON cache refreshes and direct image viewing do not write D1. New/changed source data has a conservative 12,000-unit daily ingestion budget. Comments, accounts and personal library changes still require writes. Free account quotas and upstream outages still apply; these short tests do not establish a full day's usage or a permanent availability guarantee. No phone UI testing or APK reinstall was performed in this migration.
