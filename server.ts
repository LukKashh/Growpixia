import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { createClient } from '@supabase/supabase-js';
import { toCanonicalString } from './src/lib/canonicalJson.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Persistent data directory
const DATA_DIR = path.join(__dirname, 'data');
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WORLDS_DIR)) fs.mkdirSync(WORLDS_DIR, { recursive: true });

const firebaseConfigPath = path.join(__dirname, 'firebase-applet-config.json');
let firestoreDb: any = null;
try {
  if (fs.existsSync(firebaseConfigPath)) {
    const fbConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8'));
    const firebaseApp = initializeApp(fbConfig);
    firestoreDb = getFirestore(firebaseApp, fbConfig.firestoreDatabaseId);
    console.log('Connected to Firestore:', fbConfig.firestoreDatabaseId);
  }
} catch (e) {
  console.warn('Firebase server init warning:', e);
}

// --- Supabase Authoritative Token Verification & Economy Setup ---
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isRemoteSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  !SUPABASE_URL.includes('placeholder') &&
  !SUPABASE_URL.includes('example.supabase.co') &&
  SUPABASE_SERVICE_ROLE_KEY &&
  !SUPABASE_SERVICE_ROLE_KEY.includes('placeholder')
);

if (!isRemoteSupabaseConfigured) {
  console.warn('WARNING: SUPABASE_SERVICE_ROLE_KEY is required for authoritative player persistence. Economy operations will be safely rejected until configured.');
}

const supabaseAdmin = isRemoteSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    })
  : null;

interface VerifiedIdentity {
  userId: string;
  username: string;
}

async function verifyPlayerToken(token: string): Promise<VerifiedIdentity> {
  if (!token || typeof token !== 'string') {
    throw new Error('AUTH_REQUIRED: Invalid or missing token');
  }

  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error('AUTH_REQUIRED: Token cannot be empty');
  }

  if (!supabaseAdmin) {
    throw new Error('SERVER_CONFIG_ERROR: Supabase admin not configured');
  }

  const { data, error } = await supabaseAdmin.auth.getUser(cleanToken);
  if (error || !data?.user) {
    throw new Error('AUTH_INVALID: ' + (error?.message || 'Invalid session'));
  }

  const u = data.user;
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('username')
    .eq('id', u.id)
    .maybeSingle();

  const username = profile?.username || u.user_metadata?.username || `User_${u.id.substring(0, 8)}`;
  return {
    userId: u.id,
    username
  };
}

