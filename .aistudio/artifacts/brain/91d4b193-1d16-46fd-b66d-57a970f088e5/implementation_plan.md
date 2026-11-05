# GrowPixel Backend Hardening & Integration Test Suite (Final Hardened)

This plan establishes strict database-level transaction safety, canonical payload fingerprinting for idempotency, and a comprehensive integration test suite to verify the hardened economy system against a real Supabase environment.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following decisions align with the final technical corrections:
> 1. **Atomic Idempotency Claiming**: We will use a single atomic PostgreSQL transaction. Claiming will be performed via `INSERT ... ON CONFLICT` on the `idempotency_keys` table (which requires a unique constraint). Concurrent identical requests will produce exactly one mutation and return the same result for both.
> 2. **Strict Canonical JSON**: Serialization will be restricted to validated JSON-compatible types. We will explicitly reject `NaN`, `Infinity`, `undefined`, functions, symbols, and circular references. Unsafe integers (where exact precision is required for quantities) will also be rejected.
> 3. **Authoritative Loading**: `loadPlayerData` will connect exclusively to the `load_player_data` RPC. All SQL objects will be schema-qualified (e.g., `public.profiles`) and execution restricted to `service_role`.
> 4. **Read-Only Dry Run**: The migration dry-run will be strictly prohibited from executing any `INSERT`, `UPDATE`, `DELETE`, `UPSERT`, or write-capable RPCs. It will produce a read-only reconciliation report against a non-production environment.

### Confirmed Decisions
- **Single-Transaction Semantics**: No separate "processing" commits. The mutation and result storage happen in one block.
- **Fingerprint Binding**: The hash is bound to the authenticated player UUID, operation type, and all transaction parameters (including server-calculated prices).
- **Concurrency Rejection**: Mismatched requests using an existing key will trigger a strict `409 CONFLICT`.

## 1. Overview & Core Concept
This update transitions the GrowPixel backend to a state of complete authoritative safety. By leveraging PostgreSQL's atomic constraints and a trusted canonical serialization utility, we ensure that every economic action is unique, verifiable, and resilient to both network retries and concurrent race conditions.

## 2. Technical Architecture & Data Strategy

### Atomic Transaction Flow
```unicode
┌────────────────┐      ┌──────────────────────────┐      ┌─────────────────────┐
│ Browser Client │─────▶│ Express Server (Node.js) │─────▶│ Supabase PostgreSQL │
└────────────────┘      └──────────────────────────┘      └─────────────────────┘
        │                            │                               │
        │ 1. Request (UUID)          │ 2. Canonicalize Payload       │ 3. RPC v2 TRANSACTION START
        │ ──────────────────────────▶│ (SHA-256 + Stable Types)      │ (Atomic INSERT ... ON CONFLICT)
        │                            │ ─────────────────────────────▶│ 4. If CONFLICT (Match):
        │                            │                               │    Return Stored Result
        │                            │                               │ 5. If NEW:
        │                            │                               │    Apply Economy Mutation
        │ 7. Sync Authoritative      │ 6. COMMIT & Return Result     │    Store Result in Record
        │ ◀──────────────────────────│ ◀─────────────────────────────│ (TRANSACTION END)
```

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Atomic Claiming logic
- **Approach**: `INSERT INTO idempotency_keys (...) ON CONFLICT (key) DO NOTHING` followed by a validation check of the existing record's metadata.
- **Why**: `SELECT ... FOR UPDATE` does not lock a row that hasn't been created yet. `INSERT ... ON CONFLICT` ensures the first request creates the "lock" row atomically.

### Decision 2: Strict Serialization Utility
- **Approach**: Dedicated recursive walker that validates types before concatenation.
- **Why**: Standard `JSON.stringify` allows `Infinity` (serialized as `null`) and doesn't sort keys. Our utility will throw on invalid types and ensure stable ordering for bit-perfect hashing.

## 4. Implementation Steps

### Phase 3: Strict Canonical Utility & RPC Hardening
- [ ] Implement `toCanonicalString(payload: unknown): string` in `server.ts`.
- [ ] Add guards for `NaN`, `Infinity`, `undefined`, functions, and unsafe integers.
- [ ] Update `update_player_economy_v2` SQL to use `INSERT ... ON CONFLICT`.
- [ ] Set `search_path = public` and schema-qualify all SQL objects.

### Phase 4: Secure Player Loading
- [ ] Standardize WS `world:join` to wait for `load_player_data` RPC.
- [ ] Ensure no fallback to `accountsCache` or guest mocks on DB error.
- [ ] Validate RPC response structure strictly before session creation.

### Phase 12: High-Fidelity Integration Testing
- [ ] **Concurrency Proof**: Execute two simultaneous identical requests; verify 1 mutation and 2 identical success responses.
- [ ] **Rollback Proof**: Cause a DB exception after a Gems update; verify Gems and idempotency state both revert.
- [ ] **Hash Invariance**: Confirm that varying JSON key order produces the same SHA-256.
- [ ] **Auth Proof**: Verify expired tokens and anonymous access are rejected.

### Phase 8: Read-Only Migration Verification
- [ ] Refactor `scripts/migrate_to_supabase.ts` dry-run to skip all `upsert`/`insert`/`update`/`delete` calls.
- [ ] Generate detailed reconciliation report (Missing vs. Mismatched).
- [ ] Verify dry-run against non-production project using restricted credentials.

## 5. Preservation & Safety
- **System Integrity**: Existing multiplayer gameplay, WebSocket logic, world persistence, and mechanics remain untouched.
- **Auction System**: Remains completely removed.
- **Data Protection**: No production migrations or data modifications will occur during this hardening phase.
