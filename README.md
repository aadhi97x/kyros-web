# Kyros — web & API

Football club and academy platform for India. This repository holds the **REST API v1** (consumed by the [`kyros-app`](https://github.com/aadhi97x/kyros-app) mobile client) and the **web dashboards** for club owners, venue owners and platform admins.

Currency is INR throughout, stored as integer **paise** — never floats.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

Generate a JWT secret and paste it into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Point `DATABASE_URL` at a PostgreSQL 14+ database, then:

```bash
npm run db:migrate && npm run db:seed && npm run dev
```

The dashboard is at `http://localhost:3000/dashboard`, the API at `/api/v1`.

Seeded accounts all share the password `kyros-dev-2026` — the seed output lists them.

---

## Architecture

Two rules shape the layout, both taken from the specification:

> "Keep the club-config engine and the booking-lock logic isolated and well-tested."

> "The member-facing flow must branch on the club's `config` at runtime — never hardcode a single enrollment path."

So `src/domain/**` is **pure**: no Prisma, no Next.js, no I/O. Every business rule lives there and is unit-tested without a database. `src/app/api/**` and the `*/service.ts` files are the only places that touch Postgres.

```
src/
  domain/                  ← pure business logic, no I/O
    config/                ← THE club config engine (spec 3.2)
      schema.ts              versioned Zod schema, every toggle + default
      engine.ts              parse, migrate, normalise, patch, project
    enrollment/
      state-machine.ts     ← config-driven evaluator (spec 2.7)
      service.ts             database side of the same
    membership/
      policy.ts            ← pause / cancel / tier-change verdicts (spec 2.9)
      service.ts             applies those verdicts
    money/
      pricing.ts             price breakdowns, instalments, proration
      payments.ts            idempotent intake, wallet ledger
    consent/               ← DPDP (spec 2.3)
      scopes.ts              per-purpose definitions + notice text
      verification.ts        pluggable parent verifier (DigiLocker | mock | offline)
      service.ts             grant / check / withdraw
    attendance/service.ts    offline sync, absentee list, geofenced check-in
    catalog/search.ts        discovery filters (spec 2.4)
    player/age.ts            is_minor derivation — the only place that decides it
  lib/
    api/                     handler wrapper, error vocabulary, envelopes
    auth/                    JWT, OTP, passwords, session, RBAC
    audit.ts                 append-only audit log with redaction
    db.ts, env.ts
  app/
    api/v1/**                REST route handlers
    dashboard/               owner dashboard
prisma/
  schema.prisma              every entity from spec section 6
  seed.ts                    two clubs with opposite configurations
tests/                       148 tests over the pure domain modules
```

### The config engine

Every club stores a `config` JSON object. `parseClubConfig()` is the **only** way to read it — nothing else may cast `club.config`, because a config written by an older build must still produce correct behaviour today. It:

- migrates old versions forward (`CLUB_CONFIG_VERSION`, with a registered migration per step),
- validates cross-field combinations (a required demo at a club with demos off is rejected — members would have no way to join),
- **normalises** contradictions that have an obvious resolution (chat off ⇒ batch chat off), so every consumer sees one canonical truth,
- projects a **member-facing subset**, so absentee thresholds and geofence settings never leak to members.

### The enrollment state machine

Not a transition table — a deterministic **evaluator**. Given the full observable state of one enrollment attempt it returns the single step the member is on. That makes it idempotent across refreshes, exhaustively testable with no history to set up, and safe when a club changes its config mid-enrollment.

The mobile app renders whatever `step` comes back and must not infer the next screen. `assertActionAllowed()` re-evaluates server-side on every mutation, so a client that skips a gate is rejected.

Gate order encodes the product's priorities: **consent → demo → placement → capacity → trial → money → approval.**

---

## Things worth knowing before you change them

**Money is integer paise.** `assertPlanBalances()` will throw if an instalment schedule does not sum exactly to its total. Rounding remainders go to the last instalment.

**`Batch.activeCount` counts *claimed* places, not active members.** It is incremented by an atomic conditional `UPDATE … WHERE activeCount < capacity` at enrollment creation and released by `releaseBatchPlace()` on cancellation, rejection or failed payment. A SELECT-then-check inside a transaction is *not* sufficient at READ COMMITTED — two concurrent checkouts would both read 19/20 and both proceed.

**Payments are idempotent twice over:** a unique `idempotencyKey` on create, and a unique `gatewayPaymentId` on settle. Gateways retry webhooks; the second delivery must be a no-op.

**Attendance sync is replay-safe.** The device generates a `clientMutationId` per mark; the response's `acknowledgedMutationIds` tells it exactly which queue items to drop — including rejected ones, so a permanently-invalid mark cannot block the queue forever. Conflicts resolve by *device* time, not arrival time.

**`is_minor` is derived, never accepted from a client.** `src/domain/player/age.ts` is the only place that decides it.

**Consent records are immutable except for withdrawal.** Changing scope creates a new record so the history stays intact. Withdrawing a required purpose cancels the memberships that depend on it — that is the "honoured downstream" requirement, not an accident.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run verify` | Typecheck, lint and test — run before pushing |
| `npm test` | Vitest over the domain modules |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:seed` | Load demo data (destructive) |
| `npm run db:studio` | Prisma Studio |

---

## Security & privacy

- `.env` is git-ignored; `.env.example` documents every variable. Rotate anything that has ever been committed.
- `env()` **refuses to boot production** with `OTP_DEV_MODE=true` or `CONSENT_VERIFIER=mock`, because either would ship a consent mechanism that verifies nothing.
- RBAC is enforced server-side in `src/lib/auth/rbac.ts`. Club staff can only read players who actually have a relationship with their club.
- The audit log redacts passwords, OTPs, tokens, identity numbers and medical notes before writing.
- Parent identity verification stores an **opaque hash**, never document contents.
- No profiling or behavioural tracking of minors — `privacy.childProfilingEnabled` is a `z.literal(false)` and cannot be configured otherwise.

---

## Build status against the specification

**Build 1 — complete:** accounts and player profiles, DPDP consent, club setup and the config engine, catalog and filters, the demo → batch → enroll flow, packages and the dual fee model, part payments, coach-tap attendance with offline sync, membership lifecycle (pause / upgrade / cancel / waitlist), absentee follow-up, batch chat.

**Build 2 — modelled, not yet wired:** the venue marketplace, booking soft-locks, syllabus tracking, performance reports, owner analytics. Every entity exists in `schema.prisma` so nothing blocks the work.

**Open decisions** still needing answers are listed in [`DECISIONS.md`](./DECISIONS.md).