function calculatePayloadHash(payload: any): string {
  const str = toCanonicalString(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function broadcastToAllPlayers(payloadStr: string) {
  for (const room of activeRooms.values()) {
    for (const p of room.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(payloadStr);
      }
    }
  }
}

function notifyUserWS(username: string, payloadObj: any) {
  const lower = username.toLowerCase();
  const payloadStr = JSON.stringify(payloadObj);
  for (const room of activeRooms.values()) {
    for (const p of room.players.values()) {
      if (p.username.toLowerCase() === lower && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(payloadStr);
      }
    }
  }
}

// --- Authoritative Supabase-Backed Player Economy Persistence ---
export interface PlayerEconomyState {
  gems: number;
  inventory: Record<string, number>;
}

async function loadPlayerData(userId: string): Promise<PlayerEconomyState> {
  if (!supabaseAdmin) {
    throw new Error('Authoritative Supabase database is not configured (missing SUPABASE_SERVICE_ROLE_KEY).');
  }

  // Use the authoritative load_player_data RPC
  const { data, error } = await supabaseAdmin.rpc('load_player_data', {
    p_user_id: userId
  });

  if (error) {
    console.error(`Error in Supabase load_player_data for user ${userId}:`, error);
    throw new Error(`Database error loading player data: ${error.message}`);
  }

  if (!data || typeof data.gems !== 'number' || !data.inventory) {
    throw new Error(`Authoritative profile not found or malformed in Supabase for user: ${userId}`);
  }

  return {
    gems: Math.max(0, Number(data.gems)),
    inventory: (data.inventory as Record<string, number>) || {}
  };
}

async function updatePlayerEconomy(
  userId: string,
  operationType: string,
  gemsDelta: number,
  inventoryDelta: Record<string, number> = {},
  idempotencyKey?: string,
  payload?: any
): Promise<PlayerEconomyState> {
  if (!supabaseAdmin) {
    throw new Error('Authoritative Supabase database is not configured (missing SUPABASE_SERVICE_ROLE_KEY).');
  }

  // Generate stable SHA-256 hash of the payload for hardened idempotency using strict canonicalization
  const payloadHash = payload ? calculatePayloadHash(payload) : '';

  const { data, error } = await supabaseAdmin.rpc('update_player_economy_v3', {
    p_user_id: userId,
    p_operation_type: operationType,
    p_gems_delta: gemsDelta,
    p_inventory_delta: inventoryDelta,
    p_idempotency_key: idempotencyKey || null,
    p_payload_hash: payloadHash || null
  });

  if (error) {
    console.error(`Error in Supabase update_player_economy_v3 for user ${userId}:`, error);
    // Map specific database errors to user-friendly messages
    if (error.message?.includes('IDEMPOTENCY_CONFLICT')) {
       throw new Error('CONFLICT: This operation has already been processed with different parameters.');
    }
    if (error.message?.includes('INSUFFICIENT_FUNDS')) {
       throw new Error('INSUFFICIENT_FUNDS: Not enough Gems to complete this operation.');
    }
    if (error.message?.includes('INSUFFICIENT_INVENTORY')) {
       throw new Error('INSUFFICIENT_INVENTORY: Not enough items to complete this operation.');
    }
    throw new Error(error.message || 'Database economy transaction failed.');
  }

  if (!data || typeof data.gems !== 'number') {
    throw new Error('Invalid response payload received from update_player_economy_v3 RPC.');
  }

  return {
    gems: Math.max(0, Number(data.gems)),
    inventory: (data.inventory as Record<string, number>) || {}
  };
}

// Unified Register Handler (Supabase Auth Only)
const handleRegisterPlayer = async (req: Request, res: Response) => {
  try {
    const { username, password, confirmPassword } = req.body;
    const clean = (username || '').trim();
    if (!clean || clean.length < 3 || clean.length > 16 || !/^[a-zA-Z0-9_-]+$/.test(clean)) {
      return res.status(400).json({ error: 'Username must be 3-16 alphanumeric characters, hyphens, or underscores.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Auth server is temporarily unavailable (Supabase not configured).' });
    }

    // Authoritative Supabase Auth Path
    const internalEmail = `${clean.toLowerCase()}@growpixel.internal`;
    
    // 1. Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: internalEmail,
      password: password,
      user_metadata: { username: clean },
      email_confirm: true
    });

    if (authError) {
      if (authError.message.includes('already registered') || authError.message.includes('email_exists')) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      return res.status(400).json({ error: authError.message });
    }

    const user = authData.user;
    if (!user) throw new Error('Failed to create user record.');

    // 2. Initial profile setup
    const { error: profError } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: user.id, username: clean, gems: 0 });

    if (profError) {
      console.error('Failed to create profile record:', profError);
    }

    // Generate recovery code
    const rawRecoveryCode = crypto.randomBytes(16).toString('hex');
    const recoveryHash = crypto.createHash('sha256').update(rawRecoveryCode).digest('hex');
    await supabaseAdmin.from('recovery_codes').insert({ user_id: user.id, code_hash: recoveryHash });

    // 3. Login the user immediately to get a session
    const { data: loginData, error: loginError } = await supabaseAdmin.auth.signInWithPassword({
      email: internalEmail,
      password: password
    });

    if (loginError) {
      return res.status(200).json({
        success: true,
        user: { id: user.id, username: clean, gems: 0, inventory: {} },
        recoveryCode: rawRecoveryCode,
        message: 'Account created. Please log in manually.'
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        username: clean,
        gems: 0,
        inventory: {}
      },
      session: loginData.session,
      recoveryCode: rawRecoveryCode
    });
  } catch (err: any) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: err.message || 'Registration failed.' });
  }
};

// Unified Login Handler (Supabase Auth Only)
const handleLoginPlayer = async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const clean = (username || '').trim().toLowerCase();

    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Auth server is temporarily unavailable (Supabase not configured).' });
    }

    // Authoritative Supabase Auth Path
    const internalEmail = `${clean}@growpixel.internal`;
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: internalEmail,
      password: password
    });

    if (authError || !authData.user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Load authoritative player economy data
    const playerData = await loadPlayerData(authData.user.id).catch(() => ({ gems: 0, inventory: {} }));

    return res.status(200).json({
      success: true,
      user: {
        id: authData.user.id,
        username: authData.user.user_metadata?.username || username,
        gems: playerData.gems,
        inventory: playerData.inventory
      },
      session: authData.session
    });
  } catch (err: any) {
    console.error('Login error:', err);
    return res.status(500).json({ error: err.message || 'Login failed.' });
  }
};

// Unified Recovery Handler (Supabase Auth Only)
const handleRecoverPlayer = async (req: Request, res: Response) => {
  try {
    const { recoveryCode, newPassword } = req.body;
    if (!recoveryCode || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Invalid recovery code or password (minimum 8 characters required).' });
    }

    const codeHash = crypto.createHash('sha256').update(recoveryCode.trim()).digest('hex');

    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Auth server is temporarily unavailable (Supabase not configured).' });
    }

    // Authoritative Supabase Path
    const { data: recCode, error: recError } = await supabaseAdmin
      .from('recovery_codes')
      .select('user_id')
      .eq('code_hash', codeHash)
      .is('redeemed_at', null)
      .maybeSingle();

    if (recError || !recCode) {
      return res.status(400).json({ error: 'Invalid or already redeemed recovery code.' });
    }

    // 1. Update user password in Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(recCode.user_id, {
      password: newPassword
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    // 2. Mark code as redeemed
    await supabaseAdmin
      .from('recovery_codes')
      .update({ redeemed_at: new Date().toISOString() })
      .eq('user_id', recCode.user_id)
      .eq('code_hash', codeHash);

    return res.status(200).json({
      success: true,
      message: 'Password successfully reset using recovery code.'
    });
  } catch (err: any) {
    console.error('Recovery error:', err);
    return res.status(500).json({ error: err.message || 'Recovery failed.' });
  }
};

