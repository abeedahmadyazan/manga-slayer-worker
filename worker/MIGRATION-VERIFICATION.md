# Migration and quota verification — 2026-10-24

Destination: `manga-slayer-api.yz-manga-api-v2.workers.dev`, D1 `manga-slayer-data`, Free plan.

The previous APK endpoint, `yz-manga-api-v2.yznabyd.workers.dev`, now forwards to the destination. Its compatibility deployment has no D1 binding and no scheduled indexing. Firebase Authentication remains on `yz-manga`, preserving Google account identities.

## Data preservation

An offline comparison of the private export and compact import verified 664 unchanged non-chapter documents and 17,365 preserved chapter reader mappings, including one legacy mapping outside the current title lists. User data was not uploaded to GitHub. The largest compact payload was 49,140 bytes. The one-time destination import used 6,183 row writes; this is a migration cost, not a predicted daily usage figure.

## Verified behavior

- Before discussion-only mode, TypeScript and 31 local test groups passed. Those regression checks included a cold 30-title catalog below 12 D1 queries, a 1,200-chapter import below 300 logical changed rows, zero writes for identical refreshes, and serving saved chapters after the source budget was exhausted.
- Production checks ran against both the destination and the exact legacy endpoint used by installed APKs. They fetched the catalog, at least 678 saved One Piece chapter numbers, and actual page bytes from chapter 1145 directly from the image CDN.
- Separate temporary Firebase accounts verified session authentication, profile creation, avatar upload, comment and reply images, a rejected reply before 60 seconds, an accepted reply after 61 seconds, reloads, and bodyless DELETE for replies/comments. Temporary accounts and their own records were removed.
- Six repeated production reads (catalog and One Piece chapter list, three each) all returned HTTP 200. The D1 Time Travel bookmark before and after was identical, confirming no database changes during those reads.
- The migration destination deployment was `1e810c8f-1e60-41a5-8c5b-0bdcfadd3a39`; the legacy forwarding deployment is `6aa2604e-4a9c-4ba0-80d0-c3bcaceaaafc`.

## Discussion-only production update

At the owner's request, production deployment `d1294379-8202-4954-8d1d-ba79c76f8e86` enables `DISCUSSIONS_ONLY="true"`. Migration `0006_discussion_numbers.sql` adds one row per title for newly discovered numbers; migrated reader snapshots are retained without modification. The 15-minute source refresh trigger was removed. Only daily rate-limit cleanup remains scheduled.

- TypeScript and all 34 local test groups pass. Importing 1,200 additional numbers into an existing 1,200-number title changes exactly two logical rows in the regression: a single budget reservation and one title row. No reader snapshots or lookup buckets are modified. Repeated reads, provider omissions and provider outages preserve all saved IDs and perform no writes.
- Reader HTML displays a discussion notice; page API results are empty and ZIP downloads return HTTP 403. These paths and the disabled index refresh make no database or provider calls. Comment reads remain available without writes; existing authentication, cooldown and ownership tests also pass.
- Both the destination and exact installed-APK endpoint return 30 catalog cards and 678 One Piece chapter numbers. Chapter 1145 retains ID `104431153916133` on both endpoints. Repeated chapter-list reads retain all IDs.
- The D1 Time Travel bookmark before and after these production requests was identical (`00000005-0000000f-0000510d-69653026db0366664d954d59c22d65c8`), showing no database mutations during this bounded check. No test accounts/comments were created and no phone UI testing was performed for this update.

## Practical limits

Public source JSON cache refreshes do not write D1. New source data has a conservative 12,000-unit daily ingestion budget; this is a cap, not an expected daily cost. Comments, accounts, avatars and personal library changes still require writes. Free account quotas and upstream outages still apply; these short tests do not establish a full day's usage or a permanent availability guarantee. No APK reinstall is required for this backend update.
