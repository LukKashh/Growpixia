import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { toCanonicalString } from '../src/lib/canonicalJson.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const BACKUP_FILE = path.join(DATA_DIR, 'accounts.backup.json');

interface LegacyAccount {
  id: string;
  username: string;
  gems: number;
  inventory: Record<string, number>;
  createdAt?: number;
  lastLogin?: number;
}

function generateVerificationHash(userId: string, gems: number, inventory: any): string {
  const payload = { userId, gems, inventory: Object.fromEntries(Object.entries(inventory).sort()) };
  return crypto.createHash('sha256').update(toCanonicalString(payload)).digest('hex');
}

export async function runMigration(dryRun: boolean = true) {
  console.log('====================================================');
  console.log(`GrowPixel Hardened Migration Ledger (DryRun: ${dryRun})`);
  console.log('====================================================');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Migration aborted: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`Migration aborted: Accounts file not found at ${ACCOUNTS_FILE}`);
  }

  if (!fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(ACCOUNTS_FILE, BACKUP_FILE);
    console.log(`Created immutable backup at: ${BACKUP_FILE}`);
  }

  const rawAccounts: Record<string, LegacyAccount> = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  const totalAccounts = Object.keys(rawAccounts).length;
  console.log(`Loaded ${totalAccounts} legacy accounts from JSON.`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let mismatchCount = 0;

  for (const [key, acc] of Object.entries(rawAccounts)) {
    const cleanUsername = (acc.username || key).trim();
    console.log(`\n--- [${cleanUsername}] ---`);

    // 1. Map to Supabase Profile (Read-only)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, gems')
      .ilike('username', cleanUsername)
      .maybeSingle();

    if (profileError) {
      console.error(`Error querying profile for ${cleanUsername}: ${profileError.message}`);
      failedCount++;
      continue;
    }

    if (!profile) {
      console.warn(`Profile not found in Supabase for ${cleanUsername}.`);
      if (!dryRun) {
        await supabase.from('migration_ledger').upsert({
          legacy_username: cleanUsername,
          status: 'failed',
          error_message: 'Profile not found in profiles table.'
        });
      }
      failedCount++;
      continue;
    }

    const userId = profile.id;
    const targetGems = Math.max(0, Math.floor(Number(acc.gems) || 0));
    const targetInventory: Record<string, number> = {};
    for (const [item, qty] of Object.entries(acc.inventory || {})) {
      const q = Math.floor(Number(qty) || 0);
      if (q > 0) targetInventory[item] = q;
    }

    const verificationHash = generateVerificationHash(userId, targetGems, targetInventory);

    if (dryRun) {
      // Comparison logic for Dry Run
      const { data: currentData, error: loadErr } = await supabase.rpc('load_player_data', { p_user_id: userId });
      
      if (loadErr) {
        console.error(`Could not load existing data for comparison: ${loadErr.message}`);
        failedCount++;
      } else {
        const currentHash = generateVerificationHash(userId, currentData.gems, currentData.inventory);
        const match = currentHash === verificationHash;
        
        console.log(`JSON: ${targetGems} gems, ${Object.keys(targetInventory).length} items`);
        console.log(`DB:   ${currentData.gems} gems, ${Object.keys(currentData.inventory).length} items`);
        
        if (match) {
          console.log('STATUS: MATCH (Already synchronized)');
          successCount++;
        } else {
          console.log('STATUS: MISMATCH (Requires migration)');
          mismatchCount++;
        }
      }
      continue;
    }

    // 2. Execution Logic (Only if not dryRun)
    const { data: ledgerEntry } = await supabase
      .from('migration_ledger')
      .select('status')
      .eq('legacy_username', cleanUsername)
      .maybeSingle();

    if (ledgerEntry?.status === 'verified') {
      console.log('Already migrated and verified. Skipping.');
      skippedCount++;
      continue;
    }

    try {
      console.log('Executing migration...');
      
      await supabase.from('migration_ledger').upsert({
        legacy_username: cleanUsername,
        supabase_user_id: userId,
        gems_imported: targetGems,
        inventory_imported: targetInventory,
        status: 'pending',
        verification_hash: verificationHash
      });

      const { error: gemsErr } = await supabase.from('profiles').update({ gems: targetGems }).eq('id', userId);
      if (gemsErr) throw gemsErr;

      await supabase.from('player_inventory').delete().eq('user_id', userId);
      const rows = Object.entries(targetInventory).map(([item_id, quantity]) => ({ user_id: userId, item_id, quantity }));
      if (rows.length > 0) {
        const { error: insErr } = await supabase.from('player_inventory').insert(rows);
        if (insErr) throw insErr;
      }

      const { data: verifiedData, error: verifyLoadErr } = await supabase.rpc('load_player_data', { p_user_id: userId });
      if (verifyLoadErr) throw verifyLoadErr;

      const finalHash = generateVerificationHash(userId, verifiedData.gems, verifiedData.inventory);
      if (finalHash !== verificationHash) throw new Error('Verification hash mismatch after migration.');

      await supabase.from('migration_ledger').update({ status: 'verified' }).eq('legacy_username', cleanUsername);
      console.log('Migration completed and verified successfully.');
      successCount++;
    } catch (err: any) {
      console.error(`Migration FAILED for ${cleanUsername}:`, err.message);
      await supabase.from('migration_ledger').upsert({
        legacy_username: cleanUsername,
        status: 'failed',
        error_message: err.message
      });
      failedCount++;
    }
  }

  console.log('\n====================================================');
  console.log('MIGRATION SUMMARY');
  console.log('====================================================');
  if (dryRun) {
    console.log(`Matched:          ${successCount}`);
    console.log(`Mismatched:       ${mismatchCount}`);
  } else {
    console.log(`Success/Verified: ${successCount}`);
    console.log(`Skipped:          ${skippedCount}`);
  }
  console.log(`Failed/Error:     ${failedCount}`);
  console.log(`Total Accounts:   ${totalAccounts}`);
}

if (process.argv.includes('--run')) {
  runMigration(false).catch(err => { console.error(err); process.exit(1); });
} else {
  runMigration(true).catch(err => { console.error(err); process.exit(1); });
}