// Mount Authoritative Supabase Edge Function Endpoints
app.post('/functions/v1/register-player', handleRegisterPlayer);
app.post('/functions/v1/login-player', handleLoginPlayer);
app.post('/functions/v1/recover-player', handleRecoverPlayer);

// Deprecate standalone legacy endpoints by routing them to authoritative handlers
app.post('/api/auth/register', handleRegisterPlayer);
app.post('/api/auth/login', handleLoginPlayer);

const STORE_CATALOGUE: Record<string, number> = {
  small_lock: 10,
  medium_lock: 50,
  big_lock: 200,
  world_lock: 500,
  dirt: 1,
  stone: 2,
  wood: 5,
  seedPot: 5
};

app.post('/api/store/buy', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body.token || '');

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Session token required.' });
    }

    const verified = await verifyPlayerToken(token);
    if (!verified) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token.' });
    }
    const userId = verified.userId;

    const { itemId, count, requestId } = req.body;
    const cleanItem = (itemId || '').trim();
    const qty = Math.max(1, Math.floor(Number(count) || 1));

    // Validate item against authoritative store catalogue
    const unitPrice = STORE_CATALOGUE[cleanItem];
    if (unitPrice === undefined) {
      return res.status(400).json({ error: `Item '${cleanItem}' is not available in store catalogue.` });
    }

    const totalPrice = unitPrice * qty;

    // Stable request identifier for idempotency
    const idempotencyKey = (requestId || req.body.idempotencyKey || '').trim();
    if (!idempotencyKey) {
       return res.status(400).json({ error: 'requestId is required for store purchases.' });
    }

    const payload = { userId, itemId: cleanItem, count: qty, totalPrice };
    const updated = await updatePlayerEconomy(userId, 'store_buy', -totalPrice, { [cleanItem]: qty }, idempotencyKey, payload);

    // Sync active player if online
    for (const room of activeRooms.values()) {
      const p = room.players.get(userId);
      if (p) {
        p.gems = updated.gems;
        p.inventory = updated.inventory;
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({
            type: 'inventory:sync',
            inventory: p.inventory,
            gems: p.gems
          }));
        }
      }
    }

    return res.json({
      success: true,
      gems: updated.gems,
      inventory: updated.inventory
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Store purchase failed.' });
  }
});

// Administrative Gems endpoint is removed per Priority 2 security requirements.
// Exceptional Gems adjustments must be performed manually through the Supabase SQL Editor.


// Check if world exists and get overview
app.get('/api/world/:name', (req: Request, res: Response) => {
  const name = (req.params.name || '').trim().toUpperCase().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Invalid world name' });

  const worldFile = path.join(WORLDS_DIR, `${name}.json`);
  const exists = fs.existsSync(worldFile);
  const activeRoom = activeRooms.get(name);
  const playersCount = activeRoom ? activeRoom.players.size : 0;
  const worldOwner = activeRoom?.worldOwner || (exists ? getSavedWorldOwner(name) : null);

  res.json({
    name,
    exists,
    playersCount,
    worldOwner
  });
});

// List popular / active worlds
app.get('/api/worlds', (_req: Request, res: Response) => {
  const list: Array<{ name: string; players: number; owner: string | null }> = [];
  // Featured worlds
  const featured = ['START', 'MEADOW', 'MARKET'];
  for (const f of featured) {
    const room = activeRooms.get(f);
    list.push({
      name: f,
      players: room ? room.players.size : 0,
      owner: room?.worldOwner || getSavedWorldOwner(f)
    });
  }
  res.json({ worlds: list });
});

function getSavedWorldOwner(name: string): string | null {
  try {
    const file = path.join(WORLDS_DIR, `${name}.json`);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return data.worldOwner || null;
    }
  } catch (e) {}
  return null;
}

// --- Multiplayer Simulation Engine & Rooms ---
const WORLD_W = 180;
const WORLD_H = 65;

