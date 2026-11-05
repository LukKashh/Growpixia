# Final Implementation Plan - Atomic Player Persistence and Auction Migration

## Goal
Establish authoritative, atomic, and secure data persistence in Supabase for player gems, inventory, and auctions, eliminating non-atomic legacy storage dependencies (`accounts.json`, `auctions.json`) while preserving existing game functionality.

## 1. Existing Architecture & Auction Behavior
- **Architecture**: In-memory `accountsCache` and `auctionsCache` persist via periodic JSON writes. Authoritative game server remains the source of truth for runtime state.
- **Auction Operations**:
  - `createAuctionHandler`: Escrows items from seller inventory.
  - `placeBidHandler`: Deducts/escrows gems, updates `currentBid`, refunds previous highest bidder.
  - `cancelAuctionHandler`: Marks status CANCELLED, refunds highest bidder, returns items to seller.
  - `buyNowAuctionHandler`: Invokes `placeBidHandler` logic with `buyNowPrice`.
  - `Auction Timer`: Automatically transitions `ACTIVE` auctions to `COMPLETED` or `EXPIRED_NO_BIDS`.

## 2. Database Schema & Migration Requirements
- **Preserved Schema**: `public.profiles` (`id`, `gems`), `public.player_inventory` (`user_id`, `item_id`, `quantity`).
- **New Tables**:
  - `public.auctions`: Matches the current `AuctionItem` interface.
  - `public.idempotency_keys`: `(key TEXT PRIMARY KEY, operation_type TEXT, created_at TIMESTAMPTZ)`.
- **Security**: 
  - Revoke all `PUBLIC` execution privileges.
  - Grant `EXECUTE` only to `service_role`.
  - RPC functions use `SECURITY DEFINER` with fixed `search_path`.

## 3. Atomic RPC Definitions
- `update_player_data(p_user_id UUID, p_gems_delta INT8, p_inventory_delta JSONB)`: Atomic incremental update.
- `update_auction_data(p_auction_id TEXT, p_operation TEXT, p_params JSONB, p_idempotency_key TEXT)`: Atomic auction state transition and economy reconciliation.

## 4. Detailed Auction Operations (Atomic Transactions)
- **Create**: Validate seller inventory > listed amount, deduct escrowed items, create auction.
- **Bid**: Validate auction active, seller not bidder, bid >= minimum, gems >= bid, update auction/bids, refund previous bidder.
- **Buy Now**: Validate auction active, buyer gems >= price, transfer payment to seller, transfer escrowed items to buyer, mark `COMPLETED`.
- **Cancel**: Validate seller, update status `CANCELLED`, refund highest bidder, return escrowed items.
- **Complete/Expire**: Transition `ACTIVE` to `COMPLETED`/`EXPIRED_NO_BIDS`, settle assets according to existing rules, ensure uniqueness.

## 5. Concurrency & Idempotency Mechanism
- **Concurrency**: Use `SELECT ... FOR UPDATE` on all relevant `profiles`, `player_inventory`, and `auctions` rows. Lock player records in deterministic UUID order to prevent deadlocks.
- **Idempotency**: All RPC calls require `idempotency_key`. The `update_auction_data` function must check the `idempotency_keys` table before executing and record success.

## 6. Security & Failure Handling
- **Security**: Require `SUPABASE_SERVICE_ROLE_KEY`. Reject startup if missing. No anon keys in server persistence.
- **Failure**: Await all RPC calls. Propagate errors. Broadcast updates *only* after transaction commit. If Supabase fails, fail the economy operation; no silent legacy fallbacks.

## 7. Legacy Data Migration, Cutover & Rollback
1. **Preparation**: Backup JSON files.
2. **Import & Reconciliation**: Map usernames to UUIDs. Import Gems, inventory, and auctions. Reconcile escrowed items.
3. **Verification**: Compare JSON state vs. Supabase before cutover.
4. **Cutover**: Disable JSON writes; point `server.ts` to Supabase exclusively.
5. **Rollback**: If migration fails, keep existing JSON data as the authoritative source and abort the cutover.

## 8. Expanded Testing & Validation
- **Economy**: Concurrent inventory/gems updates, invalid quantities, insufficient balance.
- **Auctions**: Simultaneous bids/buys, refund/return correctness, idempotency retry safety, expiration settlement.
- **Migration**: Data reconciliation, server restart recovery, Supabase availability check.
- **Security**: RPC privilege enforcement, no sensitive data exposure in browser.

## 9. Staged Implementation Sequence
1. [ ] **Pending**: Define RPC functions (Atomic Persistence + Auction).
2. [ ] **Pending**: Implement `idempotency_keys` table logic.
3. [ ] **Pending**: Refactor `server.ts` to replace `accountsCache` persistence calls.
4. [ ] **Pending**: Build migration/reconciliation script.
5. [ ] **Pending**: Execute cutover and verify with tests.

*Status: Plan revised. No code implemented yet.*
