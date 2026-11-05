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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Persistent data directory & Firebase
const DATA_DIR = path.join(__dirname, 'data');
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

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

// --- Authoritative Account Storage ---
interface Account {
  id: string;
  username: string;
  passHash: string;
  recoveryHash?: string;
  recoveryRedeemedAt?: number | null;
  gems: number;
  inventory: Record<string, number>;
  createdAt: number;
  lastLogin: number;
}

function loadAccounts(): Record<string, Account> {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error loading accounts:', err);
  }
  return {};
}

function saveAccounts(accounts: Record<string, Account>) {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
    if (firestoreDb) {
      for (const [key, acc] of Object.entries(accounts)) {
        setDoc(doc(firestoreDb, 'users', key), acc).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Error saving accounts:', err);
  }
}

// In-memory accounts cache
const accountsCache: Record<string, Account> = loadAccounts();

// Default starting inventory for new players
function getStarterInventory(): Record<string, number> {
  return {};
}

// Cryptographically secure password hashing (SHA-256)
function hashPasswordSecure(pass: string): string {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// Legacy hash support for existing account migration
function hashPasswordLegacy(pass: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pass.length; i++) {
    h ^= pass.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Derive internal identifier via HMAC-SHA256 with strictly required AUTH_HMAC_SECRET
function deriveHmacIdentifier(username: string): string {
  const secret = process.env.AUTH_HMAC_SECRET;
  if (!secret) {
    throw new Error('Server configuration error: AUTH_HMAC_SECRET is missing.');
  }
  return crypto.createHmac('sha256', secret).update(username.toLowerCase().trim()).digest('hex');
}

// Generate mock JWT token for session compatibility
function createSessionTokens(userId: string, email: string) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.AUTH_HMAC_SECRET || 'secret').update(payload).digest('base64url');
  const accessToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.${signature}`;
  const refreshToken = crypto.randomBytes(24).toString('hex');
  return { accessToken, refreshToken };
}

// Unified Register Handler
const handleRegisterPlayer = (req: Request, res: Response) => {
  try {
    if (!process.env.AUTH_HMAC_SECRET) {
      return res.status(500).json({ error: 'Server configuration error: AUTH_HMAC_SECRET is missing.' });
    }

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

    // Case-insensitive uniqueness check
    const lower = clean.toLowerCase();
    const existing = Object.values(accountsCache).find(
      (a) => a.username.toLowerCase() === lower
    );
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const internalId = deriveHmacIdentifier(clean);
    const userId = 'u_' + internalId.substring(0, 16);
    const internalEmail = `user_${internalId}@growpixel.internal`;

    // Generate cryptographically secure one-time recovery code
    const rawRecoveryCode = crypto.randomBytes(16).toString('hex');
    const recoveryHash = crypto.createHash('sha256').update(rawRecoveryCode).digest('hex');

    const newAccount: Account = {
      id: userId,
      username: clean,
      passHash: hashPasswordSecure(password),
      recoveryHash,
      recoveryRedeemedAt: null,
      gems: 0,
      inventory: getStarterInventory(),
      createdAt: Date.now(),
      lastLogin: Date.now()
    };

    accountsCache[lower] = newAccount;
    saveAccounts(accountsCache);

    const { accessToken, refreshToken } = createSessionTokens(userId, internalEmail);

    return res.status(200).json({
      success: true,
      user: {
        id: newAccount.id,
        username: newAccount.username,
        gems: newAccount.gems,
        inventory: newAccount.inventory
      },
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: 3600,
        user: {
          id: userId,
          email: internalEmail
        }
      },
      recoveryCode: rawRecoveryCode
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Registration failed.' });
  }
};

// Unified Login Handler
const handleLoginPlayer = (req: Request, res: Response) => {
  try {
    if (!process.env.AUTH_HMAC_SECRET) {
      return res.status(500).json({ error: 'Server configuration error: AUTH_HMAC_SECRET is missing.' });
    }

    const { username, password } = req.body;
    const clean = (username || '').trim().toLowerCase();
    const acc = accountsCache[clean];

    // Generic error to prevent username enumeration
    if (!acc) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const secureHash = hashPasswordSecure(password);
    const legacyHash = hashPasswordLegacy(password);

    if (acc.passHash !== secureHash && acc.passHash !== legacyHash) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Seamlessly upgrade legacy password hash to secure hash upon successful login
    if (acc.passHash === legacyHash) {
      acc.passHash = secureHash;
    }

    acc.lastLogin = Date.now();
    saveAccounts(accountsCache);

    const internalId = deriveHmacIdentifier(acc.username);
    const internalEmail = `user_${internalId}@growpixel.internal`;
    const { accessToken, refreshToken } = createSessionTokens(acc.id || 'u_' + internalId.substring(0, 16), internalEmail);

    return res.status(200).json({
      success: true,
      user: {
        id: acc.id,
        username: acc.username,
        gems: acc.gems,
        inventory: acc.inventory
      },
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: 3600,
        user: {
          id: acc.id,
          email: internalEmail
        }
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Login failed.' });
  }
};

// Unified Recovery Handler
const handleRecoverPlayer = (req: Request, res: Response) => {
  try {
    const { recoveryCode, newPassword } = req.body;
    if (!recoveryCode || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Invalid recovery code or password (minimum 8 characters required).' });
    }

    const codeHash = crypto.createHash('sha256').update(recoveryCode.trim()).digest('hex');

    // Find account with unredeemed matching recovery code hash
    const acc = Object.values(accountsCache).find(
      (a) => a.recoveryHash === codeHash && !a.recoveryRedeemedAt
    );

    if (!acc) {
      return res.status(400).json({ error: 'Invalid or already redeemed recovery code.' });
    }

    // Invalidate recovery code atomically upon redemption
    acc.recoveryRedeemedAt = Date.now();
    acc.passHash = hashPasswordSecure(newPassword);
    saveAccounts(accountsCache);

    return res.status(200).json({
      success: true,
      message: 'Password successfully reset using recovery code.'
    });
  } catch (err: any) {
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

app.post('/api/store/buy', (req: Request, res: Response) => {
  const { username, itemId, cost, count } = req.body;
  const clean = (username || '').trim().toLowerCase();
  const acc = accountsCache[clean];
  if (!acc) return res.status(404).json({ error: 'User not found' });
  const price = Math.max(0, Number(cost) || 0);
  const qty = Math.max(1, Number(count) || 1);
  if (acc.gems < price) {
    return res.status(400).json({ error: 'Not enough gems!' });
  }

  acc.gems -= price;
  acc.inventory[itemId] = (acc.inventory[itemId] || 0) + qty;
  saveAccounts(accountsCache);

  res.json({
    success: true,
    gems: acc.gems,
    inventory: acc.inventory
  });
});

app.post('/api/account/add-gems', (req: Request, res: Response) => {
  const { username, gems } = req.body;
  const clean = (username || '').trim().toLowerCase();
  const acc = accountsCache[clean];
  if (!acc) return res.status(404).json({ error: 'User not found' });
  const delta = Math.max(0, Math.min(100, Number(gems) || 0));
  acc.gems += delta;
  saveAccounts(accountsCache);
  res.json({ success: true, gems: acc.gems });
});

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

wss.on('connection', (ws: WebSocket) => {
  let currentRoom: WorldRoom | null = null;
  let playerId: string = '';
  let username: string = '';

  ws.on('message', (raw: string) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'world:join') {
        const { worldName, user } = msg;
        username = (user || 'Guest_' + Math.floor(Math.random() * 9000 + 1000)).trim();
        playerId = 'p_' + Math.random().toString(36).substring(2, 9);
        currentRoom = getOrCreateRoom(worldName);

        // Player initial spawn at ground level in front of the spawn door
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

        // Deduct from player inventory
        const acc = accountsCache[username.toLowerCase()];
        if (acc) {
          if ((acc.inventory[blockId] || 0) <= 0) return;
          acc.inventory[blockId]--;
          saveAccounts(accountsCache);
        }

        currentRoom.tiles[ty][tx] = blockId;
        currentRoom.dirty = true;

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
          const acc = accountsCache[username.toLowerCase()];
          if (acc) {
            acc.inventory[lk.type] = (acc.inventory[lk.type] || 0) + 1;
            saveAccounts(accountsCache);
            ws.send(JSON.stringify({
              type: 'inventory:sync',
              inventory: acc.inventory
            }));
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
        const { dropId, itemId, count, value } = msg;
        const acc = accountsCache[username.toLowerCase()];
        if (acc) {
          if (itemId === 'gem') {
            const g = Math.max(1, Number(value) || 1);
            acc.gems += g;
          } else if (itemId) {
            const q = Math.max(1, Number(count) || 1);
            acc.inventory[itemId] = (acc.inventory[itemId] || 0) + q;
          }
          saveAccounts(accountsCache);
          ws.send(JSON.stringify({
            type: 'inventory:sync',
            inventory: acc.inventory,
            gems: acc.gems
          }));
        }

        if (dropId) {
          const idx = currentRoom.drops.findIndex(d => d.id === dropId);
          if (idx >= 0) {
            currentRoom.drops.splice(idx, 1);
            currentRoom.dirty = true;
          }
          const removeData = JSON.stringify({
            type: 'drop:removed',
            dropId
          });
          for (const p of currentRoom.players.values()) {
            if (p.ws.readyState === WebSocket.OPEN) p.ws.send(removeData);
          }
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