interface LockRecord {
  id: string;
  type: 'small_lock' | 'medium_lock' | 'big_lock' | 'world_lock';
  tx: number;
  ty: number;
  owner: string;
  allowedUsers: string[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface TreeRecord {
  x: number;
  y: number;
  id: string;
  age: number;
  mature: boolean;
}

interface DropRecord {
  id: string;
  itemId: string;
  x: number;
  y: number;
  count: number;
  value?: number;
  age: number;
}

interface ActivePlayer {
  id: string;
  username: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  pose: string;
  gems: number;
  inventory: Record<string, number>;
  ws: WebSocket;
}

interface WorldRoom {
  name: string;
  seed: number;
  tiles: (string | null)[][];
  locks: LockRecord[];
  trees: TreeRecord[];
  drops: DropRecord[];
  worldOwner: string | null;
  players: Map<string, ActivePlayer>;
  dirty: boolean;
}

const activeRooms = new Map<string, WorldRoom>();

function calculateBounds(type: string, tx: number, ty: number) {
  if (type === 'world_lock') {
    return { minX: 0, maxX: WORLD_W - 1, minY: 0, maxY: WORLD_H - 1 };
  }
  const radius = type === 'small_lock' ? 1 : type === 'medium_lock' ? 3 : 5; // 3x3, 7x7, 11x11
  return {
    minX: Math.max(0, tx - radius),
    maxX: Math.min(WORLD_W - 1, tx + radius),
    minY: Math.max(0, ty - radius),
    maxY: Math.min(WORLD_H - 1, ty + radius)
  };
}

// Cut off overlapping portions so adjacent locks meet at the border without overlapping
function clampBoundsNoOverlap(
  newB: { minX: number; maxX: number; minY: number; maxY: number },
  existB: { minX: number; maxX: number; minY: number; maxY: number },
  tx: number,
  ty: number
) {
  const overlapX = newB.minX <= existB.maxX && newB.maxX >= existB.minX;
  const overlapY = newB.minY <= existB.maxY && newB.maxY >= existB.minY;
  if (!overlapX || !overlapY) return newB;

  const res = { ...newB };
  if (tx > existB.maxX) {
    res.minX = Math.max(res.minX, existB.maxX + 1);
  } else if (tx < existB.minX) {
    res.maxX = Math.min(res.maxX, existB.minX - 1);
  } else if (ty > existB.maxY) {
    res.minY = Math.max(res.minY, existB.maxY + 1);
  } else if (ty < existB.minY) {
    res.maxY = Math.min(res.maxY, existB.minY - 1);
  } else {
    const distLeft = Math.abs(tx - existB.minX);
    const distRight = Math.abs(tx - existB.maxX);
    const distTop = Math.abs(ty - existB.minY);
    const distBottom = Math.abs(ty - existB.maxY);
    const minDist = Math.min(distLeft, distRight, distTop, distBottom);
    if (minDist === distRight) res.minX = Math.max(res.minX, existB.maxX + 1);
    else if (minDist === distLeft) res.maxX = Math.min(res.maxX, existB.minX - 1);
    else if (minDist === distBottom) res.minY = Math.max(res.minY, existB.maxY + 1);
    else res.maxY = Math.min(res.maxY, existB.minY - 1);
  }

  res.minX = Math.min(res.minX, tx);
  res.maxX = Math.max(res.maxX, tx);
  res.minY = Math.min(res.minY, ty);
  res.maxY = Math.max(res.maxY, ty);

  return res;
}

function generateWorldTiles(seed: number): (string | null)[][] {
  const tiles: (string | null)[][] = Array.from({ length: WORLD_H }, () => Array(WORLD_W).fill(null));
  const surf = 25;
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  for (let x = 0; x < WORLD_W; x++) {
    for (let y = surf; y < WORLD_H; y++) {
      tiles[y][x] = y >= WORLD_H - 4 ? 'lava' : 'dirt';
    }
  }

  // Stone pockets
  for (let i = 0; i < 155; i++) {
    const cx = 2 + Math.floor(rand() * (WORLD_W - 4));
    const cy = surf + 3 + Math.floor(rand() * (WORLD_H - surf - 9));
    const rx = 1 + Math.floor(rand() * 3), ry = 1 + Math.floor(rand() * 2);
    for (let yy = cy - ry; yy <= cy + ry; yy++) {
      for (let xx = cx - rx; xx <= cx + rx; xx++) {
        if (xx > 0 && xx < WORLD_W - 1 && yy > surf + 1 && yy < WORLD_H - 4 &&
          ((xx - cx) ** 2 / (rx * rx + 0.01) + (yy - cy) ** 2 / (ry * ry + 0.01)) < 1.2 && rand() > 0.16) {
          tiles[yy][xx] = 'stone';
        }
      }
    }
  }

  // Surface trees (skip near spawn door at x = 8)
  for (let x = 12; x < WORLD_W - 8; x++) {
    if (rand() < 0.045) {
      const trunk = 3 + Math.floor(rand() * 3);
      for (let k = 1; k <= trunk; k++) tiles[surf - k][x] = 'wood';
      const ty = surf - trunk;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = ty + dy;
          if (Math.abs(dx) + Math.abs(dy) < 4 && xx > 1 && xx < WORLD_W - 1 && yy > 1 && tiles[yy][xx] === null) {
            tiles[yy][xx] = 'leaves';
          }
        }
      }
    }
  }

  // Ground-level Spawn Door Block (permanent bedrock-tier world entrance fixture)
  tiles[surf - 1][8] = 'spawn_door';
  for (let dy = 2; dy <= 5; dy++) {
    tiles[surf - dy][8] = null;
  }

  return tiles;
}

function getOrCreateRoom(worldName: string): WorldRoom {
  const cleanName = worldName.trim().toUpperCase().slice(0, 24);
  if (activeRooms.has(cleanName)) {
    return activeRooms.get(cleanName)!;
  }

  const worldFile = path.join(WORLDS_DIR, `${cleanName}.json`);
  let room: WorldRoom;

  if (fs.existsSync(worldFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(worldFile, 'utf-8'));
      room = {
        name: cleanName,
        seed: saved.seed || 1,
        tiles: saved.tiles,
        locks: saved.locks || [],
        trees: saved.trees || [],
        drops: saved.drops || [],
        worldOwner: saved.worldOwner || null,
        players: new Map(),
        dirty: false
      };
    } catch (e) {
      console.error('Error reading saved world:', e);
      room = createNewRoom(cleanName);
    }
  } else {
    room = createNewRoom(cleanName);
  }

  activeRooms.set(cleanName, room);
  return room;
}

