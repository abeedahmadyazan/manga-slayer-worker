# MANGA SLAYER backend

[Browse the Worker source](./worker) · [Verification report](./worker/MIGRATION-VERIFICATION.md) · [APK downloads](https://github.com/abeedahmadyazan/manga-slayer-downloads/releases/latest)

The production API is deployed on Cloudflare's Free plan at `https://manga-slayer-api.yz-manga-api-v2.workers.dev/`. Previously installed APKs keep using `https://yz-manga-api-v2.yznabyd.workers.dev/`, which forwards to the new account. Firebase Authentication remains on the existing project, preserving Google accounts.

Production runs in **discussion-only mode** at the owner's request. Chapter numbers, Google accounts, avatars, comments and replies remain available. Chapter pages, downloads, translation fetching and periodic indexing are disabled. Saved discussion IDs are preserved; new chapter numbers use one compact row per title and public JSON cached for six hours. Repeated reads do not write to D1.

GitHub hosts this source, verification workflows and the APK download repository. Private account data and comments stay in D1. GitHub Actions checks the source and publishes browsable files from the [source archive](./manga-slayer-worker-source.zip); it does not deploy to Cloudflare or require Cloudflare credentials.

No private account data, authentication tokens, APK signing keys or service-account files belong in this repository. See [setup and limits](./worker/README.md) for details. Free quotas and upstream availability still apply.
