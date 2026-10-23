# MANGA SLAYER — Cloudflare Worker source

This repository contains the Cloudflare Worker backend source used by MANGA SLAYER, packaged for review and quota optimization.

## Download

[Download the complete Worker source archive](./manga-slayer-worker-source.zip)

Extract the archive, install dependencies with `npm ci`, then run the checks described in the included README. Cloudflare credentials and Firebase service-account private keys are intentionally excluded; configure those as Cloudflare Worker secrets in your own account.

This repository contains the Worker backend only. It does not contain the Android app source, APK signing keys, private credentials, or user data. Publishing this code to GitHub does not itself change Cloudflare usage; usage changes only after a backend optimization is deployed.