function createNewRoom(name: string): WorldRoom {
  let seed = 2166136261;
  for (let i = 0; i < name.length; i++) {
    seed ^= name.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  seed = (seed >>> 0) || 1;

  const tiles = generateWorldTiles(seed);
  return {
    name,
    seed,
    tiles,
    locks: [],
    trees: [],
    drops: [],
    worldOwner: null,
    players: new Map(),
    dirty: true
  };
}

function saveRoomToDisk(room: WorldRoom) {
  const worldFile = path.join(WORLDS_DIR, `${room.name}.json`);
  const data = {
    name: room.name,
    seed: room.seed,
    tiles: room.tiles,
    locks: room.locks,
    trees: room.trees,
    drops: room.drops,
    worldOwner: room.worldOwner,
    savedAt: Date.now()
  };
  try {
    fs.writeFileSync(worldFile, JSON.stringify(data), 'utf-8');
    if (firestoreDb) {
      setDoc(doc(firestoreDb, 'worlds', room.name), data).catch(() => {});
    }
    room.dirty = false;
  } catch (err) {
    console.error('Error saving world to disk:', err);
  }
}

// Auto-save active rooms periodically
setInterval(() => {
  for (const room of activeRooms.values()) {
    if (room.dirty) {
      saveRoomToDisk(room);
    }
  }
}, 5000);

// Check if position is protected by a lock
function checkLockPermission(room: WorldRoom, tx: number, ty: number, username: string): { allowed: boolean; lock?: LockRecord } {
  // Spawn door and bedrock cannot be broken or placed over by anyone
  const currentTile = room.tiles[ty]?.[tx];
  if (currentTile === 'spawn_door' || currentTile === 'bedrock') {
    return { allowed: false };
  }

  // If there's a World Lock, check world owner/whitelist first
  const worldLock = room.locks.find(l => l.type === 'world_lock');
  if (worldLock) {
    const isOwner = worldLock.owner.toLowerCase() === username.toLowerCase();
    const isWhitelisted = worldLock.allowedUsers.some(u => u.toLowerCase() === username.toLowerCase());
    if (!isOwner && !isWhitelisted) {
      return { allowed: false, lock: worldLock };
    }
  }

  // Check area locks (Small, Medium, Big)
  for (const lock of room.locks) {
    if (lock.type === 'world_lock') continue;
    if (tx >= lock.bounds.minX && tx <= lock.bounds.maxX && ty >= lock.bounds.minY && ty <= lock.bounds.maxY) {
      const isOwner = lock.owner.toLowerCase() === username.toLowerCase();
      const isWhitelisted = lock.allowedUsers.some(u => u.toLowerCase() === username.toLowerCase());
      if (!isOwner && !isWhitelisted) {
        return { allowed: false, lock };
      }
    }
  }

  return { allowed: true };
}

// HTTP Server setup
const server = http.createServer(app);

// WebSocket Server with manual upgrade routing to avoid Vite HMR collision
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, req: any) => {
  let currentRoom: WorldRoom | null = null;
  let playerId: string = '';
  let username: string = '';

  const reqUrl = new URL(req?.url || '', `http://${req?.headers?.host || 'localhost'}`);
  const queryToken = reqUrl.searchParams.get('token') || reqUrl.searchParams.get('access_token');

  ws.on('message', async (raw: string) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'world:join') {
        const { worldName, token: msgToken } = msg;
        const accessToken = msgToken || queryToken;

        if (!accessToken) {
          ws.send(JSON.stringify({
            type: 'auth:error',
            error: 'Unauthorized: Missing Supabase access token.'
          }));
          ws.close(4001, 'Unauthorized: Missing access token');
          return;
        }

        const identity = await verifyPlayerToken(accessToken);
        if (!identity) {
          ws.send(JSON.stringify({
            type: 'auth:error',
            error: 'Unauthorized: Invalid or expired Supabase access token.'
          }));
          ws.close(4001, 'Unauthorized: Invalid access token');
          return;
        }

        // 1. Load authoritative player data BEFORE allowing world entry
        let playerData: PlayerEconomyState;
        try {
          playerData = await loadPlayerData(playerId);
        } catch (err: any) {
          console.error(`Failed to load authoritative player data for user ${playerId} (${username}):`, err);
          ws.send(JSON.stringify({
            type: 'auth:error',
            error: 'Failed to load player data: ' + (err.message || 'Database error')
          }));
          ws.close(4002, 'Failed to load player data');
          return;
        }

        // 2. Initialize verified session
        username = identity.username;
        playerId = identity.userId;
        currentRoom = getOrCreateRoom(worldName);

        // Player initial spawn at ground level
        const spawnX = 8 * 52;
        const spawnY = 25 * 52 - 78;

        const activePlayer: ActivePlayer = {
          id: playerId,
          username,
          x: spawnX,
          y: spawnY,
          vx: 0,
          vy: 0,
          face: 1,
          pose: 'idle',
          gems: playerData.gems,
          inventory: playerData.inventory,
          ws
        };

        // Notify other players in room
        const joinPayload = JSON.stringify({
          type: 'player:joined',
          player: {
            id: activePlayer.id,
            username: activePlayer.username,
            x: activePlayer.x,
            y: activePlayer.y,
            face: activePlayer.face,
            pose: activePlayer.pose
          }
        });

        for (const p of currentRoom.players.values()) {
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(joinPayload);
          }
        }

        currentRoom.players.set(playerId, activePlayer);

        // Send full world state to joining player
        const otherPlayers = Array.from(currentRoom.players.values())
          .filter(p => p.id !== playerId)
          .map(p => ({
            id: p.id,
            username: p.username,
            x: p.x,
            y: p.y,
            face: p.face,
            pose: p.pose
          }));

        ws.send(JSON.stringify({
          type: 'init:world',
          myId: playerId,
          myUsername: username,
          worldName: currentRoom.name,
          seed: currentRoom.seed,
          tiles: currentRoom.tiles,
          locks: currentRoom.locks,
          trees: currentRoom.trees,
          drops: currentRoom.drops,
          worldOwner: currentRoom.worldOwner,
          players: otherPlayers
        }));

        // Authoritatively sync inventory & gems to player
        ws.send(JSON.stringify({
          type: 'inventory:sync',
          inventory: activePlayer.inventory,
          gems: activePlayer.gems
        }));
        return;
      }

      if (!currentRoom) return;

      if (msg.type === 'player:move') {
        const p = currentRoom.players.get(playerId);
        if (p) {
          p.x = msg.x;
          p.y = msg.y;
          p.vx = msg.vx;
          p.vy = msg.vy;
          p.face = msg.face;
          p.pose = msg.pose;

          // Broadcast movement to all other players in the room
          const moveData = JSON.stringify({
            type: 'player:moved',
            id: playerId,
            x: msg.x,
            y: msg.y,
            vx: msg.vx,
            vy: msg.vy,
            face: msg.face,
            pose: msg.pose
          });

          for (const other of currentRoom.players.values()) {
            if (other.id !== playerId && other.ws.readyState === WebSocket.OPEN) {
              other.ws.send(moveData);
            }
          }
        }
        return;
      }

      if (msg.type === 'player:punch') {
        const punchData = JSON.stringify({
          type: 'player:punched',
          id: playerId,
          angle: msg.angle,
          targetTx: msg.targetTx,
          targetTy: msg.targetTy
        });
        for (const other of currentRoom.players.values()) {
          if (other.id !== playerId && other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(punchData);
          }
        }
        return;
      }

      if (msg.type === 'chat:send') {
        const text = (msg.text || '').trim().slice(0, 100);
        if (!text) return;
        const chatData = JSON.stringify({
          type: 'chat:bubble',
          id: playerId,
          username,
          text,
          timestamp: Date.now()
        });
        for (const p of currentRoom.players.values()) {
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(chatData);
          }
        }
        return;
      }

      if (msg.type === 'block:place') {
        const { tx, ty, blockId } = msg;
        if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;

        // Never allow placing over bedrock or spawn_door
        const destBlock = currentRoom.tiles[ty]?.[tx];
        if (destBlock === 'spawn_door' || destBlock === 'bedrock') return;

        // Check lock permissions
        const perm = checkLockPermission(currentRoom, tx, ty, username);
        if (!perm.allowed) {
          ws.send(JSON.stringify({
            type: 'lock:denied',
            tx,
            ty,
            owner: perm.lock?.owner,
            lockType: perm.lock?.type
          }));
          return;
        }

        const player = currentRoom.players.get(playerId);
        if (!player) return;

        if ((player.inventory[blockId] || 0) <= 0) {
          ws.send(JSON.stringify({ type: 'notify', text: `You do not have any ${blockId} to place!` }));
          return;
        }

        // Handle placing locks
        if (['small_lock', 'medium_lock', 'big_lock', 'world_lock'].includes(blockId)) {
          // 1. If placing world lock, check if world already has one
          if (blockId === 'world_lock') {
            const hasWL = currentRoom.locks.some(l => l.type === 'world_lock');
            if (hasWL) {
              ws.send(JSON.stringify({ type: 'notify', text: 'This world already has a World Lock!' }));
              return;
            }
            currentRoom.worldOwner = username;
          } else {
            // 2. Disallow placing a lock inside an already claimed area
            const insideExisting = currentRoom.locks.some(l =>
              l.type === 'world_lock' ||
              (tx >= l.bounds.minX && tx <= l.bounds.maxX && ty >= l.bounds.minY && ty <= l.bounds.maxY)
            );
            if (insideExisting) {
              ws.send(JSON.stringify({ type: 'notify', text: 'Cannot place a lock inside an existing claimed area!' }));
              return;
            }
          }

          // 3. Calculate initial claim bounds
          let bounds = calculateBounds(blockId, tx, ty);

          // 4. Cut off overlapping portions so adjacent locks meet at the border without overlapping
          if (blockId !== 'world_lock') {
            for (const existing of currentRoom.locks) {
              if (existing.type === 'world_lock') continue;
              bounds = clampBoundsNoOverlap(bounds, existing.bounds, tx, ty);
            }
          }

          const lock: LockRecord = {
            id: 'lock_' + Date.now(),
            type: blockId as any,
            tx,
            ty,
            owner: username,
            allowedUsers: [],
            bounds
          };
          currentRoom.locks.push(lock);
        }

        // Deduct from player inventory in database atomically
        const clientReqId = (msg.requestId || '').trim();
        const idempotencyKey = clientReqId 
          ? `place_${playerId}_${clientReqId}` 
          : `place_${currentRoom.name}_${tx}_${ty}_${Date.now()}`;
        
        const economyPayload = { tx, ty, blockId, worldName: currentRoom.name };
        
        try {
          const updated = await updatePlayerEconomy(playerId, 'block_place', 0, { [blockId]: -1 }, idempotencyKey, economyPayload);
          
          // Publish state ONLY after successful database deduction
          player.gems = updated.gems;
          player.inventory = updated.inventory;
          currentRoom.tiles[ty][tx] = blockId;
          currentRoom.dirty = true;

          // Authoritatively sync inventory to placing player
          ws.send(JSON.stringify({
            type: 'inventory:sync',
            inventory: player.inventory,
            gems: player.gems
          }));

          // Broadcast block placed to everyone
          const placeData = JSON.stringify({
            type: 'block:changed',
            tx,
            ty,
            blockId,
            placedBy: username,
            locks: currentRoom.locks,
            worldOwner: currentRoom.worldOwner
          });
          for (const p of currentRoom.players.values()) {
            if (p.ws.readyState === WebSocket.OPEN) p.ws.send(placeData);
          }
        } catch (err: any) {
          console.error('Failed to deduct placed block from inventory:', err);
          ws.send(JSON.stringify({ type: 'notify', text: 'Cannot place block: ' + (err.message || 'database error') }));
          return;
        }
        return;
      }

      if (msg.type === 'block:mine') {
        const { tx, ty } = msg;
        if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;
        const currentBlock = currentRoom.tiles[ty][tx];
        // spawn_door and bedrock are permanently indestructible
        if (!currentBlock || currentBlock === 'bedrock' || currentBlock === 'spawn_door') return;

        // Check lock permission
        const perm = checkLockPermission(currentRoom, tx, ty, username);
        if (!perm.allowed) {
          ws.send(JSON.stringify({
            type: 'lock:denied',
            tx,
            ty,
            owner: perm.lock?.owner,
            lockType: perm.lock?.type
          }));
          return;
        }

        // If breaking a lock, only the original owner who placed it can break it
        const lockIndex = currentRoom.locks.findIndex(l => l.tx === tx && l.ty === ty);
        if (lockIndex >= 0) {
          const lk = currentRoom.locks[lockIndex];
          if (lk.owner.toLowerCase() !== username.toLowerCase()) {
            ws.send(JSON.stringify({ type: 'notify', text: 'Only the original owner can remove this lock!' }));
            return;
          }
          if (lk.type === 'world_lock') {
            currentRoom.worldOwner = null;
          }

          // Return lock immediately to that player's inventory
          const clientReqId = (msg.requestId || '').trim();
          const reclaimKey = clientReqId 
            ? `reclaim_${playerId}_${clientReqId}` 
            : `reclaim_${lk.id}_${Date.now()}`;
          
          const reclaimPayload = { lockId: lk.id, lockType: lk.type, worldName: currentRoom.name };
          
          try {
            const updated = await updatePlayerEconomy(playerId, 'reclaim_lock', 0, { [lk.type]: 1 }, reclaimKey, reclaimPayload);
            const p = currentRoom.players.get(playerId);
            if (p) {
              p.gems = updated.gems;
              p.inventory = updated.inventory;
            }
            ws.send(JSON.stringify({
              type: 'inventory:sync',
              inventory: updated.inventory,
              gems: updated.gems
            }));
          } catch (err: any) {
            console.error('Failed to reclaim lock to inventory:', err);
          }

          currentRoom.locks.splice(lockIndex, 1);
        }

        // Spawn shared drops for players to collect
        const newDrops: DropRecord[] = [];
        const dropX = tx * 52 + 26;
        const dropY = ty * 52 + 26;

        if (['dirt', 'stone', 'wood', 'leaves', 'sand', 'lava'].includes(currentBlock)) {
          // Block drop
          if (Math.random() < 0.45) {
            newDrops.push({
              id: 'd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
              itemId: currentBlock,
              x: dropX + (Math.random() - 0.5) * 12,
              y: dropY + (Math.random() - 0.5) * 8,
              count: 1,
              age: 0
            });
          }
          // Seed drop
          if (Math.random() < 0.22) {
            newDrops.push({
              id: 'd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
              itemId: currentBlock + 'Seed',
              x: dropX + (Math.random() - 0.5) * 14,
              y: dropY - 4,
              count: 1,
              age: 0
            });
          }
        } else if (currentBlock === 'seedPot') {
          newDrops.push({
            id: 'd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            itemId: 'seedPot',
            x: dropX,
            y: dropY,
            count: 1,
            age: 0
          });
        }

        // Gem drops (0 to 3 gems)
        const gemCount = Math.floor(Math.random() * 4);
        const denominations = [100, 50, 10, 5, 1];
        for (let i = 0; i < gemCount; i++) {
          const roll = Math.random();
          const val = roll < 0.02 ? 100 : roll < 0.08 ? 50 : roll < 0.25 ? 10 : roll < 0.55 ? 5 : 1;
          newDrops.push({
            id: 'd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            itemId: 'gem',
            value: val,
            x: dropX + (Math.random() - 0.5) * 16,
            y: dropY - 8 + (Math.random() - 0.5) * 10,
            count: 1,
            age: 0
          });
        }

        if (newDrops.length > 0) {
          currentRoom.drops.push(...newDrops);
          // Keep max 150 drops to prevent memory bloat
          if (currentRoom.drops.length > 150) {
            currentRoom.drops = currentRoom.drops.slice(currentRoom.drops.length - 150);
          }
        }

        currentRoom.tiles[ty][tx] = null;
        currentRoom.dirty = true;

        // Broadcast removal and newly spawned drops
        const breakData = JSON.stringify({
          type: 'block:changed',
          tx,
          ty,
          blockId: null,
          minedBy: username,
          locks: currentRoom.locks,
          worldOwner: currentRoom.worldOwner,
          newDrops
        });
        for (const p of currentRoom.players.values()) {
          if (p.ws.readyState === WebSocket.OPEN) p.ws.send(breakData);
        }
        return;
      }

      if (msg.type === 'drop:pickup') {
        const { dropId } = msg;

        // 1. Locate requested drop in current world
        const dropIdx = currentRoom.drops.findIndex(d => d.id === dropId);
        if (dropIdx === -1) return; // Reject if drop does not exist or already claimed

        const drop = currentRoom.drops[dropIdx];

        // 2. Verify pickup distance (50 pixels)
        const player = currentRoom.players.get(playerId);
        if (!player) return;
        const dist = Math.hypot(player.x - drop.x, player.y - drop.y);
        if (dist > 50) return; // Reject if outside distance

        // 3. Atomically claim drop from world to prevent duplicate collection
        currentRoom.drops.splice(dropIdx, 1);

        // 4. Derive reward deltas exclusively from server-side drop record
        const gemsDelta = drop.itemId === 'gem' ? (drop.value || 1) : 0;
        const inventoryDelta = drop.itemId !== 'gem' ? { [drop.itemId]: drop.count || 1 } : {};
        // 5. Persist reward atomically to authoritative Supabase database
        const clientReqId = (msg.requestId || '').trim();
        const idempotencyKey = clientReqId 
          ? `pickup_${playerId}_${clientReqId}` 
          : `drop_${currentRoom.name}_${drop.id}`;
        
        const pickupPayload = { dropId: drop.id, itemId: drop.itemId, count: drop.count || 1, value: drop.value };

        try {
          const updated = await updatePlayerEconomy(playerId, 'collect_drop', gemsDelta, inventoryDelta, idempotencyKey, pickupPayload);

          // Update in-memory player state from authoritative DB response
          player.gems = updated.gems;
          player.inventory = updated.inventory;
          currentRoom.dirty = true;

          // Notify collector with synchronized inventory & gems
          ws.send(JSON.stringify({
            type: 'inventory:sync',
            inventory: player.inventory,
            gems: player.gems
          }));

          // Broadcast drop removal to all players in the room ONLY AFTER DB commit
          const removeData = JSON.stringify({
            type: 'drop:removed',
            dropId: drop.id
          });
          for (const p of currentRoom.players.values()) {
            if (p.ws.readyState === WebSocket.OPEN) p.ws.send(removeData);
          }
        } catch (err: any) {
          console.error(`Drop collection failed for user ${playerId} on drop ${drop.id}:`, err);
          // Preserve the drop in the world if transaction fails!
          if (!currentRoom.drops.some(d => d.id === drop.id)) {
            currentRoom.drops.push(drop);
          }
          ws.send(JSON.stringify({
            type: 'notify',
            text: 'Failed to collect item. Database transaction rolled back.'
          }));
        }
        return;
      }

      if (msg.type === 'lock:manage') {
        const { lockId, action, targetUser } = msg;
        const lock = currentRoom.locks.find(l => l.id === lockId);
        if (!lock || lock.owner.toLowerCase() !== username.toLowerCase()) {
          ws.send(JSON.stringify({ type: 'notify', text: 'Unauthorized lock management' }));
          return;
        }

        if (action === 'add_user' && targetUser) {
          const cleanTarget = targetUser.trim();
          if (!lock.allowedUsers.includes(cleanTarget)) {
            lock.allowedUsers.push(cleanTarget);
            currentRoom.dirty = true;
          }
        } else if (action === 'remove_user' && targetUser) {
          lock.allowedUsers = lock.allowedUsers.filter(u => u.toLowerCase() !== targetUser.toLowerCase());
          currentRoom.dirty = true;
        }

        const updateData = JSON.stringify({
          type: 'lock:updated',
          locks: currentRoom.locks,
          worldOwner: currentRoom.worldOwner
        });
        for (const p of currentRoom.players.values()) {
          if (p.ws.readyState === WebSocket.OPEN) p.ws.send(updateData);
        }
        return;
      }


    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom && playerId) {
      currentRoom.players.delete(playerId);
      const leaveData = JSON.stringify({
        type: 'player:left',
        id: playerId
      });
      for (const p of currentRoom.players.values()) {
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(leaveData);
        }
      }
      if (currentRoom.players.size === 0 && currentRoom.dirty) {
        saveRoomToDisk(currentRoom);
      }
    }
  });
});

// Setup Vite in Dev or serve dist in Prod
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true }
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, () => {
    console.log(`GrowPixel MMO Server running on http://localhost:${PORT}`);
  });
}

startServer();
