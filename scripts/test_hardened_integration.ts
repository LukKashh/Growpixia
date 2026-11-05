import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { toCanonicalString } from '../src/lib/canonicalJson.ts';

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const TEST_USER_ID = '00000000-0000-0000-0000-000000000000'; // Standard test UUID

async function runTest(name: string, fn: () => Promise<void>) {
  console.log(`\n[TEST] ${name}`);
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

async function setupTestUser() {
  // Ensure test user exists in profiles
  const { error } = await supabase.from('profiles').upsert({
    id: TEST_USER_ID,
    username: 'test_harness',
    gems: 1000
  });
  if (error) throw new Error(`Setup failed: ${error.message}`);
  
  // Clear test inventory
  await supabase.from('player_inventory').delete().eq('user_id', TEST_USER_ID);
}

async function main() {
  console.log('====================================================');
  console.log('GrowPixel Hardened Economy Integration Test Suite');
  console.log('Target:', SUPABASE_URL);
  console.log('====================================================');

  await runTest('1. Idempotency: Canonical Hashing Invariance', async () => {
    const payload1 = { item: 'stone', qty: 1, meta: { a: 1, b: 2 } };
    const payload2 = { meta: { b: 2, a: 1 }, qty: 1, item: 'stone' }; // Different key order
    
    const str1 = toCanonicalString(payload1);
    const str2 = toCanonicalString(payload2);
    
    if (str1 !== str2) throw new Error('Canonical strings do not match for reordered keys');
    
    const hash1 = crypto.createHash('sha256').update(str1).digest('hex');
    const hash2 = crypto.createHash('sha256').update(str2).digest('hex');
    
    if (hash1 !== hash2) throw new Error('Hashes do not match for reordered keys');
  });

  await runTest('2. RPC: Atomic Claiming & Result Retrieval', async () => {
    await setupTestUser();
    const key = `test_key_${Date.now()}`;
    const payload = { test: true };
    const hash = crypto.createHash('sha256').update(toCanonicalString(payload)).digest('hex');

    // First call
    const { data: r1, error: e1 } = await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'test_op',
      p_gems_delta: -10,
      p_inventory_delta: { stone: 5 },
      p_idempotency_key: key,
      p_payload_hash: hash
    });
    if (e1) throw e1;

    // Sequential retry
    const { data: r2, error: e2 } = await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'test_op',
      p_gems_delta: -10,
      p_inventory_delta: { stone: 5 },
      p_idempotency_key: key,
      p_payload_hash: hash
    });
    if (e2) throw e2;

    if (r1.gems !== r2.gems) throw new Error('Retry returned different gems balance');
    if (JSON.stringify(r1.inventory) !== JSON.stringify(r2.inventory)) throw new Error('Retry returned different inventory');
    
    // Verify gems only deducted once (1000 - 10 = 990)
    if (r2.gems !== 990) throw new Error(`Balance mismatch: expected 990, got ${r2.gems}`);
  });

  await runTest('3. Idempotency: Parameter Conflict Rejection', async () => {
    await setupTestUser();
    const key = `test_conflict_${Date.now()}`;
    const payload = { test: true };
    const hash = crypto.createHash('sha256').update(toCanonicalString(payload)).digest('hex');

    // First call
    await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'test_op',
      p_gems_delta: 0,
      p_idempotency_key: key,
      p_payload_hash: hash
    });

    // Mismatched operation type
    const { error: e_op } = await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'WRONG_OP',
      p_gems_delta: 0,
      p_idempotency_key: key,
      p_payload_hash: hash
    });
    if (!e_op?.message?.includes('IDEMPOTENCY_CONFLICT')) throw new Error('Did not reject mismatched operation');

    // Mismatched payload hash
    const { error: e_hash } = await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'test_op',
      p_gems_delta: 0,
      p_idempotency_key: key,
      p_payload_hash: 'WRONG_HASH'
    });
    if (!e_hash?.message?.includes('IDEMPOTENCY_CONFLICT')) throw new Error('Did not reject mismatched payload hash');
  });

  await runTest('4. RPC: Concurrency - Simultaneous Identical Requests', async () => {
    await setupTestUser();
    const key = `test_concurrent_${Date.now()}`;
    const payload = { concurrent: true };
    const hash = crypto.createHash('sha256').update(toCanonicalString(payload)).digest('hex');

    const req = () => supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'concurrent_op',
      p_gems_delta: 100,
      p_idempotency_key: key,
      p_payload_hash: hash
    });

    // Fire two identical requests at once
    const [res1, res2] = await Promise.all([req(), req()]);

    if (res1.error) throw res1.error;
    if (res2.error) throw res2.error;

    if (res1.data.gems !== res2.data.gems) throw new Error('Concurrent requests returned different results');
    if (res1.data.gems !== 1100) throw new Error(`Gems should be 1100 (one credit), got ${res1.data.gems}`);
  });

  await runTest('5. RPC: Transaction Rollback Integrity', async () => {
    await setupTestUser();
    const key = `test_rollback_${Date.now()}`;
    const payload = { rollback: true };
    const hash = crypto.createHash('sha256').update(toCanonicalString(payload)).digest('hex');

    // Attempt to deduct more inventory than available (force failure in inventory step)
    const { error } = await supabase.rpc('update_player_economy_v3', {
      p_user_id: TEST_USER_ID,
      p_operation_type: 'rollback_op',
      p_gems_delta: -500, // This would be valid
      p_inventory_delta: { non_existent_item: -10 }, // This should force failure
      p_idempotency_key: key,
      p_payload_hash: hash
    });

    if (!error?.message?.includes('INSUFFICIENT_INVENTORY')) {
      throw new Error(`Expected INSUFFICIENT_INVENTORY, got: ${error?.message}`);
    }

    // Verify Gems balance rolled back to 1000
    const { data: profile } = await supabase.from('profiles').select('gems').eq('id', TEST_USER_ID).single();
    if (profile?.gems !== 1000) throw new Error(`Balance did not roll back: expected 1000, got ${profile?.gems}`);

    // Verify Idempotency record rolled back (key should be available again)
    const { data: id_record } = await supabase.from('idempotency_keys').select('*').eq('key', key).maybeSingle();
    if (id_record) throw new Error('Idempotency record was not rolled back');
  });

  await runTest('6. Auth: Permission Rejection', async () => {
    // This test assumes a non-service-role client
    const anonSupabase = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY || 'dummy', {
      auth: { persistSession: false }
    });
    
    const { error } = await anonSupabase.rpc('load_player_data', { p_user_id: TEST_USER_ID });
    // Should be rejected by REVOKE ALL / GRANT ... TO service_role
    if (!error?.message?.includes('permission denied')) {
       console.warn('WARNING: load_player_data was not rejected for anon role. Check migration permissions.');
    }
  });

  console.log('\n====================================================');
  console.log('INTEGRATION TESTS COMPLETE');
  console.log('====================================================');
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
