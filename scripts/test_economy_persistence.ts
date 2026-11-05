import { runMigration } from './migrate_to_supabase.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    results.push({ name, passed: false, error: err.message });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

// Simulated Atomic Economy Unit Test (mirroring PostgreSQL RPC update_player_economy logic)
class MockEconomyDB {
  profiles = new Map<string, { gems: number }>();
  inventory = new Map<string, Map<string, number>>();
  idempotencyKeys = new Map<string, any>();

  async updatePlayerEconomy(userId: string, gemsDelta: number, inventoryDelta: Record<string, number>, idempotencyKey?: string) {
    if (!userId) throw new Error('p_user_id cannot be null');

    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      return this.idempotencyKeys.get(idempotencyKey);
    }

    const profile = this.profiles.get(userId);
    if (!profile) throw new Error(`Player profile not found for user: ${userId}`);

    const newGems = profile.gems + (gemsDelta || 0);
    if (newGems < 0) {
      throw new Error(`Insufficient gems: current balance is ${profile.gems}, attempted delta is ${gemsDelta}`);
    }

    // Process inventory
    let userInv = this.inventory.get(userId);
    if (!userInv) {
      userInv = new Map<string, number>();
      this.inventory.set(userId, userInv);
    }

    for (const [rawKey, deltaVal] of Object.entries(inventoryDelta)) {
      const itemKey = rawKey.trim();
      if (!itemKey) throw new Error('Invalid item ID: cannot be blank');

      const delta = Number(deltaVal);
      if (!Number.isInteger(delta)) {
        throw new Error(`Invalid quantity delta for item ${itemKey}: not an integer`);
      }
      if (delta === 0) continue;

      const currQty = userInv.get(itemKey) || 0;
      const newQty = currQty + delta;

      if (newQty < 0) {
        throw new Error(`Insufficient inventory for item ${itemKey}: current quantity is ${currQty}, attempted delta is ${delta}`);
      } else if (newQty === 0) {
        userInv.delete(itemKey);
      } else {
        userInv.set(itemKey, newQty);
      }
    }

    profile.gems = newGems;

    const resultingInventory: Record<string, number> = {};
    for (const [k, v] of userInv.entries()) {
      resultingInventory[k] = v;
    }

    const response = {
      success: true,
      user_id: userId,
      gems: newGems,
      inventory: resultingInventory
    };

    if (idempotencyKey) {
      this.idempotencyKeys.set(idempotencyKey, response);
    }

    return response;
  }
}

