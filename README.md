# Papra — Email proxy

This repository is a **fork of the official [Papra email proxy](https://github.com/papra-hq/email-proxy)** ([`papra-hq/email-proxy`](https://github.com/papra-hq/email-proxy)): a [Cloudflare Email Worker](https://developers.cloudflare.com/email-routing/email-workers/) that forwards email to your [Papra](https://papra.app) instance for document ingestion.

## Difference from upstream

**This fork keeps the same behavior as the official worker**, with one addition: **optional [Cloudflare Zero Trust (Access)](https://developers.cloudflare.com/cloudflare-one/) service-token headers** on outbound webhook requests.

If your Papra URL is behind **Access** (browser login on `https://…`), server-to-server calls to the intake endpoint would normally get blocked or redirected. When you set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, the worker attaches `CF-Access-Client-Id` / `CF-Access-Client-Secret` so the webhook can authenticate as a **service token** (configure a matching Access policy on your Papra hostname). Omit those variables if your origin is not protected by Access.

> [!TIP]
> For a more managed solution, you can consider using [OwlRelay](https://owlrelay.email) which is a hosted and managed solution to proxy emails to your Papra instance.

## Usage

1. Deploy this worker to your Cloudflare account.
   1. Clone this repository.
   2. Install the dependencies with `pnpm install`.
   3. Deploy the worker with `pnpm run deploy` (alias for `wrangler publish`).
2. Configure the worker with the following environment variables:
   - `WEBHOOK_URL`: The ingestion endpoint of your Papra instance, basically `https://<your-instance>/api/intake-emails/ingest`.
   - `WEBHOOK_SECRET`: The secret key to authenticate the webhook requests, the same as the `INTAKE_EMAILS_WEBHOOK_SECRET` environment variable in your Papra instance.
   - **(Optional, Access-protected origins)** `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: [Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) credentials. When both are set, the worker adds them to the webhook `fetch` so Papra can be reached behind Zero Trust. Leave unset if the intake URL is not behind Access.
3. Configure CF email routing rules to forward emails to the worker.
   1. Create a new email catch-all rule in your Cloudflare account.
   2. Set the action to trigger the worker you deployed in step 1.
4. In your Papra instance, generate some "intake emails" under the "Integrations" section and set an allowed email address to receive emails from.

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more information.

## Credits and Acknowledgements

Upstream project by [Corentin Thomasset](https://corentin.tech) — see [papra-hq/email-proxy](https://github.com/papra-hq/email-proxy).

If you find the upstream project helpful, please consider [supporting their work](https://buymeacoffee.com/cthmsst).
