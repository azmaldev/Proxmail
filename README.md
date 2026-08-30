<p align="center">
  <img src="ProxMail.png" alt="ProxMail" width="1280">
</p>

# ProxMail

A self-hosted email verification engine written in **Hono + TypeScript**. Validates emails through syntax analysis, DNS/MX checks, SMTP probing, and catch-all detection — no third-party APIs, no per-email fees.

## Features

- **Syntax validation** — RFC-style format checks, plus detection of role-based addresses (`admin@`, `info@`, `support@`, …).
- **Disposable domain blocklist** — 8,000+ disposable domains checked before any network request.
- **DNS/MX analysis** — resolves MX records with caching and guards against SSRF (private/loopback/reserved ranges).
- **SMTP probing** — MAIL FROM / RCPT TO verification over ports 25, 587, and 465 with STARTTLS, sender rotation, retries, and per-domain rate limiting.
- **Catch-all detection** — randomized mailbox probes analyzed by acceptance rate and response-time variance.
- **Provider classification** — recognizes Google Workspace, Microsoft 365, and other freemail providers; flags reputational and temporary errors.
- **Result tiers** — `tierUsed = 1` for DNS-only short-circuits, `tierUsed = 2` for full SMTP verification, so you can speed up high-volume batches.

## Requirements

- Node.js **18+** (developed on Node 24) and npm.

> **Note on SMTP:** outbound TCP on port 25 is commonly blocked by cloud/hosting providers. SMTP probing (the `valid`/`invalid` verdict) must run on a host that permits outbound SMTP (e.g. a VPS). The API/UI layer can run anywhere — including on a Worker — while the verifier runs on a VPS.

## Install

```bash
npm install
cp .env.example .env   # then edit as needed
```

## Usage

### CLI

```bash
npm run cli -- verify user@example.com
npm run cli -- verify user@example.com --json
npm run cli -- batch input.csv --output results.csv
```

`input.csv` must contain an `email` column. Output is written as CSV.

### HTTP API

```bash
npm run dev    # or: npm start
```

The server listens on `http://0.0.0.0:8080` by default.

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/health`       | Health check                                       |
| POST   | `/verify_single`| Verify one email. Body: `{ "email": "..." }`       |
| POST   | `/batch`        | Verify up to 1000 emails. Body: `{ "emails": [...] }` |

If `AUTH_TOKEN` is set, send it as `Authorization: Bearer <token>`.

### Configuration (`.env`)

| Variable                    | Default         | Description                              |
| --------------------------- | --------------- | ---------------------------------------- |
| `PORT`                      | `8080`          | HTTP port                                |
| `HOST`                      | `0.0.0.0`       | Bind address                             |
| `AUTH_TOKEN`                | *(empty)*       | Bearer token for the API (off if empty)  |
| `SMTP_TIMEOUT_MS`           | `10000`         | Per-command SMTP timeout                 |
| `DNS_TIMEOUT_MS`            | `5000`          | DNS resolution timeout                   |
| `CATCHALL_TEST`             | `true`          | Enable/disable catch-all probing         |
| `CHECK_DISPOSABLE`          | `true`          | Enable/disable disposable check          |
| `RATE_LIMIT_DELAY_MS`       | `2000`          | Min delay between probes per domain      |
| `MAX_CONCURRENT_DOMAINS`    | `5`             | Global concurrent-domain limit           |
| `MAX_CONCURRENT_PER_DOMAIN` | `2`             | Per-domain concurrent limit              |
| `RETRY_ATTEMPTS`            | `2`             | SMTP retry attempts on temp errors       |
| `RETRY_DELAY_MS`            | `5000`          | Base retry delay (exponential backoff)   |
| `SENDER_EMAIL`              | `verifier@localhost` | From-address for SMTP probing       |
| `HELO_HOSTNAME`             | *(hostname)*    | EHLO/HELO identity                       |

## Development

```bash
npm run typecheck   # TypeScript type check
npm test            # run unit tests (vitest)
npm run build       # compile TypeScript
```

## Results

Each verified email returns a `VerifyResult`:

```json
{
  "email": "user@example.com",
  "status": "valid",
  "confidence": 0.95,
  "subStatus": "mailbox_accepted",
  "provider": "self_hosted",
  "isDisposable": false,
  "isRoleBased": false,
  "isCatchAllDomain": false,
  "catchAllConfidence": 0,
  "mxRecords": ["mx.example.com"],
  "smtpCode": 250,
  "smtpMessage": "2.1.5 Ok",
  "portUsed": 25,
  "tierUsed": 2,
  "durationMs": 843,
  "cached": false
}
```

## License

[AGPL-3.0](LICENSE) © 2024–2026 Azmal Dev.
