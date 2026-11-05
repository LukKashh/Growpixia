# Revised Implementation Plan - Secure Username-Only Supabase Authentication

This plan addresses all architectural, database, and security requirements for GrowPixel's username-only Supabase authentication system supporting both React/Vite web and Android Kotlin clients.

## User Review Required

> [!IMPORTANT]
> Please review this revised implementation plan before execution.

1. **Database Preservation**: Reuses existing `public.profiles` (`id` UUID referencing `auth.users(id)`, `username` TEXT UNIQUE, `gems` BIGINT, `created_at` TIMESTAMPTZ) and existing tables (`worlds`, `world_members`, `world_blocks`, `player_inventory`, `world_events`). Does not create duplicate profile tables.
2. **Supabase Auth Adapter**: Uses server-mediated Edge Functions (`register-player` and `login-player`) with deterministic HMAC-SHA256 internal identifier mapping for secure username-only authentication without requiring email addresses.
3. **Recovery Codes**: Implements cryptographically secure, hashed one-time account recovery codes generated during registration.
4. **Row Level Security (RLS)**: Enforces strict RLS policies on `profiles`, `player_inventory`, and `worlds` to prevent client-side tampering of gems, inventory quantities, and world blocks.

---

## Proposed Changes & Architecture

### 1. Database & Migrations (`supabase/migrations/`)
- Ensure case-insensitive uniqueness on `profiles.username` using a functional unique index (`CREATE UNIQUE INDEX profiles_username_lower_idx ON public.profiles (LOWER(username));`).
- Verify RLS policies on `public.profiles`, `public.player_inventory`, and `public.worlds`.
- Table `recovery_codes` (or secure profile field storing hashed recovery codes) for single-use account recovery.

### 2. Supabase Edge Functions (`supabase/functions/`)
- **`register-player`**:
  - Validates username (3-16 chars, letters/numbers/underscores/hyphens, case-insensitive uniqueness).
  - Validates password (min 8 chars, matching confirmation).
  - Computes deterministic internal auth identifier via HMAC-SHA256.
  - Creates Supabase Auth account with auto-confirmed status.
  - Verifies/creates `public.profiles` record (integrating with existing `handle_new_user` trigger).
  - Generates a secure random recovery code, stores its cryptographic hash, and returns the plaintext recovery code once.
  - Returns Supabase session (access token, refresh token) and player profile.
- **`login-player`**:
  - Resolves internal identifier from normalized username.
  - Authenticates against Supabase Auth password.
  - Returns access token, refresh token, and player profile.
  - Applies rate limiting and generic error responses.

### 3. Client Integration
- **React / Vite (`src/App.tsx`)**:
  - Replace legacy auth calls with Supabase JS client auth (`supabase.auth.signInWithPassword`, or Edge Function invocation).
  - Preserve existing login/register UI design, username inputs, password confirmation, and gameplay transitions.
- **Android / Kotlin (`com.growpixel.game`)**:
  - Integrate Supabase REST/Auth API calls into the Android client.
  - Securely store session tokens in Android secure preferences / encrypted storage.
  - Ensure persistent sessions across app restarts.

---

## Verification Plan

### Automated Checks
- `npm run build`
- `npm run lint`

### Manual Verification Steps
1. Register new player (Username, Password, Confirm Password). Verify successful session and one-time recovery code presentation.
2. Attempt duplicate registration with different casing (e.g. `Hero` vs `hero`). Verify case-insensitive uniqueness check prevents collision.
3. Attempt registration with password < 8 characters or mismatched confirmation. Verify validation rejection.
4. Login with correct username and password. Verify access/refresh tokens and profile return.
5. Login with incorrect password or non-existent username. Verify generic error message (no enumeration).
6. Redeem one-time recovery code. Verify successful recovery and subsequent invalidation (reuse failure).
7. Verify RLS policies prevent users from modifying their own `gems` or `player_inventory` directly without server authorization.
8. Verify Android and Web browser clients can both authenticate and interact with the same backend session.
