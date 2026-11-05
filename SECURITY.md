# Security policy — Celia Kids

## Reporting

This is a small clinic tool without a bug-bounty programme. Report issues privately to the
repository owner (GitHub private advisory → *Security → Report a vulnerability*). Please do not
open public issues for anything involving the staff PIN, Script Properties, or appointment data.
Target first response: 72 hours.

## What this system stores

| Data | Where | Notes |
| --- | --- | --- |
| Guardian name + phone | Google Sheet `Requests` | contact data only |
| Appointment day/time/status | Google Sheet `Requests` | administrative |
| Staff action history | Google Sheet `Audit` | no free-text medical notes |
| Calendar events | Google Calendar | title/ref only, description states no medical data |
| Staff PIN | Script Properties | constant-time comparison, never logged |
| LLM questions | not stored | screened, cached by hash, provider-side for free tiers |

**Never** add symptom, diagnosis, medication, child age, or file-upload fields.

## Controls in place

- `LockService` around every write; approval re-checks availability before creating an event.
- Staff secret compared in constant time (`constantTimeEquals_`); minimum length enforced by
  `validateConfig()` and `scripts/check-config.js`.
- No secret reaches the browser bundle: `gas/Index.html` contains no key, and CI blocks any
  build that references localhost or external CDNs.
- LLM input is screened for PII (email/phone) and medical content before any provider call;
  model output is stripped of markup and length-capped before rendering (text nodes only).
- Free-tier LLM inputs may be used for model improvement → assume anything sent leaves the
  clinic; the screen exists so nothing personal leaves.
- Rate limiting + daily budget + circuit breaker on the optional assistant.
- Bounded outage queues (25 requests / 100 audits) that fail closed rather than overpromise.
- Secret scanning: `gitleaks` in CI; `.env*`, `gas/`, and property exports are git-ignored.

## Known limitations (accepted for MVP)

- Staff auth is a shared PIN, not per-user authentication or SSO. Adequate only for a single
  small clinic with a strong secret; revisit before multi-user rollout.
- Public web-app deployment may require "anyone with the link" access; this is **not** an
  institutional authentication boundary.
- Free-tier Google quotas are not an SLA; outage behaviour is designed (queues + explicit
  warnings) but not guaranteed.
- Calendar exports and Sheet backups must be taken manually — the free tier has no automatic
  backup. See `docs/exit-plan.md`.

## Rotation runbook

1. Rotate the exposed value (Google AI Studio key, staff PIN).
2. Deploy the new value to Script Properties; verify `validateConfig()` returns `ok: true`.
3. Invalidate caches (`LLM_C_*`, `CK_SLOTS_*`) by waiting out their TTL.
4. If the value was committed: rewrite history, force a protected-branch review, and note it in
   the PR description. Assume the old value is public forever.
