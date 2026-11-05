/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { db } from './firebase';
import { doc, getDocFromServer } from 'firebase/firestore';
import { registerPlayer, loginPlayer, logoutPlayer, recoverAccount } from './services/authService';
import { supabase } from './supabase';

// Types
interface LockRecord {
  id: string;
  type: 'small_lock' | 'medium_lock' | 'big_lock' | 'world_lock';
  tx: number;
  ty: number;
  owner: string;
  allowedUsers: string[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface RemotePlayer {
  id: string;
  username: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  pose: string;
  punchTime?: number;
  punchAngle?: number;
}

interface ChatBubble {
  id: string;
  username: string;
  text: string;
  timestamp: number;
}

interface UserProfile {
  id?: string;
  username: string;
  gems: number;
  inventory: Record<string, number>;
  session?: any;
}


// Block & Item Definitions
interface BlockDef {
  name: string;
  color: string;
  side: string;
  hard: number;
  solid: boolean;
  seedFor?: string;
  placeable?: boolean;
  isLock?: boolean;
  lockRadius?: number;
}

const defs: Record<string, BlockDef> = {
  dirt: { name: 'Dirt', color: '#9c653e', side: '#75472f', hard: 0.42, solid: true },
  stone: { name: 'Stone', color: '#89969c', side: '#626e78', hard: 0.8, solid: true },
  wood: { name: 'Wood', color: '#b87943', side: '#7b4a2b', hard: 0.52, solid: false },
  leaves: { name: 'Leaves', color: '#419b55', side: '#287744', hard: 0.2, solid: true },
  sand: { name: 'Sand', color: '#e2c574', side: '#bca45e', hard: 0.35, solid: true },
  dirtSeed: { name: 'Dirt Seed', color: '#8ecb63', side: '#4c873d', hard: 0.1, solid: false, seedFor: 'dirt' },
  stoneSeed: { name: 'Stone Seed', color: '#a6c8b4', side: '#668b78', hard: 0.1, solid: false, seedFor: 'stone' },
  woodSeed: { name: 'Wood Seed', color: '#e4b16b', side: '#93602e', hard: 0.1, solid: false, seedFor: 'wood' },
  leavesSeed: { name: 'Leaves Seed', color: '#76d66b', side: '#32854a', hard: 0.1, solid: false, seedFor: 'leaves' },
  sandSeed: { name: 'Sand Seed', color: '#f4df8d', side: '#bba05a', hard: 0.1, solid: false, seedFor: 'sand' },
  lavaSeed: { name: 'Lava Seed', color: '#ff9a50', side: '#b83b24', hard: 0.1, solid: false, seedFor: 'lava' },
  seedPot: { name: 'Seed Pot', color: '#8d7150', side: '#5e4935', hard: 0.12, solid: false, placeable: true },
  lava: { name: 'Lava', color: '#f15a24', side: '#9f281c', hard: 0.58, solid: true },
  bedrock: { name: 'Bedrock', color: '#3e4a57', side: '#27323d', hard: 9999, solid: true },
  // Dedicated system-generated spawn entrance door block (indestructible background fixture)
  spawn_door: { name: 'World Entrance Door', color: '#6d4c31', side: '#4a3321', hard: 9999, solid: false },
  // 4 Lock Variety Blocks
  small_lock: { name: 'Small Lock', color: '#ea7171', side: '#9c3e3e', hard: 1.0, solid: false, placeable: true, isLock: true, lockRadius: 1 },
  medium_lock: { name: 'Medium Lock', color: '#ea7171', side: '#9c3e3e', hard: 1.5, solid: false, placeable: true, isLock: true, lockRadius: 3 },
  big_lock: { name: 'Big Lock', color: '#ea7171', side: '#9c3e3e', hard: 2.0, solid: false, placeable: true, isLock: true, lockRadius: 5 },
  world_lock: { name: 'World Lock', color: '#ffd700', side: '#c49a00', hard: 3.0, solid: false, placeable: true, isLock: true, lockRadius: 999 },
};

const TILE = 52;
const WORLD_W = 180;
const WORLD_H = 65;

// Cache for exact item icon data URLs
const itemIconCache: Record<string, string> = {};

export default function App() {
  // Navigation & High-level State
  const [screen, setScreen] = useState<'TITLE' | 'AUTH' | 'HUB' | 'GAME'>('TITLE');
  const [authMode, setAuthMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [registeredRecoveryCode, setRegisteredRecoveryCode] = useState<string | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryInputCode, setRecoveryInputCode] = useState('');
  const [recoveryNewPassword, setRecoveryNewPassword] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoverySuccess, setRecoverySuccess] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('growpixel_mmo_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Mutable refs for inventory and gems to prevent re-mounting the canvas/WS on block placement
  const currentUserRef = useRef<UserProfile | null>(currentUser);
  currentUserRef.current = currentUser;
  const userInventoryRef = useRef<Record<string, number>>(currentUser?.inventory || {});
  userInventoryRef.current = currentUser?.inventory || {};
  const userGemsRef = useRef<number>(currentUser?.gems ?? 0);
  userGemsRef.current = currentUser?.gems ?? 0;

  // World HUB State
  const [worldSearch, setWorldSearch] = useState('START');
  const [worldStatus, setWorldStatus] = useState<{
    name: string;
    exists: boolean;
    playersCount: number;
    worldOwner: string | null;
  } | null>(null);
  const [featuredWorlds, setFeaturedWorlds] = useState<Array<{ name: string; players: number; owner: string | null }>>([]);
  const [targetWorld, setTargetWorld] = useState('START');

  // In-Game UI Modals & State
  const [inGameWorldName, setInGameWorldName] = useState('');
  const [inGameWorldOwner, setInGameWorldOwner] = useState<string | null>(null);
  const [onlineCount, setOnlineCount] = useState(1);
  const [showPlayersList, setShowPlayersList] = useState(false);
  const [playersInRoom, setPlayersInRoom] = useState<RemotePlayer[]>([]);
  const [isGemStoreOpen, setIsGemStoreOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isInventoryOpen, setIsInventoryOpen] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeLock, setActiveLock] = useState<LockRecord | null>(null);
  const [inspectPlayer, setInspectPlayer] = useState<{ username: string; isOwner: boolean } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [lockNewUser, setLockNewUser] = useState('');

  // Fixed 3-Slot Recent-Item Toolbar State & Active Selected Item
  const [recentSlots, setRecentSlots] = useState<Array<string | null>>([null, null, null]);
  const recentSlotsRef = useRef<Array<string | null>>(recentSlots);
  recentSlotsRef.current = recentSlots;

  const [selectedItem, setSelectedItem] = useState('fist');
  const selectedItemRef = useRef('fist');
  selectedItemRef.current = selectedItem;

  // Refs for Game Engine Lifecycle & Input
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mobileInputRef = useRef({ left: false, right: false, jump: false });

  // Check saved login
  useEffect(() => {
    if (currentUser) {
      localStorage.setItem('growpixel_mmo_user', JSON.stringify(currentUser));
    } else {
      localStorage.removeItem('growpixel_mmo_user');
    }
  }, [currentUser]);

  // Synchronize Fullscreen state
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Verify Live Firebase Database active connection on client start
  useEffect(() => {
    async function verifyLiveFirebase() {
      try {
        await getDocFromServer(doc(db, 'system', 'connection_test'));
        console.log('Live Firebase Firestore active connection verified successfully on client start.');
      } catch (err) {
        console.warn('Firebase active connection check:', err);
      }
    }
    verifyLiveFirebase();
  }, []);

  // Helper: push item into the fixed 3-slot recent toolbar
  const addToRecentSlots = (itemId: string) => {
    setRecentSlots((prev) => {
      if (prev.includes(itemId)) return prev;
      const next = [...prev];
      const emptyIdx = next.indexOf(null);
      if (emptyIdx !== -1) {
        next[emptyIdx] = itemId;
      } else {
        next.shift();
        next.push(itemId);
      }
      return next;
    });
  };

  // Helper: automatic empty slot restoration when items are depleted
  const checkEmptySlotRestoration = (inv: Record<string, number>) => {
    setRecentSlots((prev) => {
      let changed = false;
      const next = prev.map((slot) => {
        if (slot && (inv[slot] ?? 0) <= 0) {
          changed = true;
          return null;
        }
        return slot;
      });
      return changed ? next : prev;
    });

    if (selectedItemRef.current !== 'fist' && (inv[selectedItemRef.current] ?? 0) <= 0) {
      setSelectedItem('fist');
    }
  };

  // Load featured worlds when on HUB
  useEffect(() => {
    if (screen === 'HUB') {
      fetch('/api/worlds')
        .then((res) => res.json())
        .then((data) => {
          if (data && data.worlds) setFeaturedWorlds(data.worlds);
        })
        .catch(() => {});
    }
  }, [screen]);

  // Check world search status debounce
  useEffect(() => {
    if (screen !== 'HUB') return;
    const clean = worldSearch.trim().toUpperCase().slice(0, 24);
    if (!clean) {
      setWorldStatus(null);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/world/${encodeURIComponent(clean)}`)
        .then((res) => res.json())
        .then((data) => {
          setWorldStatus(data);
        })
        .catch(() => {});
    }, 280);
    return () => clearTimeout(timer);
  }, [worldSearch, screen]);

  // Auth Submit Handlers (Supabase Edge Functions)
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');

    const cleanUser = authUsername.trim();
    if (!cleanUser || cleanUser.length < 3 || cleanUser.length > 16 || !/^[a-zA-Z0-9_-]+$/.test(cleanUser)) {
      setAuthError('Username must be 3-16 alphanumeric characters, hyphens, or underscores.');
      return;
    }
    if (!authPassword || authPassword.length < 8) {
      setAuthError('Password must be at least 8 characters long.');
      return;
    }

    try {
      if (authMode === 'REGISTER') {
        if (authPassword !== authConfirmPassword) {
          setAuthError('Passwords do not match.');
          return;
        }
        const res = await registerPlayer(cleanUser, authPassword, authConfirmPassword);
        setCurrentUser({
          id: res.user.id,
          username: res.user.username,
          gems: res.user.gems,
          inventory: res.user.inventory || {},
          session: res.session,
        });
        setRecentSlots([null, null, null]);
        setSelectedItem('fist');
        if (res.recoveryCode) {
          setRegisteredRecoveryCode(res.recoveryCode);
          setCopiedRecovery(false);
        }
        setAuthSuccess('Welcome to GrowPixel, ' + res.user.username + '! Account created successfully.');
        setTimeout(() => {
          setScreen('HUB');
        }, 1200);
      } else {
        const res = await loginPlayer(cleanUser, authPassword);
        setCurrentUser({
          id: res.user.id,
          username: res.user.username,
          gems: res.user.gems,
          inventory: res.user.inventory || {},
          session: res.session,
        });
        setRecentSlots([null, null, null]);
        setSelectedItem('fist');
        setAuthSuccess('Welcome back, ' + res.user.username + '!');
        setTimeout(() => {
          setScreen('HUB');
        }, 400);
      }
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed. Please check your credentials.');
    }
  };

  const handleLogout = async () => {
    await logoutPlayer();
    setCurrentUser(null);
    setScreen('TITLE');
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError('');
    setRecoverySuccess('');
    try {
      const res = await recoverAccount(recoveryInputCode, recoveryNewPassword);
      setRecoverySuccess(res.message);
      setRecoveryInputCode('');
      setRecoveryNewPassword('');
      setTimeout(() => {
        setShowRecoveryModal(false);
        setAuthMode('LOGIN');
      }, 1500);
    } catch (err: any) {
      setRecoveryError(err.message || 'Recovery failed.');
    }
  };

  const handleJoinWorld = (worldName: string) => {
    const clean = worldName.trim().toUpperCase().slice(0, 24) || 'START';
    setTargetWorld(clean);
    setScreen('GAME');
  };

  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleBuyItem = async (itemId: string, cost: number) => {
    if (!currentUser) return;
    try {
      const token = currentUser.session?.access_token || '';
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const res = await fetch('/api/store/buy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          username: currentUser.username,
          itemId,
          cost,
          count: 1,
          requestId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Purchase failed');
        return;
      }
      setCurrentUser((prev) =>
        prev
          ? {
              ...prev,
              gems: data.gems,
              inventory: data.inventory,
            }
          : null
      );
      addToRecentSlots(itemId);
      setSelectedItem(itemId);
      setIsGemStoreOpen(false);
    } catch (err) {
      console.error('Store error:', err);
    }
  };

  // Exact Item Texture Generator & Cache
  const getItemTextureUrl = (id: string, size = 32): string => {
    const key = `${id}:${size}`;
    if (itemIconCache[key]) return itemIconCache[key];

    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;

    // Sizing factor
    const q = (n: number) => Math.max(1, Math.round((n * size) / 52));

    if (defs[id]?.seedFor) {
      // Seed icon
      const base = defs[defs[id].seedFor!] || defs.dirt;
      const u = size / 32;
      g.save();
      g.translate(size / 2, size / 2);
      g.scale(u, u);
      g.fillStyle = '#142118';
      g.fillRect(-7, -4, 5, 10);
      g.fillRect(-4, -7, 9, 14);
      g.fillRect(1, -5, 6, 10);
      g.fillRect(-2, -9, 5, 4);
      g.fillStyle = base.side;
      g.fillRect(-5, -5, 7, 11);
      g.fillRect(-2, -7, 8, 12);
      g.fillRect(1, -4, 4, 7);
      g.fillStyle = base.color;
      g.fillRect(-4, -5, 6, 9);
      g.fillRect(-1, -7, 6, 10);
      g.fillRect(2, -3, 2, 5);
      g.fillStyle = '#fff2b8';
      g.fillRect(-2, -5, 3, 2);
      g.fillRect(-1, -7, 2, 2);
      g.fillStyle = '#8ee66a';
      g.fillRect(-1, -11, 2, 4);
      g.fillRect(1, -12, 4, 2);
      g.fillStyle = '#c7ff94';
      g.fillRect(2, -12, 2, 1);
      g.restore();
    } else if (id === 'seedPot') {
      // Seed pot planter
      g.fillStyle = '#4a3524';
      g.fillRect(q(9), q(36), q(5), q(12));
      g.fillRect(size - q(14), q(36), q(5), q(12));
      g.fillStyle = '#3b2c20';
      g.fillRect(q(5), q(26), size - q(10), q(14));
      g.fillStyle = '#6c4b31';
      g.fillRect(q(3), q(22), size - q(6), q(8));
      g.fillStyle = '#c08a4c';
      g.fillRect(q(2), q(18), size - q(4), q(5));
      g.fillStyle = '#e4b66c';
      g.fillRect(q(4), q(18), size - q(8), q(2));
      g.fillStyle = '#263c2d';
      g.fillRect(q(8), q(24), size - q(16), q(4));
    } else if (['small_lock', 'medium_lock', 'big_lock', 'world_lock'].includes(id)) {
      // Lock icon
      const isWorld = id === 'world_lock';
      const bodyColor = isWorld ? '#ffd700' : '#ea7171';
      const borderColor = isWorld ? '#967a14' : '#942b3e';
      g.strokeStyle = borderColor;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(size / 2, size * 0.35, size * 0.22, Math.PI, 0, false);
      g.lineTo(size * 0.72, size * 0.48);
      g.moveTo(size * 0.28, size * 0.35);
      g.lineTo(size * 0.28, size * 0.48);
      g.stroke();

      g.fillStyle = bodyColor;
      g.strokeStyle = borderColor;
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(size * 0.2, size * 0.45, size * 0.6, size * 0.45, 3);
      g.fill();
      g.stroke();

      g.fillStyle = '#1c1518';
      g.beginPath();
      g.arc(size / 2, size * 0.62, 3, 0, Math.PI * 2);
      g.fill();
      g.fillRect(size / 2 - 1.5, size * 0.62, 3, 5);
    } else {
      // Terrain block
      const def = defs[id] || defs.dirt;
      g.fillStyle = def.color;
      g.fillRect(0, 0, size, size);

      if (id === 'dirt') {
        g.fillStyle = '#75482f';
        g.fillRect(q(4), q(8), q(12), q(6));
        g.fillRect(q(20), q(24), q(14), q(8));
        g.fillStyle = '#c18a53';
        g.fillRect(q(18), q(6), q(10), q(5));
        g.fillRect(q(6), q(28), q(8), q(6));
        // Grass top
        g.fillStyle = '#56b447';
        g.fillRect(0, 0, size, q(8));
        g.fillStyle = '#8ee95b';
        g.fillRect(q(4), 0, q(14), q(3));
      } else if (id === 'stone') {
        g.fillStyle = '#6b7a83';
        g.fillRect(q(6), q(6), q(14), q(8));
        g.fillRect(q(24), q(22), q(16), q(10));
        g.fillStyle = '#c3cdd0';
        g.fillRect(q(16), q(8), q(8), q(4));
        g.fillRect(q(8), q(24), q(10), q(5));
      } else if (id === 'wood') {
        g.fillStyle = '#e2b474';
        g.fillRect(q(6), 0, q(5), size);
        g.fillRect(q(24), 0, q(4), size);
        g.fillStyle = '#89512f';
        g.fillRect(q(14), 0, q(4), size);
      } else if (id === 'leaves') {
        g.fillStyle = '#2d7c3e';
        g.fillRect(q(4), q(4), q(14), q(10));
        g.fillRect(q(20), q(18), q(18), q(12));
        g.fillStyle = '#75ca56';
        g.fillRect(q(8), q(8), q(8), q(6));
        g.fillRect(q(24), q(22), q(10), q(7));
      } else if (id === 'sand') {
        g.fillStyle = '#ead184';
        g.fillRect(q(4), q(10), q(18), q(4));
        g.fillRect(q(14), q(26), q(20), q(4));
        g.fillStyle = '#bca45e';
        g.fillRect(q(8), q(18), q(14), q(4));
      } else if (id === 'lava') {
        g.fillStyle = '#c8321c';
        g.fillRect(0, q(20), size, size - q(20));
        g.fillStyle = '#ff7824';
        g.fillRect(q(4), q(6), q(18), q(10));
        g.fillStyle = '#ffe16a';
        g.fillRect(q(8), q(8), q(10), q(4));
      }

      g.fillStyle = '#ffffff18';
      g.fillRect(0, 0, size, 2);
      g.fillStyle = '#00000025';
      g.fillRect(0, size - 2, size, 2);
    }

    const dataUrl = c.toDataURL('image/png');
    itemIconCache[key] = dataUrl;
    return dataUrl;
  };

  // --- MAIN GAME LIFECYCLE (DECOUPLED FROM CURRENTUSER) ---
  useEffect(() => {
    if (screen !== 'GAME') return;

    let cleanup: (() => void) | null = null;

    try {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      if (!canvas) return;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;

      const myUsername = currentUserRef.current?.username || 'Guest_' + Math.floor(Math.random() * 8999 + 1000);
      let myPlayerId = '';

      // World state
      let world: (string | null)[][] = Array.from({ length: WORLD_H }, () => Array(WORLD_W).fill(null));
      let currentLocks: LockRecord[] = [];
      let currentWorldOwner: string | null = null;
      let drops: Array<{ id: string; itemId: string; x: number; y: number; age: number; count?: number; value?: number }> = [];
      let plantedTrees: Array<{ x: number; y: number; id: string; age: number; mature: boolean }> = [];
      let remotePlayers = new Map<string, RemotePlayer>();
      let chatBubbles: ChatBubble[] = [];
      let particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; color: string }> = [];

      // Local player: spawned precisely at ground level in front of the spawn entrance door
      const player = {
        x: 8 * TILE,
        y: 25 * TILE - 78,
        vx: 0,
        vy: 0,
        w: 44,
        h: 78,
        ground: true,
        face: 1,
        pose: 'idle',
      };

      let camera = { x: player.x, y: player.y };
      const keys: Record<string, boolean> = {};
      const mouse = { x: 0, y: 0, down: false, justDown: false };
      let mining: { tx: number; ty: number; id: string; progress: number } | null = null;
      let animTime = 0, walkPhase = 0, punchTime = 0, punchCooldown = 0;
      let punchDir = { x: 1, y: 0 };
      let coyoteTimer = 0, jumpBuffer = 0;
      let toastMessage = '', toastTimer = 0;

      // Audio synthesizer
      let audioCtx: AudioContext | null = null;
      function playTone(freq: number, dur = 0.08, type: OscillatorType = 'triangle', vol = 0.15) {
        try {
          if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          if (audioCtx.state === 'suspended') audioCtx.resume();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
          gain.gain.setValueAtTime(vol, audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + dur);
        } catch {}
      }

      function showToast(msg: string) {
        toastMessage = msg;
        toastTimer = 2.8;
      }

      // --- SPRITE SHEET LOADER & SLICER FOR 4 LOCK VARIETIES ---
      const lockSprites: Record<string, { locked: HTMLCanvasElement; access: HTMLCanvasElement }> = {};

      function createFallbackLockTexture(type: string, hasAccess: boolean): HTMLCanvasElement {
        const c = document.createElement('canvas');
        c.width = 48;
        c.height = 48;
        const ctx2 = c.getContext('2d')!;
        ctx2.imageSmoothingEnabled = false;

        const isWorld = type === 'world_lock';
        const bodyColor = isWorld ? '#f5ce42' : hasAccess ? '#76c45e' : '#f0738a';
        const borderColor = isWorld ? '#967a14' : hasAccess ? '#387326' : '#942b3e';
        const keyholeColor = hasAccess ? '#2a5e1c' : '#771829';

        ctx2.strokeStyle = isWorld ? (hasAccess ? '#a6e858' : '#e6657c') : borderColor;
        ctx2.lineWidth = 4;
        ctx2.lineCap = 'round';
        ctx2.beginPath();
        if (hasAccess) {
          ctx2.arc(18, 14, 8, Math.PI, 0, false);
          ctx2.lineTo(26, 18);
        } else {
          ctx2.arc(24, 15, 9, Math.PI, 0, false);
          ctx2.lineTo(33, 23);
          ctx2.moveTo(15, 15);
          ctx2.lineTo(15, 23);
        }
        ctx2.stroke();

        ctx2.fillStyle = bodyColor;
        ctx2.strokeStyle = borderColor;
        ctx2.lineWidth = 2;
        ctx2.beginPath();
        ctx2.roundRect(10, 20, 28, 22, 4);
        ctx2.fill();
        ctx2.stroke();

        ctx2.fillStyle = keyholeColor;
        ctx2.beginPath();
        ctx2.arc(24, 29, 3.5, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.fillRect(22.5, 30, 3, 6);
        return c;
      }

      const lockTypes = ['small_lock', 'medium_lock', 'big_lock', 'world_lock'];
      for (const lt of lockTypes) {
        lockSprites[lt] = {
          locked: createFallbackLockTexture(lt, false),
          access: createFallbackLockTexture(lt, true),
        };
      }

      const lockImg = new Image();
      lockImg.crossOrigin = 'anonymous';
      lockImg.src = '/public/assets/aistudio/IMG_20261030_221212_c0f7f5fd.jpg';
      lockImg.onload = () => {
        try {
          const off = document.createElement('canvas');
          off.width = lockImg.naturalWidth || lockImg.width;
          off.height = lockImg.naturalHeight || lockImg.height;
          const offCtx = off.getContext('2d')!;
          offCtx.drawImage(lockImg, 0, 0);

          const imgData = offCtx.getImageData(0, 0, off.width, off.height);
          const px = imgData.data;
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i], g = px[i + 1], b = px[i + 2];
            if (r < 55 && g < 55 && b < 55 && Math.abs(r - g) < 18 && Math.abs(r - b) < 18) {
              px[i + 3] = 0;
            }
          }
          offCtx.putImageData(imgData, 0, 0);

          const cellW = off.width / 2;
          const cellH = off.height / 4;
          lockTypes.forEach((lt, row) => {
            const lockedC = document.createElement('canvas');
            lockedC.width = cellW;
            lockedC.height = cellH;
            const lCtx = lockedC.getContext('2d')!;
            lCtx.drawImage(off, 0, row * cellH, cellW, cellH, 0, 0, cellW, cellH);

            const accessC = document.createElement('canvas');
            accessC.width = cellW;
            accessC.height = cellH;
            const aCtx = accessC.getContext('2d')!;
            aCtx.drawImage(off, cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);

            lockSprites[lt] = { locked: lockedC, access: accessC };
          });
        } catch (e) {
          console.warn('Could not process lock sprite sheet pixels:', e);
        }
      };

      // --- 5-GEM VARIETY SPRITE SHEET LOADER & SLICER ---
      // Sheet at /public/assets/aistudio/IMG_20261030_231602_0e064a1a.jpg
      // 1050x205: 5 columns x 1 row (Yellow=1, Cyan=5, Red=10, Green=50, Purple=100)
      const gemSprites: Record<number, HTMLCanvasElement> = {};
      const gemImg = new Image();
      gemImg.crossOrigin = 'anonymous';
      gemImg.src = '/public/assets/aistudio/IMG_20261030_231602_0e064a1a.jpg';
      gemImg.onload = () => {
        try {
          const off = document.createElement('canvas');
          off.width = gemImg.naturalWidth || gemImg.width;
          off.height = gemImg.naturalHeight || gemImg.height;
          const offCtx = off.getContext('2d')!;
          offCtx.drawImage(gemImg, 0, 0);

          const imgData = offCtx.getImageData(0, 0, off.width, off.height);
          const px = imgData.data;
          // Key out dark neutral background (~#272727)
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i], g = px[i + 1], b = px[i + 2];
            if (r < 55 && g < 55 && b < 55 && Math.abs(r - g) < 18 && Math.abs(r - b) < 18) {
              px[i + 3] = 0;
            }
          }
          offCtx.putImageData(imgData, 0, 0);

          const colW = off.width / 5;
          const colH = off.height;
          const gemDenominations = [1, 5, 10, 50, 100];
          gemDenominations.forEach((val, colIdx) => {
            const gc = document.createElement('canvas');
            gc.width = colW;
            gc.height = colH;
            const gCtx = gc.getContext('2d')!;
            gCtx.drawImage(off, colIdx * colW, 0, colW, colH, 0, 0, colW, colH);
            gemSprites[val] = gc;
          });
          console.log('GrowPixel: 5-gem sprite sheet loaded and sliced successfully!');
        } catch (e) {
          console.warn('Could not process gem sprite sheet:', e);
        }
      };

      // Draw Gem Pickups (using official sliced gem textures with fallback)
      function drawGemPickup(c: CanvasRenderingContext2D, x: number, y: number, value = 1) {
        const sprite = gemSprites[value] || gemSprites[1];
        const gemSizes: Record<number, { w: number; h: number }> = {
          1: { w: 22, h: 22 },
          5: { w: 25, h: 25 },
          10: { w: 28, h: 28 },
          50: { w: 31, h: 31 },
          100: { w: 34, h: 34 },
        };
        const sz = gemSizes[value] || gemSizes[1];

        if (sprite) {
          c.drawImage(sprite, Math.round(x - sz.w / 2), Math.round(y - sz.h / 2), sz.w, sz.h);
        } else {
          // Procedural fallback
          const cols: Record<number, string[]> = {
            1: ['#07566a', '#ffd700', '#fff9c4'],
            5: ['#0b4759', '#2cd1f0', '#b8f8ff'],
            10: ['#591212', '#f03232', '#ffbcbc'],
            50: ['#1d5918', '#38e34f', '#d5ffd8'],
            100: ['#4b1659', '#ce3df5', '#fad7ff'],
          };
          const pal = cols[value] || cols[1];
          c.save();
          c.translate(Math.round(x), Math.round(y));
          c.fillStyle = pal[1];
          c.beginPath();
          c.moveTo(0, -sz.h / 2);
          c.lineTo(sz.w / 2, 0);
          c.lineTo(0, sz.h / 2);
          c.lineTo(-sz.w / 2, 0);
          c.closePath();
          c.fill();
          c.fillStyle = pal[2];
          c.fillRect(-2, -2, 4, 4);
          c.restore();
        }
      }

      // --- AUTHENTIC GROWPIXEL PLAYER SPRITES ---
      const makePlayerSprite = (pose: 'idle' | 'walkA' | 'walkB' | 'jump' | 'punch', shirtCol = '#f0e8d7', pantsCol = '#302a50') => {
        const cv = document.createElement('canvas');
        cv.width = 32;
        cv.height = 44;
        const g = cv.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        const r = (x: number, y: number, w: number, h: number, col: string) => {
          g.fillStyle = col;
          g.fillRect(x, y, w, h);
        };
        r(8, 34, 7, 9, '#66524b');
        r(18, 34, 7, 9, '#66524b');
        if (pose === 'walkA') {
          r(7, 35, 8, 7, pantsCol);
          r(19, 33, 7, 9, pantsCol);
          r(6, 41, 9, 2, '#29243f');
          r(19, 41, 8, 2, '#29243f');
        } else if (pose === 'walkB') {
          r(9, 33, 7, 9, pantsCol);
          r(17, 35, 8, 7, pantsCol);
          r(8, 41, 8, 2, '#29243f');
          r(17, 41, 9, 2, '#29243f');
        } else if (pose === 'jump') {
          r(7, 34, 9, 7, pantsCol);
          r(18, 34, 8, 7, pantsCol);
          r(5, 39, 9, 3, '#29243f');
          r(20, 39, 9, 3, '#29243f');
        } else {
          r(8, 34, 7, 8, pantsCol);
          r(18, 34, 7, 8, pantsCol);
          r(7, 41, 8, 2, '#29243f');
          r(18, 41, 8, 2, '#29243f');
        }
        r(7, 22, 18, 14, '#8b7968');
        r(8, 23, 16, 12, shirtCol);
        r(10, 24, 12, 9, '#fff8e9');
        r(5, 24, 4, 10, '#bda78e');
        r(6, 25, 3, 8, '#d8c3a8');
        r(23, 24, 4, 10, '#bda78e');
        r(23, 25, 3, 8, '#d8c3a8');
        r(13, 21, 6, 3, '#c9b49a');
        r(3, 1, 26, 22, '#7c6658');
        r(4, 1, 24, 21, '#c8b397');
        r(5, 2, 22, 18, '#d8c5a8');
        r(4, 17, 24, 4, '#c8b397');
        r(7, 3, 4, 2, '#e4d3b9');
        r(22, 3, 4, 2, '#e4d3b9');
        r(8, 8, 6, 6, '#f7f5e9');
        r(19, 8, 6, 6, '#f7f5e9');
        r(12, 9, 3, 4, '#171717');
        r(22, 9, 3, 4, '#171717');
        r(9, 8, 2, 2, '#ffffff');
        r(20, 8, 2, 2, '#ffffff');
        r(15, 14, 3, 2, '#c3a88a');
        r(14, 17, 7, 2, '#8d7967');
        r(16, 16, 3, 1, '#e4cfb2');
        r(4, 12, 2, 4, '#c1a98c');
        r(26, 12, 2, 4, '#c1a98c');
        if (pose === 'punch') {
          r(23, 24, 5, 5, '#bda78e');
          r(26, 23, 5, 5, '#d8c3a8');
          r(29, 22, 3, 6, '#c8b397');
          r(30, 22, 2, 4, '#e0c9aa');
        }
        if (pose === 'jump') {
          r(9, 32, 6, 2, '#c8b397');
          r(18, 32, 6, 2, '#c8b397');
        }
        return cv;
      };

      const localSprites: Record<string, HTMLCanvasElement> = {
        idle: makePlayerSprite('idle', '#f0e8d7', '#302a50'),
        walkA: makePlayerSprite('walkA', '#f0e8d7', '#302a50'),
        walkB: makePlayerSprite('walkB', '#f0e8d7', '#302a50'),
        jump: makePlayerSprite('jump', '#f0e8d7', '#302a50'),
        punch: makePlayerSprite('punch', '#f0e8d7', '#302a50'),
      };

      const remoteSprites: Record<string, HTMLCanvasElement> = {
        idle: makePlayerSprite('idle', '#7ab0db', '#223447'),
        walkA: makePlayerSprite('walkA', '#7ab0db', '#223447'),
        walkB: makePlayerSprite('walkB', '#7ab0db', '#223447'),
        jump: makePlayerSprite('jump', '#7ab0db', '#223447'),
        punch: makePlayerSprite('punch', '#7ab0db', '#223447'),
      };

      // --- WEBSOCKET CLIENT CONNECTION WITH AUTHORITATIVE TOKEN ---
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

      let accessToken = currentUserRef.current?.session?.access_token || '';
      if (!accessToken) {
        try {
          const rawUser = localStorage.getItem('growpixel_mmo_user');
          if (rawUser) {
            const u = JSON.parse(rawUser);
            accessToken = u.session?.access_token || u.access_token || '';
          }
        } catch {}
      }

      const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(accessToken)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'world:join',
            worldName: targetWorld,
            token: accessToken,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'auth:error') {
            showToast(`Auth Error: ${msg.error}`);
            setAuthError(msg.error || 'Authentication error');
            setTimeout(() => {
              setScreen('AUTH');
            }, 1500);
            return;
          }
          if (msg.type === 'init:world') {
            myPlayerId = msg.myId;
            world = msg.tiles;
            currentLocks = msg.locks || [];
            drops = msg.drops || [];
            plantedTrees = msg.trees || [];
            currentWorldOwner = msg.worldOwner || null;
            setInGameWorldName(msg.worldName);
            setInGameWorldOwner(msg.worldOwner);

            remotePlayers.clear();
            if (msg.players) {
              for (const p of msg.players) {
                remotePlayers.set(p.id, p);
              }
            }
            setOnlineCount(remotePlayers.size + 1);
            showToast(`Joined world "${msg.worldName}"`);
          } else if (msg.type === 'player:joined') {
            if (msg.player && msg.player.id !== myPlayerId) {
              remotePlayers.set(msg.player.id, msg.player);
              setOnlineCount(remotePlayers.size + 1);
              showToast(`${msg.player.username} joined!`);
              playTone(520, 0.1, 'sine');
            }
          } else if (msg.type === 'player:moved') {
            const rp = remotePlayers.get(msg.id);
            if (rp) {
              rp.x = msg.x;
              rp.y = msg.y;
              rp.vx = msg.vx;
              rp.vy = msg.vy;
              rp.face = msg.face;
              rp.pose = msg.pose;
            }
          } else if (msg.type === 'player:punched') {
            const rp = remotePlayers.get(msg.id);
            if (rp) {
              rp.punchTime = 0.2;
              rp.punchAngle = msg.angle;
            }
          } else if (msg.type === 'player:left') {
            const p = remotePlayers.get(msg.id);
            if (p) {
              showToast(`${p.username} left.`);
              remotePlayers.delete(msg.id);
              setOnlineCount(remotePlayers.size + 1);
            }
          } else if (msg.type === 'chat:bubble') {
            chatBubbles.push({
              id: msg.id,
              username: msg.username,
              text: msg.text,
              timestamp: Date.now(),
            });
            playTone(660, 0.08, 'triangle');
          } else if (msg.type === 'block:changed') {
            const { tx, ty, blockId, locks, worldOwner, newDrops } = msg;
            if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H) {
              world[ty][tx] = blockId;
            }
            if (locks) currentLocks = locks;
            if (worldOwner !== undefined) {
              currentWorldOwner = worldOwner;
              setInGameWorldOwner(worldOwner);
            }
            if (newDrops && Array.isArray(newDrops)) {
              drops.push(...newDrops);
            }
            // Spawn break/place dust particles
            for (let i = 0; i < 6; i++) {
              particles.push({
                x: tx * TILE + TILE / 2,
                y: ty * TILE + TILE / 2,
                vx: (Math.random() - 0.5) * 160,
                vy: (Math.random() - 0.5) * 160,
                life: 0.35,
                color: blockId ? defs[blockId]?.color || '#ffffff' : '#a8b6bc',
              });
            }
          } else if (msg.type === 'drop:removed') {
            drops = drops.filter((d) => d.id !== msg.dropId);
          } else if (msg.type === 'inventory:sync') {
            // Updated inventory & gems from server (e.g. refunded lock or collected drop)
            if (msg.inventory) {
              userInventoryRef.current = msg.inventory;
            }
            if (msg.gems !== undefined) {
              userGemsRef.current = msg.gems;
            }
            setCurrentUser((prev) =>
              prev
                ? {
                    ...prev,
                    inventory: msg.inventory || prev.inventory,
                    gems: msg.gems !== undefined ? msg.gems : prev.gems,
                  }
                : null
            );
            checkEmptySlotRestoration(userInventoryRef.current);
          } else if (msg.type === 'lock:denied') {
            showToast(`🔒 Protected area! (${msg.lockType?.replace('_', ' ').toUpperCase() || 'LOCK'} owned by ${msg.owner})`);
            playTone(160, 0.2, 'sawtooth', 0.2);
          } else if (msg.type === 'lock:updated') {
            currentLocks = msg.locks || [];
            currentWorldOwner = msg.worldOwner || null;
            setInGameWorldOwner(currentWorldOwner);
          } else if (msg.type === 'notify') {
            showToast(msg.text);
          }
        } catch (err) {
          console.error('WS parse error:', err);
        }
      };

      // Throttled position sync
      let lastMoveSync = 0;
      function sendMoveUpdate() {
        const now = performance.now();
        if (now - lastMoveSync < 50) return;
        lastMoveSync = now;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'player:move',
              x: Math.round(player.x),
              y: Math.round(player.y),
              vx: Math.round(player.vx),
              vy: Math.round(player.vy),
              face: player.face,
              pose: player.pose,
            })
          );
        }
      }

      // Physics and World Collision
      function isSolid(tx: number, ty: number) {
        if (tx < 0 || tx >= WORLD_W || ty >= WORLD_H) return true;
        if (ty < 0) return false;
        const b = world[ty][tx];
        return !!(b && defs[b] && defs[b].solid);
      }

      function hasLockAccess(lock: LockRecord, username: string): boolean {
        if (lock.owner.toLowerCase() === username.toLowerCase()) return true;
        if (lock.allowedUsers.some((u) => u.toLowerCase() === username.toLowerCase())) return true;
        if (currentWorldOwner && currentWorldOwner.toLowerCase() === username.toLowerCase()) return true;
        return false;
      }

      function canEditTile(tx: number, ty: number): boolean {
        const wl = currentLocks.find((l) => l.type === 'world_lock');
        if (wl && !hasLockAccess(wl, myUsername)) return false;

        for (const l of currentLocks) {
          if (l.type === 'world_lock') continue;
          if (tx >= l.bounds.minX && tx <= l.bounds.maxX && ty >= l.bounds.minY && ty <= l.bounds.maxY) {
            if (!hasLockAccess(l, myUsername)) return false;
          }
        }
        return true;
      }

      // Local Block Placement (Does NOT unmount canvas or reset player position!)
      function placeAt(tx: number, ty: number, blockId: string) {
        if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;

        // Dedicated spawn door and bedrock are permanently locked in position
        const destBlock = world[ty]?.[tx];
        if (destBlock === 'spawn_door' || destBlock === 'bedrock') {
          showToast('Cannot build over the World Entrance!');
          return;
        }

        // Distance check
        const dist = Math.hypot(tx + 0.5 - (player.x + player.w / 2) / TILE, ty + 0.5 - (player.y + player.h * 0.42) / TILE);
        if (dist > 3.2) return;

        // Inventory check
        const currentCount = userInventoryRef.current[blockId] || 0;
        if (currentCount <= 0) {
          showToast(`No ${defs[blockId]?.name || blockId} remaining in inventory!`);
          checkEmptySlotRestoration(userInventoryRef.current);
          return;
        }

        // Lock territory checks
        if (!canEditTile(tx, ty)) {
          showToast('🔒 This area is protected by a territory lock!');
          playTone(160, 0.15, 'sawtooth');
          return;
        }

        // Check lock placement inside existing claim
        if (['small_lock', 'medium_lock', 'big_lock'].includes(blockId)) {
          const inside = currentLocks.some(
            (l) => l.type === 'world_lock' || (tx >= l.bounds.minX && tx <= l.bounds.maxX && ty >= l.bounds.minY && ty <= l.bounds.maxY)
          );
          if (inside) {
            showToast('Cannot place lock inside an existing claimed area!');
            return;
          }
        }

        // Check player overlap for solid blocks
        const bx = tx * TILE, by = ty * TILE;
        if (defs[blockId]?.solid) {
          if (bx < player.x + player.w && bx + TILE > player.x && by < player.y + player.h && by + TILE > player.y) {
            return;
          }
        }

        // Update local block
        world[ty][tx] = blockId;

        // Deduct inventory locally without causing a React canvas re-mount
        userInventoryRef.current[blockId]--;
        setCurrentUser((prev) => (prev ? { ...prev, inventory: { ...userInventoryRef.current } } : null));
        checkEmptySlotRestoration(userInventoryRef.current);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'block:place', tx, ty, blockId }));
          playTone(480, 0.08, 'triangle');
        }
      }

      // Pointer & Input Listeners
      const onPointerDown = (e: PointerEvent) => {
        if (e.target !== canvas) return;
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.down = true;
        mouse.justDown = true;

        const worldX = mouse.x + camera.x;
        const worldY = mouse.y + camera.y;

        // Check if clicked another player avatar to inspect
        for (const rp of remotePlayers.values()) {
          if (Math.abs(worldX - (rp.x + 22)) < 30 && Math.abs(worldY - (rp.y + 40)) < 45) {
            setInspectPlayer({
              username: rp.username,
              isOwner: rp.username.toLowerCase() === currentWorldOwner?.toLowerCase(),
            });
            return;
          }
        }
      };

      const onPointerMove = (e: PointerEvent) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      };

      const onPointerUp = () => {
        mouse.down = false;
        mouse.justDown = false;
        mining = null;
      };

      const onKeyDown = (e: KeyboardEvent) => {
        keys[e.code] = true;
        if (e.code === 'Enter') {
          setChatOpen(true);
        }
        if (e.code === 'KeyF') {
          setSelectedItem('fist');
        }
        if (e.code === 'KeyB' || e.code === 'KeyE') {
          setIsInventoryOpen((prev) => !prev);
        }
        if (e.code === 'Digit1') {
          const s = recentSlotsRef.current[0];
          if (s && (userInventoryRef.current[s] || 0) > 0) setSelectedItem(s);
        }
        if (e.code === 'Digit2') {
          const s = recentSlotsRef.current[1];
          if (s && (userInventoryRef.current[s] || 0) > 0) setSelectedItem(s);
        }
        if (e.code === 'Digit3') {
          const s = recentSlotsRef.current[2];
          if (s && (userInventoryRef.current[s] || 0) > 0) setSelectedItem(s);
        }
      };

      const onKeyUp = (e: KeyboardEvent) => {
        keys[e.code] = false;
      };

      // Resize Canvas
      const onResize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      };
      window.addEventListener('resize', onResize);
      onResize();

      canvas.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);

      // --- MAIN ENGINE TICK & RENDER LOOP ---
      let lastTime = performance.now();
      let animFrameId: number;

      const loop = (now: number) => {
        const dt = Math.min(0.06, (now - lastTime) / 1000);
        lastTime = now;
        animTime += dt;

        // Movement input
        const left = keys['KeyA'] || keys['ArrowLeft'] || mobileInputRef.current.left;
        const right = keys['KeyD'] || keys['ArrowRight'] || mobileInputRef.current.right;
        const jump = keys['KeyW'] || keys['Space'] || keys['ArrowUp'] || mobileInputRef.current.jump;

        // Horizontal movement
        const moveSpeed = 260;
        if (left && !right) {
          player.vx = -moveSpeed;
          player.face = -1;
          player.pose = 'walk';
          walkPhase += dt * 14;
        } else if (right && !left) {
          player.vx = moveSpeed;
          player.face = 1;
          player.pose = 'walk';
          walkPhase += dt * 14;
        } else {
          player.vx *= 0.65;
          if (Math.abs(player.vx) < 10) player.vx = 0;
          player.pose = 'idle';
        }

        // Gravity
        player.vy += 980 * dt;
        if (player.vy > 850) player.vy = 850;

        // Jump mechanics
        if (player.ground) coyoteTimer = 0.12;
        else coyoteTimer -= dt;

        if (jump) jumpBuffer = 0.14;
        else jumpBuffer -= dt;

        if (coyoteTimer > 0 && jumpBuffer > 0) {
          player.vy = -540;
          player.ground = false;
          coyoteTimer = 0;
          jumpBuffer = 0;
          playTone(440, 0.1, 'sine');
        }

        // Horizontal Collision
        player.x += player.vx * dt;
        let pLeft = Math.floor(player.x / TILE);
        let pRight = Math.floor((player.x + player.w) / TILE);
        let pTop = Math.floor(player.y / TILE);
        let pBottom = Math.floor((player.y + player.h - 1) / TILE);

        for (let ty = pTop; ty <= pBottom; ty++) {
          for (let tx = pLeft; tx <= pRight; tx++) {
            if (isSolid(tx, ty)) {
              if (player.vx > 0) {
                player.x = tx * TILE - player.w - 0.01;
                player.vx = 0;
              } else if (player.vx < 0) {
                player.x = (tx + 1) * TILE + 0.01;
                player.vx = 0;
              }
            }
          }
        }

        // Vertical Collision
        player.y += player.vy * dt;
        pLeft = Math.floor(player.x / TILE);
        pRight = Math.floor((player.x + player.w) / TILE);
        pTop = Math.floor(player.y / TILE);
        pBottom = Math.floor((player.y + player.h) / TILE);

        player.ground = false;
        for (let ty = pTop; ty <= pBottom; ty++) {
          for (let tx = pLeft; tx <= pRight; tx++) {
            if (isSolid(tx, ty)) {
              if (player.vy > 0) {
                player.y = ty * TILE - player.h - 0.01;
                player.vy = 0;
                player.ground = true;
              } else if (player.vy < 0) {
                player.y = (ty + 1) * TILE + 0.01;
                player.vy = 0;
              }
            }
          }
        }

        // Punch animation cooldowns
        if (punchTime > 0) punchTime -= dt;
        if (punchCooldown > 0) punchCooldown -= dt;

        // --- HOLD-TO-BREAK MINING & INTERACTION LOGIC ---
        if (mouse.down) {
          const worldX = mouse.x + camera.x;
          const worldY = mouse.y + camera.y;
          const tx = Math.floor(worldX / TILE);
          const ty = Math.floor(worldY / TILE);
          const currentSel = selectedItemRef.current;

          const dist = Math.hypot(tx + 0.5 - (player.x + player.w / 2) / TILE, ty + 0.5 - (player.y + player.h * 0.42) / TILE);

          if (dist <= 3.2) {
            if (currentSel === 'fist') {
              const currentBlock = world[ty]?.[tx];

              if (currentBlock === 'spawn_door') {
                // Punching the Spawn Door while standing near/on it prompts Exit World
                if (punchCooldown <= 0) {
                  punchTime = 0.22;
                  punchCooldown = 0.32;
                  const angle = Math.atan2(worldY - (player.y + player.h / 2), worldX - (player.x + player.w / 2));
                  punchDir = { x: Math.cos(angle), y: Math.sin(angle) };
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'player:punch', angle, targetTx: tx, targetTy: ty }));
                  }
                  playTone(330, 0.12, 'sine');

                  const playerTileX = Math.floor((player.x + player.w / 2) / TILE);
                  const playerTileY = Math.floor((player.y + player.h - 2) / TILE);
                  if (Math.abs(playerTileX - tx) <= 1 && Math.abs(playerTileY - ty) <= 1) {
                    setShowExitModal(true);
                  }
                }
                mining = null;
              } else if (currentBlock === 'bedrock') {
                mining = null;
              } else if (currentBlock) {
                // Check if target is an owned lock
                const lockRec = currentLocks.find((l) => l.tx === tx && l.ty === ty);
                if (lockRec && lockRec.owner.toLowerCase() !== myUsername.toLowerCase()) {
                  if (punchCooldown <= 0) {
                    showToast(`Only the owner (${lockRec.owner}) can break this lock!`);
                    playTone(160, 0.15, 'sawtooth');
                    punchCooldown = 0.4;
                  }
                  mining = null;
                } else if (!canEditTile(tx, ty)) {
                  if (punchCooldown <= 0) {
                    showToast('🔒 This area is protected by a lock!');
                    playTone(160, 0.15, 'sawtooth');
                    punchCooldown = 0.4;
                  }
                  mining = null;
                } else {
                  // Valid block to mine: require continuous hold!
                  if (!mining || mining.tx !== tx || mining.ty !== ty) {
                    mining = { tx, ty, id: currentBlock, progress: 0 };
                  }

                  const hardness = defs[currentBlock]?.hard || 0.5;
                  // Exact required duration formula: progress += dt / (hardness * 2.35)
                  mining.progress += dt / (hardness * 2.35);

                  // Continuous punch motion
                  if (punchCooldown <= 0) {
                    punchTime = 0.22;
                    punchCooldown = 0.26;
                    const angle = Math.atan2(worldY - (player.y + player.h / 2), worldX - (player.x + player.w / 2));
                    punchDir = { x: Math.cos(angle), y: Math.sin(angle) };
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'player:punch', angle, targetTx: tx, targetTy: ty }));
                    }
                    playTone(210, 0.08, 'triangle', 0.12);
                  }

                  // Break completed
                  if (mining.progress >= 1.0) {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'block:mine', tx, ty }));
                    }
                    playTone(280, 0.14, 'sawtooth', 0.2);
                    mining = null;
                  }
                }
              } else {
                mining = null;
              }
            } else if (mouse.justDown && defs[currentSel]) {
              // Block placement triggers once per click/tap!
              mouse.justDown = false;
              placeAt(tx, ty, currentSel);
            }
          } else {
            mining = null;
          }
        } else {
          mining = null;
        }

        // Smooth Camera Follow
        const targetCamX = player.x + player.w / 2 - canvas.width / 2;
        const targetCamY = player.y + player.h / 2 - canvas.height / 2;
        camera.x += (targetCamX - camera.x) * 0.12;
        camera.y += (targetCamY - camera.y) * 0.12;

        // Send network movement
        sendMoveUpdate();

        // Update Remote Players' punch animation
        for (const rp of remotePlayers.values()) {
          if (rp.punchTime && rp.punchTime > 0) rp.punchTime -= dt;
        }

        // Update drops & check local pickup
        const playerCx = player.x + player.w / 2;
        const playerCy = player.y + player.h / 2;

        for (let i = drops.length - 1; i >= 0; i--) {
          const d = drops[i];
          d.age = (d.age || 0) + dt;

          const dist = Math.hypot(playerCx - d.x, playerCy - d.y);
          if (dist < 36) {
            // Picked up!
            playTone(660, 0.1, 'sine', 0.15);
            if (d.itemId === 'gem') {
              const val = d.value || 1;
              userGemsRef.current += val;
              setCurrentUser((prev) => (prev ? { ...prev, gems: userGemsRef.current } : null));
              showToast(`+${val} Gem${val > 1 ? 's' : ''}!`);
            } else {
              const q = d.count || 1;
              userInventoryRef.current[d.itemId] = (userInventoryRef.current[d.itemId] || 0) + q;
              setCurrentUser((prev) => (prev ? { ...prev, inventory: { ...userInventoryRef.current } } : null));
              addToRecentSlots(d.itemId);
              showToast(`+${q} ${defs[d.itemId]?.name || d.itemId}`);
            }

            // Tell server drop was collected
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'drop:pickup',
                  dropId: d.id,
                  itemId: d.itemId,
                  count: d.count || 1,
                  value: d.value,
                })
              );
            }
            drops.splice(i, 1);
          }
        }

        // Update particles
        for (let i = particles.length - 1; i >= 0; i--) {
          const pt = particles[i];
          pt.x += pt.vx * dt;
          pt.y += pt.vy * dt;
          pt.life -= dt;
          if (pt.life <= 0) particles.splice(i, 1);
        }

        // Clear expired chat bubbles (older than 4.5s)
        const bubbleThreshold = Date.now() - 4500;
        chatBubbles = chatBubbles.filter((b) => b.timestamp > bubbleThreshold);

        // Toast timer
        if (toastTimer > 0) toastTimer -= dt;

        // --- DRAW FRAME ---
        // 1. Sky with 3-Layer Parallax Rolling Hills & Sun
        const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        skyGrad.addColorStop(0, '#73c9ee');
        skyGrad.addColorStop(0.65, '#b4e4e7');
        skyGrad.addColorStop(1, '#e4e8cb');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const sunX = canvas.width * 0.78 - camera.x * 0.025;
        const sunY = 85 - camera.y * 0.02;
        ctx.fillStyle = '#fff0a1';
        ctx.beginPath();
        ctx.arc(sunX, sunY, 25, 0, Math.PI * 2);
        ctx.fill();

        // Parallax rolling hills
        for (let layer = 0; layer < 3; layer++) {
          ctx.fillStyle = ['#91cbb6', '#78b7a4', '#5d9b8a'][layer];
          ctx.beginPath();
          ctx.moveTo(0, canvas.height);
          const step = 70;
          for (let x = -step; x < canvas.width + step; x += step) {
            const yy = canvas.height * 0.48 + Math.sin((x + camera.x * 0.12 + layer * 90) * 0.008) * (42 + layer * 12) + layer * 35;
            ctx.lineTo(x, yy);
          }
          ctx.lineTo(canvas.width, canvas.height);
          ctx.closePath();
          ctx.fill();
        }

        ctx.save();
        ctx.translate(-Math.floor(camera.x), -Math.floor(camera.y));

        // Visible tile bounds
        const startTx = Math.max(0, Math.floor(camera.x / TILE));
        const endTx = Math.min(WORLD_W - 1, Math.ceil((camera.x + canvas.width) / TILE));
        const startTy = Math.max(0, Math.floor(camera.y / TILE));
        const endTy = Math.min(WORLD_H - 1, Math.ceil((camera.y + canvas.height) / TILE));

        // Draw World Lock outline if present
        const worldLock = currentLocks.find((l) => l.type === 'world_lock');
        if (worldLock) {
          ctx.strokeStyle = hasLockAccess(worldLock, myUsername) ? 'rgba(168, 230, 110, 0.45)' : 'rgba(234, 113, 113, 0.35)';
          ctx.lineWidth = 4;
          ctx.strokeRect(camera.x + 2, camera.y + 2, canvas.width - 4, canvas.height - 4);
        }

        // Draw Tiles with Authentic GrowPixel Textures
        for (let ty = startTy; ty <= endTy; ty++) {
          for (let tx = startTx; tx <= endTx; tx++) {
            const blockId = world[ty][tx];
            if (!blockId) continue;
            const px = tx * TILE;
            const py = ty * TILE;

            // Dedicated World Entrance Spawn Door (Indestructible background fixture)
            if (blockId === 'spawn_door') {
              // Outer stone archway lintel
              ctx.fillStyle = '#4f5e6a';
              ctx.fillRect(px + 4, py + 2, TILE - 8, 8);
              ctx.fillStyle = '#7a8e9e';
              ctx.fillRect(px + 6, py + 3, TILE - 12, 3);
              ctx.fillStyle = '#303c46';
              ctx.fillRect(px + 4, py + 9, 6, TILE - 9);
              ctx.fillRect(px + TILE - 10, py + 9, 6, TILE - 9);

              // Heavy wooden door planks
              ctx.fillStyle = '#593a20';
              ctx.fillRect(px + 10, py + 9, TILE - 20, TILE - 9);
              ctx.fillStyle = '#754f30';
              ctx.fillRect(px + 12, py + 11, 8, TILE - 13);
              ctx.fillRect(px + 22, py + 11, 8, TILE - 13);
              ctx.fillRect(px + 32, py + 11, 8, TILE - 13);

              // Bronze ornamental handle & keyhole
              ctx.fillStyle = '#24170d';
              ctx.fillRect(px + 13, py + 27, 4, 8);
              ctx.fillStyle = '#e8bc56';
              ctx.beginPath();
              ctx.arc(px + 15, py + 31, 3.5, 0, Math.PI * 2);
              ctx.fill();

              // Glowing mystical rune threshold
              ctx.fillStyle = 'rgba(255, 234, 140, 0.35)';
              ctx.fillRect(px + 10, py + TILE - 4, TILE - 20, 4);

              // Floating entrance indicator tag
              ctx.save();
              ctx.font = 'bold 9px Inter, sans-serif';
              ctx.fillStyle = '#ffeaa7';
              ctx.textAlign = 'center';
              ctx.fillText('EXIT / SPAWN', px + TILE / 2, py - 4);
              ctx.restore();
              continue;
            }

            // Locks: official sprite sheet with transparent background & viewer access
            if (['small_lock', 'medium_lock', 'big_lock', 'world_lock'].includes(blockId)) {
              const lockRec = currentLocks.find((l) => l.tx === tx && l.ty === ty);
              const userHasAccess = lockRec ? hasLockAccess(lockRec, myUsername) : true;
              const sprite = lockSprites[blockId];
              if (sprite) {
                const tex = userHasAccess ? sprite.access : sprite.locked;
                ctx.drawImage(tex, px + 2, py + 2, TILE - 4, TILE - 4);
              }
              if (userHasAccess) {
                ctx.fillStyle = '#a8e66e33';
                ctx.beginPath();
                ctx.arc(px + TILE / 2, py + TILE / 2, 16 + Math.sin(animTime * 4) * 2, 0, Math.PI * 2);
                ctx.fill();
              }
              continue;
            }

            // Seed Pot planter
            if (blockId === 'seedPot') {
              const q = (n: number) => Math.max(1, Math.round((n * TILE) / 52));
              ctx.fillStyle = '#4a3524';
              ctx.fillRect(px + q(9), py + q(40), q(4), q(10));
              ctx.fillRect(px + TILE - q(13), py + q(40), q(4), q(10));
              ctx.fillStyle = '#87603a';
              ctx.fillRect(px + q(8), py + q(44), q(5), q(6));
              ctx.fillRect(px + TILE - q(13), py + q(44), q(5), q(6));
              ctx.fillStyle = '#3b2c20';
              ctx.fillRect(px + q(5), py + q(36), TILE - q(10), q(10));
              ctx.fillStyle = '#6c4b31';
              ctx.fillRect(px + q(3), py + q(33), TILE - q(6), q(7));
              ctx.fillStyle = '#c08a4c';
              ctx.fillRect(px + q(2), py + q(31), TILE - q(4), q(4));
              ctx.fillStyle = '#e4b66c';
              ctx.fillRect(px + q(4), py + q(31), TILE - q(8), q(2));
              ctx.fillStyle = '#705033';
              ctx.fillRect(px + q(5), py + q(37), TILE - q(10), q(7));
              ctx.fillStyle = '#b78a52';
              ctx.fillRect(px + q(7), py + q(39), q(4), q(4));
              ctx.fillRect(px + TILE - q(12), py + q(40), q(4), q(3));
              ctx.fillStyle = '#d4a76b';
              ctx.fillRect(px + q(8), py + q(34), q(3), q(2));
              ctx.fillRect(px + TILE - q(11), py + q(34), q(3), q(2));
              ctx.fillStyle = '#263c2d';
              ctx.fillRect(px + q(10), py + q(36), TILE - q(20), q(4));
              ctx.fillStyle = '#3b2c20';
              ctx.fillRect(px + q(7), py + q(49), q(8), q(2));
              ctx.fillRect(px + TILE - q(15), py + q(49), q(8), q(2));
              continue;
            }

            // Procedural Terrain Blocks
            const seed = (tx * 73856093 ^ ty * 19349663 ^ blockId.length * 83492791) >>> 0;
            let s = seed || 1;
            const r = () => {
              s = (s * 1664525 + 1013904223) >>> 0;
              return s / 4294967296;
            };
            const pxx = Math.max(2, Math.floor(TILE / 13));
            const q = (n: number) => Math.max(1, Math.round((n * TILE) / 52));

            const def = defs[blockId];
            ctx.fillStyle = def?.color || '#888';
            ctx.fillRect(px, py, TILE, TILE);

            if (blockId === 'dirt') {
              const soils = ['#b77a4b', '#875335', '#75482f', '#ad7042', '#c18a53'];
              for (let i = 0; i < 29; i++) {
                ctx.fillStyle = soils[Math.floor(r() * soils.length)];
                const xx = px + 2 + Math.floor(r() * (TILE - 5));
                const yy = py + 2 + Math.floor(r() * (TILE - 5));
                const ww = pxx * (r() > 0.76 ? 2 : 1);
                const hh = pxx * (r() > 0.85 ? 2 : 1);
                ctx.fillRect(xx, yy, Math.min(ww, px + TILE - xx - 1), Math.min(hh, py + TILE - yy - 1));
              }
              ctx.fillStyle = '#5e3929';
              ctx.fillRect(px + q(8), py + q(25), q(8), q(2));
              ctx.fillRect(px + q(31), py + q(38), q(10), q(2));
              ctx.fillRect(px + q(18), py + q(13), q(3), q(5));
              ctx.fillStyle = '#d69a60';
              ctx.fillRect(px + q(6), py + q(16), q(8), q(3));
              ctx.fillRect(px + q(32), py + q(7), q(6), q(2));
              ctx.fillRect(px + q(23), py + q(34), q(5), q(3));

              if (ty === 0 || !world[ty - 1] || world[ty - 1][tx] === null) {
                const cap = Math.max(q(10), Math.floor(TILE * 0.2));
                ctx.fillStyle = '#3e8338';
                ctx.fillRect(px, py, TILE, cap + q(2));
                ctx.fillStyle = '#56b447';
                ctx.fillRect(px, py, TILE, q(7));
                ctx.fillStyle = '#8ee95b';
                ctx.fillRect(px + q(3), py + q(1), q(11), q(3));
                ctx.fillRect(px + q(24), py + q(1), q(8), q(2));
                for (let i = 0; i < Math.floor(TILE / 2.8); i++) {
                  const gx = px + Math.floor(r() * (TILE - 2));
                  ctx.fillStyle = ['#398c39', '#55b949', '#78d951', '#2f7534'][Math.floor(r() * 4)];
                  ctx.fillRect(gx, py + Math.floor(r() * cap), q(2), q(2 + r() * 4));
                }
                ctx.fillStyle = '#91603d';
                ctx.fillRect(px, py + cap, TILE, q(2));
                ctx.fillStyle = '#b17b4d';
                ctx.fillRect(px, py + cap, TILE, q(1));
              }
            } else if (blockId === 'stone') {
              const facets = ['#aab7bd', '#77868e', '#6b7a83', '#c3cdd0', '#8c9aa0', '#5f7079'];
              for (let i = 0; i < 23; i++) {
                ctx.fillStyle = facets[Math.floor(r() * facets.length)];
                const xx = px + q(2 + Math.floor(r() * 43)), yy = py + q(2 + Math.floor(r() * 43));
                ctx.fillRect(xx, yy, q(2 + r() * 8), q(2 + r() * 5));
              }
              ctx.fillStyle = '#d8e0e2';
              ctx.fillRect(px + q(5), py + q(5), q(10), q(2));
              ctx.fillRect(px + q(7), py + q(7), q(3), q(3));
              ctx.fillRect(px + q(34), py + q(34), q(8), q(2));
              ctx.fillStyle = '#53646e';
              ctx.fillRect(px + q(23), py + q(13), q(2), q(12));
              ctx.fillRect(px + q(23), py + q(24), q(7), q(2));
            } else if (blockId === 'wood') {
              ctx.fillStyle = '#e2b474';
              ctx.fillRect(px + q(7), py + q(2), q(4), TILE - q(4));
              ctx.fillRect(px + q(26), py + q(4), q(3), TILE - q(8));
              ctx.fillStyle = '#89512f';
              ctx.fillRect(px + q(15), py + q(2), q(2), TILE - q(4));
              ctx.fillRect(px + q(36), py + q(3), q(2), TILE - q(6));
              ctx.fillStyle = '#d09351';
              ctx.fillRect(px + q(11), py + q(8), q(2), q(25));
            } else if (blockId === 'leaves') {
              const greens = ['#2d7c3e', '#388e43', '#49a84a', '#58b94b', '#75ca56', '#9bdf65', '#246d39'];
              for (let i = 0; i < 38; i++) {
                ctx.fillStyle = greens[Math.floor(r() * greens.length)];
                const xx = px + q(2 + Math.floor(r() * 45)), yy = py + q(2 + Math.floor(r() * 45));
                ctx.fillRect(xx, yy, q(2 + r() * 5), q(2 + r() * 4));
              }
            } else if (blockId === 'sand') {
              const sands = ['#f5dfa0', '#d7be70', '#c5a85c', '#ead184', '#f4e5aa'];
              for (let i = 0; i < 28; i++) {
                ctx.fillStyle = sands[Math.floor(r() * sands.length)];
                const xx = px + q(2 + Math.floor(r() * 45)), yy = py + q(2 + Math.floor(r() * 45));
                ctx.fillRect(xx, yy, q(2 + r() * 4), q(1 + r() * 2));
              }
              ctx.fillStyle = '#f7e5af';
              ctx.fillRect(px + q(4), py + q(11), q(15), q(2));
              ctx.fillRect(px + q(27), py + q(29), q(18), q(2));
            } else if (blockId === 'bedrock') {
              for (let i = 0; i < 22; i++) {
                ctx.fillStyle = ['#82919d', '#596775', '#1f2a34', '#455361'][Math.floor(r() * 4)];
                ctx.fillRect(px + q(2 + Math.floor(r() * 45)), py + q(2 + Math.floor(r() * 45)), q(3 + r() * 8), q(2 + r() * 6));
              }
              ctx.fillStyle = '#adb7ba';
              ctx.fillRect(px + q(4), py + q(5), q(10), q(2));
            } else if (blockId === 'lava') {
              const pulse = (Math.sin(animTime * 2.5 + tx * 0.8 + ty * 0.4) + 1) * 0.5;
              ctx.fillStyle = '#c8321c';
              ctx.fillRect(px, py + q(39), TILE, q(13));
              ctx.fillStyle = '#ff7824';
              ctx.fillRect(px + q(2), py + q(9), q(16), q(7));
              ctx.fillStyle = '#ffb52e';
              ctx.fillRect(px + q(4), py + q(10), q(10), q(3));
              ctx.fillRect(px + q(25), py + q(29 + pulse * 4), q(14), q(3));
            }

            ctx.fillStyle = '#ffffff10';
            ctx.fillRect(px, py, TILE, Math.max(1, q(1)));
            ctx.fillStyle = '#00000016';
            ctx.fillRect(px, py + TILE - q(2), TILE, q(2));
          }
        }

        // Draw Mining Progress Fracture Cracks (4 Stages + Progress Bar)
        if (mining) {
          const mx = mining.tx * TILE, my = mining.ty * TILE;
          const p = Math.min(1, Math.max(0, mining.progress));

          ctx.save();
          ctx.strokeStyle = 'rgba(28, 18, 12, 0.88)';
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();

          // Stage 1 (p >= 0.20): Center hairline fissure
          if (p >= 0.2) {
            ctx.moveTo(mx + 22, my + 18);
            ctx.lineTo(mx + 28, my + 27);
            ctx.lineTo(mx + 24, my + 34);
          }
          // Stage 2 (p >= 0.45): Branching fractures
          if (p >= 0.45) {
            ctx.moveTo(mx + 28, my + 27);
            ctx.lineTo(mx + 39, my + 22);
            ctx.lineTo(mx + 44, my + 28);
            ctx.moveTo(mx + 22, my + 18);
            ctx.lineTo(mx + 13, my + 14);
          }
          // Stage 3 (p >= 0.70): Spiderweb fractures to borders
          if (p >= 0.7) {
            ctx.moveTo(mx + 24, my + 34);
            ctx.lineTo(mx + 33, my + 44);
            ctx.lineTo(mx + 38, my + 49);
            ctx.moveTo(mx + 13, my + 14);
            ctx.lineTo(mx + 7, my + 24);
            ctx.lineTo(mx + 11, my + 39);
          }
          // Stage 4 (p >= 0.88): Dense fractures and crumbling fragments
          if (p >= 0.88) {
            ctx.moveTo(mx + 39, my + 22);
            ctx.lineTo(mx + 48, my + 14);
            ctx.moveTo(mx + 24, my + 34);
            ctx.lineTo(mx + 15, my + 42);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 230, 160, 0.85)';
            ctx.fillRect(mx + 16, my + 19, 3, 3);
            ctx.fillRect(mx + 36, my + 33, 4, 3);
            ctx.fillRect(mx + 27, my + 43, 3, 3);
          } else {
            ctx.stroke();
          }

          // Durability bar
          const barW = TILE - 8;
          ctx.fillStyle = 'rgba(12, 22, 28, 0.8)';
          ctx.fillRect(mx + 4, my - 6, barW, 4);
          ctx.fillStyle = '#ffd77a';
          ctx.fillRect(mx + 4, my - 6, barW * p, 4);
          ctx.strokeStyle = '#3a505b';
          ctx.lineWidth = 1;
          ctx.strokeRect(mx + 4, my - 6, barW, 4);
          ctx.restore();
        }

        // Draw Lock Area Boundaries
        for (const lk of currentLocks) {
          if (lk.type === 'world_lock') continue;
          const userAccess = hasLockAccess(lk, myUsername);
          const bx = lk.bounds.minX * TILE;
          const by = lk.bounds.minY * TILE;
          const bw = (lk.bounds.maxX - lk.bounds.minX + 1) * TILE;
          const bh = (lk.bounds.maxY - lk.bounds.minY + 1) * TILE;

          ctx.strokeStyle = userAccess ? 'rgba(168, 230, 110, 0.45)' : 'rgba(234, 113, 113, 0.35)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 6]);
          ctx.strokeRect(bx, by, bw, bh);
          ctx.setLineDash([]);
        }

        // Draw Drops (Gems and Blocks)
        for (const d of drops) {
          const dx = d.x;
          const dy = d.y - Math.sin(animTime * 3.2 + (d.age || 0) * 1.7) * 4;
          ctx.save();
          if (d.itemId === 'gem') {
            drawGemPickup(ctx, Math.round(dx), Math.round(dy), d.value || 1);
          } else {
            ctx.translate(Math.round(dx), Math.round(dy));
            ctx.fillStyle = '#10202a30';
            ctx.fillRect(-15, 13, 30, 4);
            ctx.fillStyle = '#c8f6ff22';
            ctx.fillRect(-14, -14, 28, 28);
            ctx.fillStyle = '#e4fbff38';
            ctx.fillRect(-13, -13, 26, 3);
            ctx.fillRect(-13, -13, 3, 26);
            ctx.fillStyle = '#8adcf488';
            ctx.fillRect(11, -12, 2, 24);
            ctx.fillRect(-12, 11, 24, 2);
            ctx.strokeStyle = '#e6fbffcc';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(-14, -14, 28, 28);
            const dropDef = defs[d.itemId];
            if (dropDef) {
              ctx.fillStyle = dropDef.color;
              ctx.fillRect(-7, -7, 14, 14);
            }
          }
          ctx.restore();
        }

        // Draw Particles
        for (const pt of particles) {
          ctx.fillStyle = pt.color;
          ctx.fillRect(pt.x, pt.y, 4, 4);
        }

        // Avatar Rendering
        function drawAvatar(
          c: CanvasRenderingContext2D,
          x: number,
          y: number,
          face: number,
          pose: string,
          username: string,
          isPunching: boolean,
          _punchAngle: number,
          isLocal: boolean
        ) {
          const sprites = isLocal ? localSprites : remoteSprites;
          let spriteKey = 'idle';
          if (isPunching) {
            spriteKey = 'punch';
          } else if (pose === 'jump' || !player.ground) {
            spriteKey = 'jump';
          } else if (pose === 'walk' || Math.abs(player.vx) > 10) {
            spriteKey = Math.floor(walkPhase * 2) % 2 === 0 ? 'walkA' : 'walkB';
          } else {
            spriteKey = 'idle';
          }

          const sprite = sprites[spriteKey] || sprites.idle;
          const drawW = 52, drawH = 72;
          const drawX = Math.round(x + (player.w - drawW) / 2);
          const drawY = Math.round(y + player.h - drawH);

          c.save();
          c.imageSmoothingEnabled = false;

          c.fillStyle = 'rgba(20, 33, 44, 0.28)';
          c.beginPath();
          c.ellipse(x + player.w / 2, y + player.h - 1, 14, 3, 0, 0, Math.PI * 2);
          c.fill();

          if (face < 0) {
            c.translate(drawX + drawW, drawY);
            c.scale(-1, 1);
            c.drawImage(sprite, 0, 0, drawW, drawH);
          } else {
            c.drawImage(sprite, drawX, drawY, drawW, drawH);
          }
          c.restore();

          // Floating Nameplate
          c.save();
          const nameX = x + 22;
          const nameY = y - 10;
          const isOwner = username.toLowerCase() === currentWorldOwner?.toLowerCase();
          const tag = (isOwner ? '👑 ' : '') + username;

          c.font = 'bold 11px Inter, sans-serif';
          const textW = c.measureText(tag).width;

          c.fillStyle = isOwner ? 'rgba(74, 52, 16, 0.88)' : 'rgba(14, 26, 32, 0.85)';
          c.strokeStyle = isOwner ? '#ffd77a' : '#56707a';
          c.lineWidth = 1;
          c.beginPath();
          c.roundRect(nameX - textW / 2 - 6, nameY - 14, textW + 12, 18, 4);
          c.fill();
          c.stroke();

          c.fillStyle = isOwner ? '#ffe08b' : '#f0f7f4';
          c.textAlign = 'center';
          c.fillText(tag, nameX, nameY);
          c.restore();

          // Floating Speech Bubble
          const bubble = chatBubbles.filter((b) => b.username.toLowerCase() === username.toLowerCase()).pop();
          if (bubble) {
            const age = (Date.now() - bubble.timestamp) / 1000;
            if (age < 4.2) {
              const alpha = age > 3.4 ? (4.2 - age) / 0.8 : 1;
              c.save();
              c.globalAlpha = alpha;
              c.font = '600 12px Inter, sans-serif';
              const bTextW = c.measureText(bubble.text).width;
              const bx = x + 22;
              const by = y - 36;

              c.fillStyle = '#ffffff';
              c.strokeStyle = '#223842';
              c.lineWidth = 2;
              c.beginPath();
              c.roundRect(bx - bTextW / 2 - 10, by - 16, bTextW + 20, 24, 6);
              c.fill();
              c.stroke();

              c.beginPath();
              c.moveTo(bx - 5, by + 8);
              c.lineTo(bx, by + 15);
              c.lineTo(bx + 5, by + 8);
              c.fill();
              c.stroke();

              c.fillStyle = '#101c24';
              c.textAlign = 'center';
              c.fillText(bubble.text, bx, by);
              c.restore();
            }
          }
        }

        // Draw Remote Players
        for (const rp of remotePlayers.values()) {
          drawAvatar(
            ctx,
            rp.x,
            rp.y,
            rp.face,
            rp.pose,
            rp.username,
            !!(rp.punchTime && rp.punchTime > 0),
            rp.punchAngle || 0,
            false
          );
        }

        // Draw Local Player
        drawAvatar(
          ctx,
          player.x,
          player.y,
          player.face,
          player.pose,
          myUsername,
          punchTime > 0,
          Math.atan2(punchDir.y, punchDir.x),
          true
        );

        ctx.restore();

        // Screen HUD: Toast notifications
        if (toastTimer > 0 && toastMessage) {
          ctx.save();
          ctx.font = 'bold 13px Inter, sans-serif';
          const tw = ctx.measureText(toastMessage).width;
          const tx = canvas.width / 2;
          const ty = 68;

          ctx.fillStyle = 'rgba(16, 28, 33, 0.94)';
          ctx.strokeStyle = '#a8e66e';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(tx - tw / 2 - 16, ty - 16, tw + 32, 32, 6);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#f0ffea';
          ctx.textAlign = 'center';
          ctx.fillText(toastMessage, tx, ty + 5);
          ctx.restore();
        }

        animFrameId = requestAnimationFrame(loop);
      };

      animFrameId = requestAnimationFrame(loop);

      // Cleanup
      cleanup = () => {
        cancelAnimationFrame(animFrameId);
        window.removeEventListener('resize', onResize);
        canvas.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };
    } catch (err) {
      console.error('Game initialization error:', err);
    }

    return () => {
      if (cleanup) cleanup();
    };
  }, [screen, targetWorld]); // Decoupled! No currentUser in dependency array!

  // Send Chat message from in-game chat box
  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatMessage.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'chat:send', text }));
    setChatMessage('');
    setChatOpen(false);
  };

  // Lock Management API calls
  const handleLockAddUser = (targetUser: string) => {
    if (!activeLock || !targetUser.trim() || !wsRef.current) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'lock:manage',
        lockId: activeLock.id,
        action: 'add_user',
        targetUser: targetUser.trim(),
      })
    );
    setActiveLock({
      ...activeLock,
      allowedUsers: [...activeLock.allowedUsers, targetUser.trim()],
    });
    setLockNewUser('');
  };

  const handleLockRemoveUser = (targetUser: string) => {
    if (!activeLock || !wsRef.current) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'lock:manage',
        lockId: activeLock.id,
        action: 'remove_user',
        targetUser,
      })
    );
    setActiveLock({
      ...activeLock,
      allowedUsers: activeLock.allowedUsers.filter((u) => u.toLowerCase() !== targetUser.toLowerCase()),
    });
  };

  const handleLockBreak = () => {
    if (!activeLock || !wsRef.current) return;
    if (confirm('Are you sure you want to reclaim this lock? It will unprotect this area!')) {
      wsRef.current.send(
        JSON.stringify({
          type: 'block:mine',
          tx: activeLock.tx,
          ty: activeLock.ty,
        })
      );
      setActiveLock(null);
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative select-none font-sans overflow-hidden bg-stone-950 text-stone-100">
      {/* 1. STARTING / TITLE SCREEN */}
      {screen === 'TITLE' && (
        <div className="mmo-screen-overlay">
          <div className="mmo-screen-card animate-fadeIn">
            <div className="mmo-logo">
              <h1>GROWPIXEL</h1>
              <div className="subtitle">Massively Multiplayer Pixel Sandbox</div>
            </div>

            <div className="mmo-badge-row">
              <span className="mmo-badge">🌍 Real-time MMO</span>
              <span className="mmo-badge">🔒 4-Tier Territory Locks</span>
              <span className="mmo-badge">💎 Persistent Accounts</span>
            </div>

            {currentUser ? (
              <div className="bg-stone-900/80 p-4 rounded border border-stone-700 flex flex-col gap-2">
                <div className="text-xs text-stone-400">Signed in as:</div>
                <div className="text-lg font-bold text-amber-300 flex items-center justify-between">
                  <span>👤 {currentUser.username}</span>
                  <span className="text-emerald-400 text-sm">◆ {currentUser.gems} Gems</span>
                </div>
                <button onClick={() => setScreen('HUB')} className="btn-arcade mt-2">
                  ▶ CONTINUE TO WORLD HUB
                </button>
                <button onClick={() => setScreen('AUTH')} className="btn-secondary">
                  SWITCH ACCOUNT / RE-LOGIN
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 mt-2">
                <button
                  onClick={() => {
                    setAuthMode('LOGIN');
                    setScreen('AUTH');
                  }}
                  className="btn-arcade text-center"
                >
                  ▶ PLAY / CONNECT ACCOUNT
                </button>
                <button
                  onClick={() => {
                    setAuthMode('REGISTER');
                    setScreen('AUTH');
                  }}
                  className="btn-secondary text-center"
                >
                  CREATE NEW ACCOUNT
                </button>
              </div>
            )}

            <div className="text-[11px] text-stone-400 text-center leading-relaxed mt-2 border-t border-stone-800 pt-3">
              Explore shared worlds, farm trees, mine rare gems, and protect your builds with territory locks!
            </div>
          </div>
        </div>
      )}

      {/* 2. ACCOUNT LOGIN / REGISTER SCREEN */}
      {screen === 'AUTH' && (
        <div className="mmo-screen-overlay">
          <div className="mmo-screen-card">
            <div className="mmo-logo">
              <h1>GROWPIXEL</h1>
              <div className="subtitle">
                {authMode === 'LOGIN' ? 'Account Login' : 'Create GrowPixel Account'}
              </div>
            </div>

            <div className="tab-group">
              <button
                type="button"
                className={`tab-btn ${authMode === 'LOGIN' ? 'active' : ''}`}
                onClick={() => {
                  setAuthMode('LOGIN');
                  setAuthError('');
                }}
              >
                LOG IN
              </button>
              <button
                type="button"
                className={`tab-btn ${authMode === 'REGISTER' ? 'active' : ''}`}
                onClick={() => {
                  setAuthMode('REGISTER');
                  setAuthError('');
                }}
              >
                REGISTER
              </button>
            </div>

            {authError && <div className="mmo-error">{authError}</div>}
            {authSuccess && <div className="mmo-success">{authSuccess}</div>}

            {/* One-Time Recovery Code Presentation after Registration */}
            {registeredRecoveryCode && (
              <div className="p-3 mb-3 bg-amber-950/80 border-2 border-amber-500 rounded-lg text-left">
                <div className="flex items-center gap-2 text-amber-300 font-bold text-xs mb-1">
                  <span>🔐</span>
                  <span>SAVE YOUR ONE-TIME RECOVERY CODE</span>
                </div>
                <p className="text-[11px] text-amber-200/90 leading-tight mb-2">
                  This code can be used to reset your password if forgotten. <strong>It will not be shown again!</strong>
                </p>
                <div className="flex items-center justify-between bg-stone-950 p-2 rounded border border-amber-700/60 font-mono text-amber-400 text-xs tracking-wider">
                  <span>{registeredRecoveryCode}</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(registeredRecoveryCode);
                      setCopiedRecovery(true);
                      setTimeout(() => setCopiedRecovery(false), 2000);
                    }}
                    className="ml-2 px-2 py-0.5 bg-amber-600 hover:bg-amber-500 text-stone-950 text-[10px] font-bold rounded"
                  >
                    {copiedRecovery ? 'COPIED!' : 'COPY'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setRegisteredRecoveryCode(null)}
                  className="w-full mt-2 text-[10px] text-amber-300 hover:text-amber-100 underline text-center"
                >
                  I have saved this code safely ✓
                </button>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3">
              <div>
                <label className="input-label">USERNAME (3-16 CHARS)</label>
                <input
                  type="text"
                  maxLength={16}
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  placeholder="e.g. PixelHero"
                  className="mmo-input"
                  autoComplete="username"
                  required
                />
              </div>

              <div>
                <label className="input-label">PASSWORD (MIN 8 CHARS)</label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mmo-input"
                  autoComplete={authMode === 'LOGIN' ? 'current-password' : 'new-password'}
                  required
                />
              </div>

              {authMode === 'REGISTER' && (
                <div>
                  <label className="input-label">CONFIRM PASSWORD</label>
                  <input
                    type="password"
                    value={authConfirmPassword}
                    onChange={(e) => setAuthConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    className="mmo-input"
                    autoComplete="new-password"
                    required
                  />
                </div>
              )}

              <button type="submit" className="btn-arcade mt-2">
                {authMode === 'LOGIN' ? '🔓 LOG IN & PLAY' : '✨ CREATE ACCOUNT & ENTER'}
              </button>

              {authMode === 'LOGIN' && (
                <button
                  type="button"
                  onClick={() => {
                    setShowRecoveryModal(true);
                    setRecoveryError('');
                    setRecoverySuccess('');
                  }}
                  className="text-[11px] text-stone-400 hover:text-amber-300 underline text-center py-1"
                >
                  Forgot password? Use recovery code
                </button>
              )}

              <button
                type="button"
                onClick={() => setScreen('TITLE')}
                className="btn-secondary"
              >
                ◀ BACK TO TITLE
              </button>
            </form>
          </div>

          {/* Account Recovery Modal */}
          {showRecoveryModal && (
            <div id="modalback" className="open">
              <div className="modal max-w-sm text-left">
                <div className="modalhead">
                  <h2>ACCOUNT RECOVERY</h2>
                  <button className="closebtn" onClick={() => setShowRecoveryModal(false)}>✕</button>
                </div>
                <p className="text-xs text-stone-300 mb-3">
                  Enter your one-time recovery code and set a new password. The code will be invalidated upon use.
                </p>

                {recoveryError && <div className="mmo-error mb-2">{recoveryError}</div>}
                {recoverySuccess && <div className="mmo-success mb-2">{recoverySuccess}</div>}

                <form onSubmit={handleRecoverSubmit} className="flex flex-col gap-3">
                  <div>
                    <label className="input-label">RECOVERY CODE</label>
                    <input
                      type="text"
                      value={recoveryInputCode}
                      onChange={(e) => setRecoveryInputCode(e.target.value)}
                      placeholder="e.g. 7f9a12c4..."
                      className="mmo-input font-mono text-xs"
                      required
                    />
                  </div>
                  <div>
                    <label className="input-label">NEW PASSWORD (MIN 8 CHARS)</label>
                    <input
                      type="password"
                      value={recoveryNewPassword}
                      onChange={(e) => setRecoveryNewPassword(e.target.value)}
                      placeholder="••••••••"
                      className="mmo-input"
                      required
                    />
                  </div>
                  <button type="submit" className="btn-arcade mt-2">
                    🔑 RESET PASSWORD &amp; LOGIN
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRecoveryModal(false)}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. WORLD MENU HUB SCREEN */}
      {screen === 'HUB' && (
        <div className="mmo-screen-overlay">
          <div className="mmo-screen-card max-w-lg">
            {/* User Header */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-800">
              <div className="flex items-center gap-2">
                <span className="text-xl">👤</span>
                <div>
                  <div className="text-sm font-bold text-amber-200">{currentUser?.username || 'Guest'}</div>
                  <div className="text-[10px] text-stone-400">GrowPixel Explorer</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="bg-stone-900 border border-emerald-800 px-3 py-1 rounded text-emerald-300 font-bold text-xs flex items-center gap-1">
                  <span>◆</span>
                  <span>{currentUser?.gems ?? 0}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="text-[10px] text-stone-400 hover:text-stone-200 underline"
                >
                  Sign Out
                </button>
              </div>
            </div>

            {/* World Search / Join / Create Input */}
            <div>
              <label className="input-label">WORLD NAME</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  maxLength={24}
                  value={worldSearch}
                  onChange={(e) => setWorldSearch(e.target.value.toUpperCase())}
                  placeholder="ENTER WORLD NAME"
                  className="mmo-input flex-1"
                />
              </div>
            </div>

            {/* Dynamic Action Button: Create or Join */}
            {worldStatus ? (
              worldStatus.exists ? (
                <button
                  onClick={() => handleJoinWorld(worldStatus.name)}
                  className="btn-arcade flex items-center justify-between"
                >
                  <span>🚀 JOIN WORLD: {worldStatus.name}</span>
                  <span className="text-xs font-normal opacity-90">
                    ({worldStatus.playersCount} online · {worldStatus.worldOwner ? `Owner: ${worldStatus.worldOwner}` : 'Unclaimed'})
                  </span>
                </button>
              ) : (
                <button
                  onClick={() => handleJoinWorld(worldStatus.name)}
                  className="btn-arcade"
                  style={{
                    background: 'linear-gradient(180deg, #6ee2a8, #2a8a5b)',
                    borderColor: '#a3f7cb',
                  }}
                >
                  ✨ CREATE NEW WORLD: {worldStatus.name}
                </button>
              )
            ) : (
              <button
                onClick={() => handleJoinWorld(worldSearch || 'START')}
                className="btn-arcade"
              >
                ENTER WORLD
              </button>
            )}

            {/* Featured Public Worlds */}
            <div className="mt-1">
              <div className="text-[10px] font-bold tracking-wider text-stone-400 uppercase mb-2">
                Featured Shared Worlds
              </div>
              <div className="world-card-list">
                {featuredWorlds.map((w) => (
                  <button
                    key={w.name}
                    onClick={() => handleJoinWorld(w.name)}
                    className="world-row-btn"
                  >
                    <div className="text-left">
                      <strong>🌐 {w.name}</strong>
                      <small className="block">
                        {w.owner ? `👑 Owned by ${w.owner}` : '🔓 Unclaimed Wilderness'}
                      </small>
                    </div>
                    <div className="text-emerald-400 font-bold text-xs bg-emerald-950/60 px-2.5 py-1 rounded border border-emerald-800">
                      👥 {w.players} Online
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-stone-800 text-[10px] text-stone-400">
              <span>Server: Connected · Port 3000</span>
              <button
                onClick={() => setScreen('TITLE')}
                className="hover:text-stone-200 underline"
              >
                Back to Title
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. GAME CANVAS */}
      <canvas id="game" tabIndex={0} aria-label="GrowPixel MMO World" />

      {/* 5. IN-GAME TOPBAR */}
      {screen === 'GAME' && (
        <>
          <div id="topbar">
            {/* World Brand / Name Badge */}
            <button
              type="button"
              className="brand"
              onClick={() => setIsMenuOpen(true)}
              aria-label="World Settings"
            >
              <span className="mark">🌐</span>
              <span className="font-extrabold text-amber-200">
                {inGameWorldName || targetWorld}
              </span>
              <span className="text-[10px] text-stone-400 ml-1">
                {inGameWorldOwner
                  ? inGameWorldOwner.toLowerCase() === currentUser?.username.toLowerCase()
                    ? '👑 [YOU OWN]'
                    : `👑 [${inGameWorldOwner}]`
                  : '🔓 [UNCLAIMED]'}
              </span>
            </button>

            {/* Gem Store Button in Topbar */}
            <button
              type="button"
              className="brand"
              onClick={() => setIsGemStoreOpen(true)}
              aria-label="Open Gem Store"
            >
              <span className="mark gem-mark">◆</span>
              <span className="gem-store-label">GEM STORE</span>
              <span className="gem-total">{currentUser?.gems ?? 0}</span>
            </button>

            {/* Online Players Button */}
            <button
              type="button"
              className="action"
              onClick={() => setShowPlayersList(!showPlayersList)}
            >
              👥 {onlineCount} Online
            </button>
          </div>

          <div id="actions">
            <button
              className="action"
              onClick={() => setChatOpen(!chatOpen)}
            >
              💬 Chat
            </button>
            <button
              className="action primary"
              onClick={() => setIsMenuOpen(true)}
            >
              ☰ Menu
            </button>
          </div>

          {/* Chat Bar Overlay */}
          {chatOpen && (
            <form id="chatBar" onSubmit={handleSendChat}>
              <input
                id="chatInput"
                type="text"
                maxLength={90}
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
                placeholder="Say something to the world... (Press Enter to send)"
                autoFocus
              />
              <button id="chatSendBtn" type="submit">
                SEND
              </button>
            </form>
          )}

          {/* Gem Store Modal (Accessible from topbar) */}
          {isGemStoreOpen && (
            <div id="modalback" className="open">
              <div className="modal">
                <div className="modalhead">
                  <div>
                    <h2>GEM STORE</h2>
                    <p>Spend gems to purchase territory locks &amp; tools</p>
                  </div>
                  <button
                    className="closebtn"
                    onClick={() => setIsGemStoreOpen(false)}
                  >
                    ✕
                  </button>
                </div>

                <div className="gem-wallet">
                  <div className="gem-wallet-icon">◆</div>
                  <div>
                    <small>CURRENT BALANCE</small>
                    <strong>{currentUser?.gems ?? 0} GEMS</strong>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="invitem">
                    <img src={getItemTextureUrl('small_lock', 34)} alt="Small Lock" className="item-icon" />
                    <b>Small Lock</b>
                    <small className="text-[10px] text-stone-400">Protects 3x3 Area</small>
                    <button
                      onClick={() => handleBuyItem('small_lock', 10)}
                      className="btn-arcade mt-1 text-xs py-1 px-3"
                    >
                      Buy: 10 Gems
                    </button>
                  </div>

                  <div className="invitem">
                    <img src={getItemTextureUrl('medium_lock', 34)} alt="Medium Lock" className="item-icon" />
                    <b>Medium Lock</b>
                    <small className="text-[10px] text-stone-400">Protects 7x7 Area</small>
                    <button
                      onClick={() => handleBuyItem('medium_lock', 50)}
                      className="btn-arcade mt-1 text-xs py-1 px-3"
                    >
                      Buy: 50 Gems
                    </button>
                  </div>

                  <div className="invitem">
                    <img src={getItemTextureUrl('big_lock', 34)} alt="Big Lock" className="item-icon" />
                    <b>Big Lock</b>
                    <small className="text-[10px] text-stone-400">Protects 11x11 Area</small>
                    <button
                      onClick={() => handleBuyItem('big_lock', 200)}
                      className="btn-arcade mt-1 text-xs py-1 px-3"
                    >
                      Buy: 200 Gems
                    </button>
                  </div>

                  <div className="invitem">
                    <img src={getItemTextureUrl('world_lock', 34)} alt="World Lock" className="item-icon" />
                    <b>World Lock</b>
                    <small className="text-[10px] text-stone-400">Own Entire World!</small>
                    <button
                      onClick={() => handleBuyItem('world_lock', 500)}
                      className="btn-arcade mt-1 text-xs py-1 px-3"
                    >
                      Buy: 500 Gems
                    </button>
                  </div>
                </div>

                <button
                  onClick={() => setIsGemStoreOpen(false)}
                  className="btn-secondary w-full"
                >
                  Close Store
                </button>
              </div>
            </div>
          )}

          {/* INVENTORY MODAL (Opened via Bag button on hotbar) */}
          {isInventoryOpen && (
            <div id="modalback" className="open">
              <div className="modal">
                <div className="modalhead">
                  <div>
                    <h2>PLAYER INVENTORY</h2>
                    <p>Select an item to add to your quick-access toolbar</p>
                  </div>
                  <button className="closebtn" onClick={() => setIsInventoryOpen(false)}>
                    ✕
                  </button>
                </div>

                {Object.entries(currentUser?.inventory || {}).filter(([_, qty]) => (qty || 0) > 0).length === 0 ? (
                  <div className="empty-inventory">
                    <span>🎒</span>
                    <strong>Your Inventory is Empty</strong>
                    <p>Punch trees, harvest crops, and mine blocks to collect materials!</p>
                  </div>
                ) : (
                  <div className="modalgrid mb-4">
                    {Object.entries(currentUser?.inventory || {})
                      .filter(([_, qty]) => (qty || 0) > 0)
                      .map(([itemId, qty]) => (
                        <button
                          key={itemId}
                          type="button"
                          className="invitem hover:border-amber-400 transition"
                          onClick={() => {
                            addToRecentSlots(itemId);
                            setSelectedItem(itemId);
                            setIsInventoryOpen(false);
                          }}
                        >
                          <img
                            src={getItemTextureUrl(itemId, 36)}
                            alt={defs[itemId]?.name || itemId}
                            className="item-icon"
                          />
                          <b>{defs[itemId]?.name || itemId}</b>
                          <span className="text-amber-200 font-bold text-xs">Qty: {qty}</span>
                        </button>
                      ))}
                  </div>
                )}

                <button
                  onClick={() => setIsInventoryOpen(false)}
                  className="btn-secondary w-full"
                >
                  Close Bag
                </button>
              </div>
            </div>
          )}

          {/* Lock Management Modal */}
          {activeLock && (
            <div id="modalback" className="open">
              <div className="modal">
                <div className="modalhead">
                  <div>
                    <h2>LOCK SETTINGS</h2>
                    <p className="capitalize">
                      {activeLock.type.replace('_', ' ')} at ({activeLock.tx}, {activeLock.ty})
                    </p>
                  </div>
                  <button className="closebtn" onClick={() => setActiveLock(null)}>
                    ✕
                  </button>
                </div>

                <div className="bg-stone-900 p-3 rounded mb-3 text-xs">
                  <div>
                    <strong>Owner:</strong> <span className="text-amber-300">{activeLock.owner}</span>
                  </div>
                  <div>
                    <strong>Protection Area:</strong>{' '}
                    {activeLock.type === 'world_lock'
                      ? 'Entire World'
                      : activeLock.type === 'small_lock'
                      ? '3x3 Area'
                      : activeLock.type === 'medium_lock'
                      ? '7x7 Area'
                      : '11x11 Area'}
                  </div>
                </div>

                <div className="mb-3">
                  <label className="input-label">ALLOWED PLAYERS (ACCESS LIST)</label>
                  {activeLock.allowedUsers.length === 0 ? (
                    <div className="text-stone-400 text-xs italic p-2 border border-dashed border-stone-700 rounded mb-2">
                      No other players have access yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1 mb-2">
                      {activeLock.allowedUsers.map((u) => (
                        <div key={u} className="flex justify-between items-center bg-stone-900 px-2 py-1 rounded text-xs">
                          <span>👤 {u}</span>
                          <button
                            onClick={() => handleLockRemoveUser(u)}
                            className="text-red-400 hover:text-red-300 text-[10px]"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Friend's Username"
                      value={lockNewUser}
                      onChange={(e) => setLockNewUser(e.target.value)}
                      className="mmo-input text-xs py-1"
                    />
                    <button
                      onClick={() => handleLockAddUser(lockNewUser)}
                      className="btn-arcade text-xs py-1 px-3 whitespace-nowrap"
                    >
                      + Grant Access
                    </button>
                  </div>
                </div>

                <div className="flex gap-2 border-t border-stone-800 pt-3">
                  <button
                    onClick={handleLockBreak}
                    className="btn-secondary text-red-300 border-red-800 flex-1"
                  >
                    🗑️ Reclaim / Break Lock
                  </button>
                  <button
                    onClick={() => setActiveLock(null)}
                    className="btn-secondary flex-1"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Inspect Player Modal */}
          {inspectPlayer && (
            <div id="modalback" className="open">
              <div className="modal max-w-xs text-center">
                <div className="text-3xl mb-2">👤</div>
                <h2 className="text-base font-bold text-amber-200">{inspectPlayer.username}</h2>
                <div className="text-xs text-stone-400 mb-3">
                  {inspectPlayer.isOwner ? '👑 World Owner' : 'Resident Explorer'}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setChatMessage(`/w ${inspectPlayer.username} `);
                      setChatOpen(true);
                      setInspectPlayer(null);
                    }}
                    className="btn-arcade text-xs py-1 px-3 flex-1"
                  >
                    Say Hello
                  </button>
                  <button
                    onClick={() => setInspectPlayer(null)}
                    className="btn-secondary text-xs py-1 px-3 flex-1"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Online Players Drawer Modal */}
          {showPlayersList && (
            <div id="modalback" className="open">
              <div className="modal max-w-sm">
                <div className="modalhead">
                  <h2>ONLINE PLAYERS ({onlineCount})</h2>
                  <button className="closebtn" onClick={() => setShowPlayersList(false)}>✕</button>
                </div>
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                  <div className="p-2 bg-stone-900 rounded flex items-center justify-between text-xs">
                    <span className="font-bold text-amber-300">👤 {currentUser?.username || 'You'} (You)</span>
                    <span className="text-emerald-400 font-semibold">Local Player</span>
                  </div>
                  {Array.from(playersInRoom).map((p) => (
                    <div key={p.id} className="p-2 bg-stone-900/60 rounded flex items-center justify-between text-xs">
                      <span>👤 {p.username}</span>
                      <span className="text-stone-400 text-[10px]">Active</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* IN-GAME MENU MODAL (No Gem Store option per specifications; Fullscreen toggle & Exit World included) */}
          {isMenuOpen && (
            <div id="modalback" className="open">
              <div className="modal">
                <div className="modalhead">
                  <h2>GAME MENU</h2>
                  <button className="closebtn" onClick={() => setIsMenuOpen(false)}>✕</button>
                </div>
                <div className="flex flex-col gap-3">
                  {/* Fullscreen Toggle Option (Requirement 5) */}
                  <button
                    onClick={handleToggleFullscreen}
                    className="btn-secondary text-left flex items-center justify-between"
                  >
                    <span>⛶ Toggle Fullscreen</span>
                    <span className="text-amber-300 font-bold">{isFullscreen ? 'ON' : 'OFF'}</span>
                  </button>

                  {/* Exit World Option (Requirement 10 & Feedback: strictly read as "Exit World") */}
                  <button
                    onClick={() => {
                      setIsMenuOpen(false);
                      setShowExitModal(true);
                    }}
                    className="btn-arcade text-left"
                    style={{ background: 'linear-gradient(180deg, #e29050, #934a1b)' }}
                  >
                    🚪 Exit World
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* EXIT WORLD CONFIRMATION MODAL */}
          {showExitModal && (
            <div id="modalback" className="open">
              <div className="modal max-w-sm text-center">
                <div className="modalhead justify-center">
                  <h2>EXIT WORLD</h2>
                </div>
                <p className="text-xs text-stone-300 mb-4">
                  Are you sure you want to exit <strong>{inGameWorldName || targetWorld}</strong> and return to the World Hub?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowExitModal(false);
                      setIsMenuOpen(false);
                      setScreen('HUB');
                    }}
                    className="btn-arcade flex-1"
                    style={{ background: 'linear-gradient(180deg, #e29050, #934a1b)' }}
                  >
                    🚪 Exit World
                  </button>
                  <button
                    onClick={() => setShowExitModal(false)}
                    className="btn-secondary flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* FIXED 3-SLOT RECENT-ITEM TOOLBAR WITH SEPARATE FIST CONTROL (Requirements 6, 7, 8, 9) */}
          <div id="hotbar" role="toolbar" aria-label="Game Quick-Access Toolbar">
            {/* Separate Fist Control Button (Requirement 8) */}
            <button
              type="button"
              className={`slot fist-slot ${selectedItem === 'fist' ? 'active' : ''}`}
              onClick={() => setSelectedItem('fist')}
              aria-label="Fist Control"
              title="Fist (Mine / Punch)"
            >
              <span className="fist-icon">✊</span>
              <span className="text-[8px] font-bold">Fist</span>
            </button>

            {/* Exactly 3 Recent-Item Slots (Requirements 6, 7, 9) */}
            {recentSlots.map((slotId, idx) => {
              const qty = slotId ? currentUser?.inventory[slotId] || 0 : 0;
              const isEmpty = !slotId || qty <= 0;

              if (isEmpty) {
                return (
                  <button
                    key={`slot-empty-${idx}`}
                    type="button"
                    className="slot empty-slot"
                    disabled
                    aria-label={`Empty Toolbar Slot ${idx + 1}`}
                  />
                );
              }

              const isActive = selectedItem === slotId;
              return (
                <button
                  key={`slot-${slotId}-${idx}`}
                  type="button"
                  className={`slot ${isActive ? 'active' : ''}`}
                  onClick={() => setSelectedItem(slotId)}
                  title={defs[slotId]?.name || slotId}
                >
                  <img
                    src={getItemTextureUrl(slotId, 32)}
                    alt={defs[slotId]?.name || slotId}
                    className="item-icon"
                  />
                  <span className="count">{qty}</span>
                </button>
              );
            })}

            {/* Separate Inventory Bag Button */}
            <button
              type="button"
              className="slot inventory-slot"
              onClick={() => setIsInventoryOpen(true)}
              aria-label="Open Inventory Bag"
              title="Open Inventory Bag"
            >
              <span className="bag-icon">▦</span>
              <span className="text-[8px] font-bold">Bag</span>
            </button>
          </div>


          {/* Mobile On-Screen Joystick & Jump Button */}
          <div id="mobile">
            <div className="pad">
              <div
                className="joystick"
                onTouchStart={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const t = e.touches[0];
                  if (!t) return;
                  const relX = t.clientX - (rect.left + rect.width / 2);
                  mobileInputRef.current.left = relX < -15;
                  mobileInputRef.current.right = relX > 15;
                }}
                onTouchMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const t = e.touches[0];
                  if (!t) return;
                  const relX = t.clientX - (rect.left + rect.width / 2);
                  mobileInputRef.current.left = relX < -15;
                  mobileInputRef.current.right = relX > 15;
                }}
                onTouchEnd={() => {
                  mobileInputRef.current.left = false;
                  mobileInputRef.current.right = false;
                }}
              >
                <div
                  className="joyknob"
                  style={{
                    transform: mobileInputRef.current.left
                      ? 'translateX(-32px)'
                      : mobileInputRef.current.right
                      ? 'translateX(32px)'
                      : 'translateX(0)',
                  }}
                />
              </div>
            </div>
            <div className="pad right-controls">
              <button
                className="mbtn jump"
                onTouchStart={() => { mobileInputRef.current.jump = true; }}
                onTouchEnd={() => { mobileInputRef.current.jump = false; }}
                onMouseDown={() => { mobileInputRef.current.jump = true; }}
                onMouseUp={() => { mobileInputRef.current.jump = false; }}
                aria-label="Jump"
              >
                ▲
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