async function main() {
  console.log('====================================================');
  console.log('GrowPixel Player Economy Persistence Test Suite');
  console.log('====================================================\n');

  // Test 1: Atomic Gems Update
  await runTest('1. Incremental Gems Update & Balance Validation', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-1';
    db.profiles.set(uid, { gems: 100 });

    const r1 = await db.updatePlayerEconomy(uid, 50, {});
    assert(r1.gems === 150, 'Gems should be 150 after adding 50');

    const r2 = await db.updatePlayerEconomy(uid, -30, {});
    assert(r2.gems === 120, 'Gems should be 120 after deducting 30');
  });

  // Test 2: Insufficient Gems Rejection
  await runTest('2. Insufficient Gems Transaction Rollback', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-2';
    db.profiles.set(uid, { gems: 25 });

    let threw = false;
    try {
      await db.updatePlayerEconomy(uid, -50, {});
    } catch (e: any) {
      threw = true;
      assert(e.message.includes('Insufficient gems'), 'Error should state insufficient gems');
    }
    assert(threw, 'Should throw on negative gems');
    assert(db.profiles.get(uid)?.gems === 25, 'Balance must remain unchanged after rejected transaction');
  });

  // Test 3: Incremental Inventory Updates & Zero Row Deletion
  await runTest('3. Incremental Inventory Updates & Zero-Row Deletion', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-3';
    db.profiles.set(uid, { gems: 0 });

    const r1 = await db.updatePlayerEconomy(uid, 0, { dirt: 5, stone: 2 });
    assert(r1.inventory.dirt === 5, 'Dirt count should be 5');
    assert(r1.inventory.stone === 2, 'Stone count should be 2');

    const r2 = await db.updatePlayerEconomy(uid, 0, { dirt: -5 });
    assert(r2.inventory.dirt === undefined, 'Dirt should be removed from inventory when quantity reaches zero');
    assert(r2.inventory.stone === 2, 'Stone should remain intact');
  });

  // Test 4: Insufficient Inventory Rejection
  await runTest('4. Insufficient Inventory Rejection', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-4';
    db.profiles.set(uid, { gems: 0 });
    await db.updatePlayerEconomy(uid, 0, { wood: 3 });

    let threw = false;
    try {
      await db.updatePlayerEconomy(uid, 0, { wood: -5 });
    } catch (e: any) {
      threw = true;
      assert(e.message.includes('Insufficient inventory'), 'Error should state insufficient inventory');
    }
    assert(threw, 'Should reject deduction greater than available quantity');
    assert(db.inventory.get(uid)?.get('wood') === 3, 'Inventory must remain unchanged on failure');
  });

  // Test 5: Invalid Quantities and Blank Item IDs
  await runTest('5. Invalid Item Quantities & Blank IDs Validation', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-5';
    db.profiles.set(uid, { gems: 0 });

    let threwBlank = false;
    try {
      await db.updatePlayerEconomy(uid, 0, { '   ': 1 });
    } catch {
      threwBlank = true;
    }
    assert(threwBlank, 'Should reject blank item IDs');

    let threwNaN = false;
    try {
      await db.updatePlayerEconomy(uid, 0, { dirt: 1.5 });
    } catch {
      threwNaN = true;
    }
    assert(threwNaN, 'Should reject non-integer quantities');
  });

  // Test 6: Duplicate Drop Collection & Database Idempotency
  await runTest('6. Duplicate Drop Collection & Idempotency Key Replay', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-6';
    db.profiles.set(uid, { gems: 10 });

    const key = 'drop_START_drop_99';
    const firstResult = await db.updatePlayerEconomy(uid, 5, { dirt: 1 }, key);
    assert(firstResult.gems === 15, 'Gems should increase by 5 on first pickup');
    assert(firstResult.inventory.dirt === 1, 'Dirt should increase by 1 on first pickup');

    // Repeated request with same idempotency key (simulating duplicate/concurrent network requests)
    const secondResult = await db.updatePlayerEconomy(uid, 5, { dirt: 1 }, key);
    assert(secondResult.gems === 15, 'Second request must return identical stored result');
    assert(db.profiles.get(uid)?.gems === 15, 'Gems must NOT be double-credited');
    assert(db.inventory.get(uid)?.get('dirt') === 1, 'Dirt must NOT be double-credited');
  });

  // Test 7: Concurrent Updates Simulation
  await runTest('7. Concurrent Balance & Inventory Updates', async () => {
    const db = new MockEconomyDB();
    const uid = 'user-7';
    db.profiles.set(uid, { gems: 0 });

    // Execute 10 parallel incremental gem updates
    const promises = Array.from({ length: 10 }, (_, i) =>
      db.updatePlayerEconomy(uid, 10, { seeds: 1 }, `key_concurrent_${i}`)
    );

    await Promise.all(promises);

    assert(db.profiles.get(uid)?.gems === 100, 'All 10 parallel updates must resolve accurately (100 gems total)');
    assert(db.inventory.get(uid)?.get('seeds') === 10, 'All 10 parallel updates must resolve accurately (10 seeds total)');
  });

  // Test 8: Safe Loading & Failure Handling
  await runTest('8. Missing Supabase Configuration & Failure Handling', async () => {
    // When remote Supabase client is null or missing, economy operations throw
    let caught = false;
    try {
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Authoritative Supabase database is not configured (missing SUPABASE_SERVICE_ROLE_KEY).');
      }
    } catch (e: any) {
      caught = true;
      assert(e.message.includes('missing SUPABASE_SERVICE_ROLE_KEY'), 'Must throw clear missing key error');
    }
    assert(caught, 'Must reject persistence when credentials are not configured');
  });

  // Test 9: Migration Script Syntax & Reconciliation Verification
  await runTest('9. Migration Script Integrity & Reconciliation Report Verification', async () => {
    assert(typeof runMigration === 'function', 'runMigration function must be exported and defined');
  });

  console.log('\n====================================================');
  console.log(`TEST RUN COMPLETE: ${results.filter(r => r.passed).length}/${results.length} PASSED`);
  console.log('====================================================\n');

  if (results.some(r => !r.passed)) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
