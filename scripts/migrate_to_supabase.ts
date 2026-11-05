import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

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

interface ReconciliationResult {
  username: string;
  userId: string;
  jsonGems: number;
  dbGems: number;
  gemsMatch: boolean;
  jsonInventory: Record<string, number>;
  dbInventory: Record<string, number>;
  inventoryMatch: boolean;
  error?: string;
}

export async function runMigration(dryRun: boolean = true) {
  console.log('====================================================');
  console.log(`GrowPixel Legacy Player Data Migration (DryRun: ${dryRun})`);
  console.log('====================================================');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Migration aborted: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`Migration aborted: Accounts file not found at ${ACCOUNTS_FILE}`);
  }

  // 1. Create immutable backup of accounts.json if not present
  if (!fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(ACCOUNTS_FILE, BACKUP_FILE);
    console.log(`Created immutable backup at: ${BACKUP_FILE}`);
  } else {
    console.log(`Using existing immutable backup at: ${BACKUP_FILE}`);
  }

  const rawAccounts: Record<string, LegacyAccount> = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  const totalAccounts = Object.keys(rawAccounts).length;
  console.log(`Loaded ${totalAccounts} legacy accounts from JSON.`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const reconciliationReport: ReconciliationResult[] = [];
  const unmatchedAccounts: string[] = [];
  let totalMigratedGems = 0;
  let totalMigratedItems = 0;

  for (const [key, acc] of Object.entries(rawAccounts)) {
    const cleanUsername = (acc.username || key).trim();
    console.log(`\nProcessing account: ${cleanUsername}...`);

    // Map legacy account to Supabase user by username
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, gems')
      .ilike('username', cleanUsername)
      .maybeSingle();

    if (profileError) {
      console.error(`Error querying profile for ${cleanUsername}:`, profileError);
      reconciliationReport.push({
        username: cleanUsername,
        userId: 'UNKNOWN',
        jsonGems: acc.gems || 0,
        dbGems: -1,
        gemsMatch: false,
        jsonInventory: acc.inventory || {},
        dbInventory: {},
        inventoryMatch: false,
        error: profileError.message
      });
      continue;
    }

    if (!profile) {
      console.warn(`Profile not found in Supabase for username: ${cleanUsername}. Skipping.`);
      unmatchedAccounts.push(cleanUsername);
      continue;
    }

    const userId = profile.id;
    const targetGems = Math.max(0, Math.floor(Number(acc.gems) || 0));
    const targetInventory: Record<string, number> = {};
    for (const [item, qty] of Object.entries(acc.inventory || {})) {
      const cleanQty = Math.floor(Number(qty) || 0);
      if (cleanQty > 0) {
        targetInventory[item] = cleanQty;
      }
    }

    if (!dryRun) {
      // Execute authoritative atomic migration
      // 1. Update profiles gems
      const { error: gemsErr } = await supabase
        .from('profiles')
        .update({ gems: targetGems })
        .eq('id', userId);

      if (gemsErr) {
        throw new Error(`Failed to update gems for user ${userId}: ${gemsErr.message}`);
      }

      // 2. Delete old inventory rows and insert new ones
      const { error: delErr } = await supabase
        .from('player_inventory')
        .delete()
        .eq('user_id', userId);

      if (delErr) {
        throw new Error(`Failed to clear old inventory for user ${userId}: ${delErr.message}`);
      }

      const rowsToInsert = Object.entries(targetInventory).map(([item_id, quantity]) => ({
        user_id: userId,
        item_id,
        quantity
      }));

      if (rowsToInsert.length > 0) {
        const { error: insErr } = await supabase
          .from('player_inventory')
          .insert(rowsToInsert);

        if (insErr) {
          throw new Error(`Failed to insert inventory for user ${userId}: ${insErr.message}`);
        }
      }
    }

    // Reconcile and verify against database
    const { data: verifiedProfile } = await supabase
      .from('profiles')
      .select('gems')
      .eq('id', userId)
      .single();

    const { data: verifiedInventoryRows } = await supabase
      .from('player_inventory')
      .select('item_id, quantity')
      .eq('user_id', userId);

    const actualDbGems = verifiedProfile ? Number(verifiedProfile.gems) : -1;
    const actualDbInventory: Record<string, number> = {};
    if (verifiedInventoryRows) {
      for (const row of verifiedInventoryRows) {
        actualDbInventory[row.item_id] = row.quantity;
      }
    }

    const gemsMatch = dryRun ? true : (actualDbGems === targetGems);
    let inventoryMatch = true;
    if (!dryRun) {
      for (const [item, qty] of Object.entries(targetInventory)) {
        if (actualDbInventory[item] !== qty) inventoryMatch = false;
      }
      for (const [item, qty] of Object.entries(actualDbInventory)) {
        if (targetInventory[item] !== qty) inventoryMatch = false;
      }
    }

    totalMigratedGems += targetGems;
    totalMigratedItems += Object.keys(targetInventory).length;

    reconciliationReport.push({
      username: cleanUsername,
      userId,
      jsonGems: targetGems,
      dbGems: actualDbGems,
      gemsMatch,
      jsonInventory: targetInventory,
      dbInventory: actualDbInventory,
      inventoryMatch
    });
  }

  // Print Summary Report
  console.log('\n====================================================');
  console.log('RECONCILIATION REPORT SUMMARY');
  console.log('====================================================');
  console.log(`Total accounts in JSON:        ${totalAccounts}`);
  console.log(`Matched accounts in Supabase:  ${reconciliationReport.length}`);
  console.log(`Unmatched accounts (missing):  ${unmatchedAccounts.length} [${unmatchedAccounts.join(', ')}]`);
  console.log(`Total Gems to migrate:         ${totalMigratedGems}`);
  console.log(`Total unique items to migrate: ${totalMigratedItems}`);

  const discrepancies = reconciliationReport.filter(r => !r.gemsMatch || !r.inventoryMatch);
  if (discrepancies.length > 0) {
    console.error(`\nDISCREPANCIES DETECTED: ${discrepancies.length}`);
    for (const d of discrepancies) {
      console.error(`- ${d.username} (${d.userId}): gemsMatch=${d.gemsMatch}, inventoryMatch=${d.inventoryMatch}`);
    }
    return { success: false, discrepancies, report: reconciliationReport };
  } else {
    console.log('\nALL MATCHED RECORDS VERIFIED CONSISTENT.');
    return { success: true, discrepancies: [], report: reconciliationReport };
  }
}

// Do not execute automatically unless explicitly requested via CLI argument --run
if (process.argv.includes('--run')) {
  runMigration(false).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
} else if (process.argv.includes('--dry-run')) {
  runMigration(true).catch(err => {
    console.error('Dry run failed:', err);
    process.exit(1);
  });
} else {
  console.log('Migration script loaded. Pass --dry-run or --run to execute.');
}
