# MANGA SLAYER backend

[Browse the Worker source](./worker) · [Verification report](./worker/MIGRATION-VERIFICATION.md) · [APK downloads](https://github.com/abeedahmadyazan/manga-slayer-downloads/releases/latest)

The production API is deployed on Cloudflare's Free plan at `https://manga-slayer-api.yz-manga-api-v2.workers.dev/`. Previously installed APKs keep using `https://yz-manga-api-v2.yznabyd.workers.dev/`, which forwards to the new account. Firebase Authentication remains on the existing project, preserving Google accounts.

Public images load directly from their CDN. Public source JSON uses the edge cache instead of D1 cache writes. Chapter metadata uses compact snapshots and bounded batch queries. Source ingestion has a conservative daily write budget, while saved chapter numbers and discussion IDs remain available.

GitHub hosts this source, verification workflows and the APK download repository. Private account data and comments stay in D1. GitHub Actions checks the source and publishes browsable files from the [source archive](./manga-slayer-worker-source.zip); it does not deploy to Cloudflare or require Cloudflare credentials.

No private account data, authentication tokens, APK signing keys or service-account files belong in this repository. See [setup and limits](./worker/README.md) for details. Free quotas and upstream availability still apply.
