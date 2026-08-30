# ProxMail — Planning Document (Hono / TypeScript Rebuild)

> A faithful, clean port of the Python `proxmail` email-verification engine to
> **Hono + TypeScript (Node runtime)**. Same product name and feature set.
> Deployment target: **Railway / Hostinger / any Node VPS** (full outbound TCP
> required for SMTP probing). Optionally the API/UI layer can sit on Cloudflare
> Workers, but **SMTP probing cannot run on Workers** (port 25 is blocked).

---

## 1. Why Hono + TypeScript (2026 reasoning)

- **Async-first** by design — ideal for concurrent SMTP/DNS I/O that defines an
  email verifier.
- **One language** across web UI, REST API, and internals (no Python/Flask +
  template split).
- **Lightweight & fast**: Hono is a small, standards-based router with first-class
  TypeScript support. Runs on any Node runtime.
- **Clean ownership**: this is a from-scratch rewrite under `proxmail`, so
  `ProxMail` remains ours end-to-end (no inherited third-party author headers).
- **Deployable**: runs identically on Railway, Hostinger VPS, Fly.io, or any
  Node host.

## 2. Cloudflare constraint (researched, verified June 2026)

- Cloudflare **Workers cannot open outbound TCP on port 25** (SMTP). Confirmed in
  Cloudflare docs: *"Connections to port 25 are prohibited ... Workers cannot
  create outbound connections on port 25."*
- Therefore the **SMTP RCPT-TO probe** must run on a host with full outbound
  sockets (VPS / Railway / Hostinger). Workers is fine for the public API & UI
  only, not the engine.
- **Decision:** target a plain **Node process** (single deployable) so nothing is
  fork-locked by Cloudflare. We still write components so the HTTP layer *could*
  be extracted to Workers later if desired.

---

## 3. Feature parity (ported 1:1 from Python)

| Feature | Ported from | Notes |
|---|---|---|
| Syntax validation (RFC) | `email-validator` | use `validator.isEmail`-style + strict local check |
| DNS MX resolution + caching | `dnspython` | use `dns` package or native `dns.resolveMx` with cache |
| SMTP RCPT TO probing (25/587/465) | `aiosmtplib` | custom minimal SMTP client over `node:net` TLS |
| Catch-all detection (5 probes, variance) | verifier | multi-probe, time-variance heuristic |
| Disposable domain blocklist | email_verifier | import existing `data/disposable_domains.txt` |
| Role-based detection (1018 prefixes) | verifier | import existing `data/role_based_prefixes.txt` |
| Provider classification | provider.py | MX pattern table |
| SSRF protection (block private IPs) | verifier | block private/loopback/CGNAT on MX resolve |
| Rate limiting + sender rotation | verifier | per-domain delay, retry/backoff |
| Bulk verification (concurrent async) | verifier | map over list with per-domain semaphore |
| CLI (`verify`, `batch`) | proxmail_cli | same UX, JSON/CSV out |
| Web UI + API | Flask routes | Hono routes (`/verify_single`, batch, status) |
| Caching (MX + catch-all) | verifier | in-memory caches |

## 4. Result model (compatible with Python output)

```ts
interface VerifyResult {
  email: string;
  status: "valid" | "invalid" | "unknown" | "unverifiable";
  confidence: number;        // 0..1
  subStatus: string;         // syntax_error, disposable_domain, smtp_accepted, ...
  provider: string;
  isDisposable: boolean;
  isRoleBased: boolean;
  isCatchAllDomain: boolean;
  catchAllConfidence: number;
  mxRecords: string[];
  smtpCode: number | null;
  smtpMessage: string | null;
  portUsed: number | null;
  tierUsed: 1 | 2;           // 1 = DNS only, 2 = SMTP
  durationMs: number;
  cached: boolean;
}
```

## 5. Verification pipeline (faithful order)

1. **Syntax** (deterministic, never retried) → `invalid / syntax_error`.
2. **Role-based prefix** check on local part.
3. **Disposable domain** check (exact + parent-domain match) → `disposable_domain`.
4. **MX resolution** (SSRF-validated, cached) → error → `dns_error_mx`.
5. **Catch-all detection** (skipped for known free-mail domains; 5 probes,
   response-time variance heuristic; cached).
6. **Provider classification** from MX hostnames.
7. **SMTP probe** (ports 25 → 587 → 465, sender rotation on reputation errors,
   per-domain rate limiting, retry with exponential backoff):
   - interpret via provider-specific + generic rules (250 valid / 550 invalid /
     temp-fail unknown / provider-block unverifiable).
8. Return result with `tierUsed`, `durationMs`, `cached` flags.

## 6. Project structure (clean filenames)

```
proxmail/
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
├── README.md
├── PLANNING.md
├── src/
│   ├── index.ts              # entry: CLI + HTTP runner switch
│   ├── server.ts             # Hono app (routes + middleware)
│   ├── config.ts             # env/config loader
│   ├── types/
│   │   └── result.ts         # shared types + result builder
│   ├── verifier/
│   │   ├── verifier.ts       # EmailVerifier orchestrator (pipeline)
│   │   ├── syntax.ts         # syntax validation
│   │   ├── dns.ts            # MX resolution + caching + SSRF guard
│   │   ├── smtp.ts           # SMTP probe client (net/TLS)
│   │   ├── catchall.ts       # catch-all detection
│   │   ├── provider.ts       # provider classification + response interpretation
│   │   ├── disposable.ts     # disposable domain loader + matching
│   │   └── roles.ts          # role-based prefix loader + matching
│   ├── routes/
│   │   └── api.ts            # /verify_single, /batch, /status
│   ├── middleware/
│   │   └── auth.ts           # shared-token auth (optional)
│   ├── data/
│   │   ├── disposable.txt    # imported blocklist
│   │   └── roles.txt         # imported role prefixes
│   └── lib/
│       └── logger.ts         # minimal logger
├── cli.ts                    # CLI entry (verify / batch)
└── tests/
    └── verifier.test.ts      # unit tests (syntax, disposable, roles, provider)
```

## 7. Dependencies

- `hono` — HTTP framework
- `validator` — email syntax validation
- `dns` (Node built-in) — MX resolution
- `dotenv` — config loading
- dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/validator`

## 8. Migration of data

- Copy `data/disposable_domains.txt` (8,368 domains) → `src/data/disposable.txt`.
- Copy `data/role_based_prefixes.txt` (1,018) → `src/data/roles.txt`.
- These ship in-repo (unignored) so clones get the features out of the box.

## 9. Deployment

- **Railway / Hostinger / VPS:** `npm run build && npm start` runs the Hono server
  + engine on the same process (full SMTP).
- **Env:** `PORT`, `AUTH_TOKEN`, `RATE_LIMIT_DELAY_MS`, `SMTP_TIMEOUT_MS`,
  `MAX_CONCURRENT_DOMAINS`, `SENDER_EMAIL` (optional overrides).
- **Cloudflare:** only the API/UI layer, engine removed (documented clearly).

## 10. Out of scope (v1 rebuild)

- Persistent storage (results are returned/in-memory like the original).
- CSV file upload UI (CLI `batch` covers it); API accepts JSON arrays.
- Email *sending* — this is verification only.
