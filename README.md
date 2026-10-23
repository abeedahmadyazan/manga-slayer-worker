# MANGA SLAYER — Cloudflare Worker source

This repository contains the Cloudflare Worker backend source for MANGA SLAYER, prepared for review and quota optimization.

## Download

[Download the complete Worker source archive](./manga-slayer-worker-source.zip)

Extract the archive, install dependencies with `npm ci`, then follow the included README for checks and setup. Cloudflare credentials and Firebase service-account private keys are intentionally excluded; configure them as Cloudflare Worker secrets in your own account.

This repository contains the Worker backend only. It does not contain the Android app source, APK signing keys, private credentials, or user data. Uploading source to GitHub does not itself reduce Cloudflare usage; usage changes only after an optimized backend is deployed.
