# AGENTS.md

Guidance for AI agents working in this repository.

## Project overview

Cloudflare **Email Worker** that receives inbound mail via Email Routing, parses it, and forwards it to a Papra intake webhook. Optional **Cloudflare Zero Trust (Access)** service-token headers are added when configured.

- **Runtime**: Cloudflare Workers (no Node.js APIs)
- **Package manager**: pnpm (`packageManager` field pins the version)
- **Entry point**: `src/index.ts` (default export with `email` and `fetch` handlers)
- **Types**: `src/types.ts` (`Env` bindings)

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # local worker (needs .dev.vars)
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm typecheck        # tsc --noEmit
pnpm build            # wrangler build
pnpm deploy           # wrangler deploy
```

Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before finishing changes. CI runs all three on every PR.

## Architecture

```
Email Routing → Worker.email() → parseEmail() → triggerWebhook() → Papra /api/intake-emails/ingest
```

1. **`parseEmail`** — parses raw MIME with `postal-mime`, normalizes `from`/`to`, preserves `originalFrom` / `originalTo`.
2. **`toWebhookEmail`** — maps `postal-mime` types to `@owlrelay/webhook` expectations (required `from`, `Uint8Array` → `ArrayBuffer` for attachments).
3. **`resolveWebhookFetch`** — uses Workers native `fetch` (not `ofetch`) and optionally wraps it with Access headers.
4. **`fetch` handler** — returns a static response; HTTP is not used for ingestion.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `WEBHOOK_URL` | yes | Papra intake endpoint |
| `WEBHOOK_SECRET` | yes | Must match `INTAKE_EMAILS_WEBHOOK_SECRET` on Papra |
| `CF_ACCESS_CLIENT_ID` | no | Access service token (pair with secret below) |
| `CF_ACCESS_CLIENT_SECRET` | no | Access service token secret |

- Local dev: copy `.dev.vars.example` → `.dev.vars` (gitignored).
- **Do not** add secrets or env-specific URLs to `wrangler.toml` — deploy would overwrite dashboard values.

## Code conventions

- **Lint/format**: Biome (`biome.json`). Single quotes, semicolons, 2-space indent, 120 char line width.
- **Types**: prefer `type` over `interface`.
- **Imports**: Biome organizes imports on save/fix.
- **Unused vars**: prefix with `_` to ignore.
- **Control flow**: always use block statements (`if { }`, not `if x`).
- **Logging**: use `@crowlog/logger` with structured fields; include `requestId` in email handler logs.
- **Errors**: re-throw after logging in `email()` so Cloudflare can retry failed deliveries.

## Type boundaries

`postal-mime` and `@owlrelay/webhook` define different `Email` / `Address` shapes. When touching webhook payloads:

- Use `ParsedEmail` for parsed mail (required `from`).
- Use `toWebhookEmail()` before calling `triggerWebhook`.
- Do not pass `postal-mime` objects directly to `@owlrelay/webhook`.

## Scope and change discipline

- Keep changes minimal; this is a small worker (~200 lines).
- No test suite today — rely on `typecheck`, Biome, and `wrangler build`.
- Do not commit `.dev.vars`, `.env`, or other secrets.
- Do not create commits or open PRs unless explicitly asked.

## Dependency updates

Renovate is configured with `customManagers:biomeVersions` so `biome.json` `$schema` stays in sync when `@biomejs/biome` is bumped.

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (24 hours), matching Renovate’s `minimumReleaseAge: "1 day"`. Freshly published packages are blocked until they age out.
