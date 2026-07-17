# Papra Email Proxy

[![codecov](https://codecov.io/gh/Robert27/papra-email-proxy/graph/badge.svg?token=NNC7YQEQOQ)](https://codecov.io/gh/Robert27/papra-email-proxy)

**Forward inbound email to your self-hosted [Papra](https://papra.app) instance via [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/) — with first-class support for [Cloudflare Zero Trust (Access)](https://developers.cloudflare.com/cloudflare-one/).**

A fork of the official [papra-hq/email-proxy](https://github.com/papra-hq/email-proxy) that adds optional **Access service-token authentication** on outbound webhook calls, so Papra can sit behind Zero Trust without breaking email ingestion.

## Why Cloudflare Zero Trust matters here

Many self-hosted Papra setups protect the web UI with **[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)** — visitors must sign in before reaching `https://papra.example.com`. That is great for humans, but **email webhooks are not browsers**: when this worker POSTs to your intake endpoint, Access would normally block or redirect the request.

This fork solves that by attaching **Access service-token headers** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) to every webhook call when you configure them. Papra stays locked down for the public internet while the worker authenticates as a trusted machine-to-machine client.

| Scenario | Without service tokens | With this fork |
| --- | --- | --- |
| Papra behind Access | Webhook fails (401/302) | Worker authenticates via service token |
| Papra on a public URL | Works (same as upstream) | Works — leave Access vars unset |
| Security posture | N/A | Zero Trust on UI **and** automated intake |

### Quick setup for Access-protected Papra

1. In **Zero Trust → Access → Service Auth**, create a [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).
2. Add an **Access application** for your Papra hostname with a policy that allows that service token (e.g. *Service Auth → Include →* your token).
3. Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` on this worker (dashboard or `wrangler secret put`).
4. Deploy — the worker sends the headers automatically; no code changes needed.

If your intake URL is **not** behind Access, omit those variables. Behavior matches upstream.

## Difference from upstream

Same core behavior as [papra-hq/email-proxy](https://github.com/papra-hq/email-proxy): receive email via Cloudflare Email Routing, parse it, and POST to Papra's `/api/intake-emails/ingest` webhook.

**Addition in this fork:** optional Cloudflare Zero Trust service-token headers on outbound `fetch`, so Access-protected origins work out of the box.

> [!TIP]
> Prefer a managed setup? [OwlRelay](https://owlrelay.email) offers hosted email-to-Papra forwarding.

## Usage

1. **Deploy** this worker to your Cloudflare account.
   1. Clone this repository.
   2. Install dependencies: `pnpm install`
   3. Deploy: `pnpm run deploy`
2. **Configure** environment variables (Cloudflare dashboard or secrets):
   - `WEBHOOK_URL` — Papra intake endpoint, e.g. `https://<your-instance>/api/intake-emails/ingest`
   - `WEBHOOK_SECRET` — same value as `INTAKE_EMAILS_WEBHOOK_SECRET` on your Papra instance
   - `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` *(optional)* — [Access service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) for Zero Trust–protected Papra hosts
3. **Route email** in Cloudflare Email Routing: create a catch-all (or specific) rule that sends mail to this worker.
4. **In Papra**, create intake emails under **Integrations** and allow the sender addresses you expect.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `pnpm dev`.

## Contributing

Contributions are welcome! Open an issue or submit a pull request.

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Upstream by [Corentin Thomasset](https://corentin.tech) — [papra-hq/email-proxy](https://github.com/papra-hq/email-proxy). Consider [supporting their work](https://buymeacoffee.com/cthmsst).
