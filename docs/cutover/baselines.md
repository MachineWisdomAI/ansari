# Production baselines B-1 to B-4 (spec 300, plan P-2)

The rate-limit numbers in `packages/auth/src/limits.ts` were approved pending these production
measurements. The operator runs them before the merge; the results, and any amendment to a
number, are recorded here. An amended number changes `limits.ts` in the cutover PR.

**Counts only.** The owner runs `00-preflight-app.sql` against production. This file carries its
counts and rates, never an id, an address or a row. The preflight's legacy admin inventory (ids
and addresses) stays with the owner. The same run's `to_copy` feeds the timing scale in
[`rehearsal.md`](rehearsal.md).

| Baseline | Source | How |
|---|---|---|
| **B-1** sign-ups per minute and per hour, 90 days, peak and p99; guest-shaped separately | the app database | `apps/auth/scripts/cutover/00-preflight-app.sql` (section B-1), and the guest row count it prints |
| **B-2** failed sign-ins per minute, 14 days | Railway HTTP logs | `POST /api/v2/users/login` with status 401, counted per minute (legacy logs no failed logins) |
| **B-3** reset emails per day and per peak hour, 90 days | the Resend dashboard | reset emails sent |
| **B-4** sign-ins and refreshes per minute, inside the `tokens` retention | the app database | `00-preflight-app.sql` (section B-4) |

## Results

| Baseline | Measured on | Result | The number it sizes | Confirmed or amended |
|---|---|---|---|---|
| B-1 | | | sign-up 3/60 s per IP; the fallback global ceiling `max(30/60 s, 10 × B-1 peak per minute)` | |
| B-2 | | | the list-walk alert (≥ 20 distinct emails in 10 min) | |
| B-3 | | | reset request caps (per IP 5/15 min, per email 3/h) | |
| B-4 | | | internal endpoints 600/60 s each; `/token` | |
