# Open decisions

Spec section 11 asks the developer to flag these rather than assume. Here is where each one stands, what the code does in the meantime, and what changing the answer would cost.

---

### 1. Batch type rulebooks — general / squad / elite

**Still open.** Exact attendance minimums, fee structure and commitment terms per batch type.

**What the code does now:** `BatchType` exists as an enum (`GENERAL | SQUAD | ELITE`) and is stored, filtered and displayed, but carries no differing *rules*. All three behave identically.

**Cost to answer later:** low. Attendance minimums and commitment terms belong in the club config as a per-type block; the config engine already has a migration path for exactly this (`migrations` in `engine.ts`). No schema change needed if the rules are club-configurable, which they probably should be given design principle 3.

---

### 2. Turf access — can a casual member book directly, or only clubs?

**Still open.**

**What the code does now:** `Booking.bookedByAccountId` points at an `Account` and `bookedForClubId` is nullable, so a booking placed by an individual and one placed on behalf of a club are both representable. Nothing enforces either policy yet, because the booking endpoints are Build 2.

**Cost to answer later:** low, and the model does not need to change either way. If the answer is "clubs only", it becomes a guard in the booking route plus a filter on the venue catalog.

---

### 3. Monetisation — turf commission rate, SaaS fee to clubs

**Still open.**

**What the code does now:** commission is configured as `PLATFORM_COMMISSION_BPS` (basis points, default 1000 = 10%) and applied *only* to turf bookings, per spec 5.4. `commissionForBooking()` is unit-tested to never lose a paisa to rounding. No SaaS fee is charged or modelled.

**Cost to answer later:** low for the rate. A per-club or tiered rate would move it from an env var to a column on `Club`. A SaaS fee needs a new subscription entity and a billing cycle — that is a genuine piece of work, so it is worth deciding before Build 2 rather than during it.

---

### 4. Language scope for launch

**Answered in the spec: English only.**

**What the code does now:** all copy is English and inline. No i18n framework.

**Cost to add later:** moderate and rising. User-facing strings are spread across route handlers, the config engine's `describeConfig()`, and the consent notice. The consent notice is the awkward one — a translated notice is a *different legal artefact* and would need its own `noticeVersion`, which the schema already supports.

---

### 5. Legal sign-off on the consent mechanism and DigiLocker approach

**Outstanding — and this one blocks shipping.**

**What the code does now:**
- Consent is per-purpose and unbundled, with required purposes separated from genuinely declinable ones.
- The exact notice text and its version are stored **on each consent record**, so what was agreed to can be proven later.
- Verification is pluggable (`ParentVerifier`), with DigiLocker, manual-offline and mock implementations.
- The verifier stores an **opaque hash**, never identity document contents.
- Every consent event is audit-logged with redaction.
- `env()` refuses to boot production with `CONSENT_VERIFIER=mock`.

**What is NOT done:** the DigiLocker token exchange itself. `DigiLockerVerifier.complete()` throws with a pointer to the two calls that need filling in — that step requires a registered partner application, which is a commercial onboarding process rather than a coding one.

**Recommendation:** get counsel to review `src/domain/consent/scopes.ts` specifically. That file *is* the consent mechanism — the notice text, the purpose list, and which purposes are treated as non-declinable. It is written to be read by a lawyer, not just a developer.

---

### 6. Platform brand name

**Treated as answered: Kyros.**

**What the code does now:** used in package names, the JWT issuer, the API surface and all copy.

**Cost to change later:** low in code (a rename), higher outside it — app store listings, assets and any printed material. Worth confirming before the first store submission.

---

## Decisions taken during the build

These were not in section 11, but they were judgement calls worth recording.

**`Batch.activeCount` counts claimed places, not active members.** A place is claimed the moment a membership row is created and released on cancellation, rejection or failed payment. The alternative — counting only `ACTIVE` — lets two parents check out simultaneously into the last place. See the README for why a transaction alone does not fix this.

**Part payment activates the membership on the *first* instalment.** A player who has paid 40% can train while the rest is scheduled. The enrollment state machine then sits at `PAYMENT_INSTALMENTS_PENDING` rather than `ACTIVE`, so the app can keep nudging without implying the player is barred.

**Capacity is an admission gate, not an ongoing check.** Once a membership is paid, a batch going over capacity (through a promotion or an owner override) does not evict anyone.

**Attendance conflicts resolve by device time, not arrival time.** Two coaches marking the same player should resolve by when each actually tapped, not by whose connection recovered first.

**Rounding remainders in an instalment plan go to the last instalment.** The plan is then asserted to balance exactly, because a schedule that does not sum to its total is a support ticket every month.
