# Edge check: is `X-Real-IP` the client's address? (spec 300, plan P-4)

`apps/auth` keys its per-IP limits on `X-Real-IP` (`advanced.ipAddress.ipAddressHeaders`), and
`apps/api` forwards the same header on the internal hop. That is only safe if Railway's edge
**overwrites** `X-Real-IP` with the real client address on every domain, and gives different
clients different addresses. This file holds the method and the recorded observations. The
verdict sets `AUTH_RATE_LIMIT_MODE` for production (`ip` if both properties hold everywhere,
otherwise `email`); the window's step 14 can only move it to `email`.

## Method

The probes (removed by the contract PR) return only the **caller's own** observed `X-Real-IP`
and the number of `X-Forwarded-For` entries, never their values, with `Cache-Control: no-store`:

- `apps/api`: `GET /api/v2/_diag/client-ip`
- `apps/auth`: `GET /__diag/client-ip`

For each domain, over IPv4 and over IPv6 where reachable:

1. **Overwrite.** Send forged headers:
   `curl -s -H 'X-Real-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://<domain>/<probe>`.
   Pass: `x_real_ip` is your real address, not `203.0.113.9`.
2. **Distinctness.** Probe from two different networks (for example home and a phone hotspot).
   Pass: two different `x_real_ip` values.

Pre-merge passive check of each production domain (no code deployed): record the `dig` CNAME
chain (it must end at Railway's edge, as the staging domains do) and `curl -sI` headers (the same
edge and proxy headers as staging).

## Observations (phase 13 and the window)

| Domain | When | IPv4 overwrite | IPv6 overwrite | Distinct | Notes |
|---|---|---|---|---|---|
| `api-staging.askansari.ai` | phase 13 | | | | |
| `auth-staging.askansari.ai` | phase 13 | | | | |
| staging `*.up.railway.app` (backend, auth) | phase 13 | | | | |
| `api.askansari.ai` | window step 14 | | | | passive check before the merge (2026-10-17): NO CNAME to Railway; A 104.21.29.181, 172.67.149.151, AAAA 2606:4700:3033::6815:1db5, 2606:4700:3031::ac43:9597 (Cloudflare); `curl -sI`: `server: cloudflare`, `cf-ray`, then `x-railway-edge: sin1`. Cloudflare proxies in front of Railway's edge, so the `X-Real-IP` Railway stamps is a Cloudflare egress address, not the client: **fails distinctness unless resolved** (escalated to security) |
| `api-35.ansari.chat` | window step 14 | | | | passive check before the merge (2026-10-17): CNAME `vyex12qb.up.railway.app.` → 69.46.46.35; `curl -sI`: `server: railway-hikari`, `x-railway-edge: sjc1`, no proxy headers; same edge as staging |
| `auth.askansari.ai` | window step 15 | | | | passive check before the merge (2026-10-17): no DNS record yet (attached in window step 15); it must not be Cloudflare-proxied |

**Verdict for production `AUTH_RATE_LIMIT_MODE`:** _(recorded by phase 13)_
