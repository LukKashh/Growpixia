import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// Pure Logic Units for Supabase & Server Auth Validation
export function validateUsername(username: string): { valid: boolean; error?: string; normalized: string } {
  const clean = (username || '').trim();
  if (!clean || clean.length < 3 || clean.length > 16 || !/^[a-zA-Z0-9_-]+$/.test(clean)) {
    return {
      valid: false,
      error: 'Username must be 3-16 alphanumeric characters, hyphens, or underscores.',
      normalized: clean.toLowerCase(),
    };
  }
  return { valid: true, normalized: clean.toLowerCase() };
}

export function validatePassword(password: string, confirmPassword?: string): { valid: boolean; error?: string } {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long.' };
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return { valid: false, error: 'Passwords do not match.' };
  }
  return { valid: true };
}

export function deriveHmacIdentifier(username: string, secret?: string): string {
  const hmacSecret = secret || process.env.AUTH_HMAC_SECRET;
  if (!hmacSecret) {
    throw new Error('Server configuration error: AUTH_HMAC_SECRET is missing.');
  }
  return crypto.createHmac('sha256', hmacSecret).update(username.toLowerCase().trim()).digest('hex');
}

export function hashPassword(pass: string): string {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

export function generateRecoveryCode(): { code: string; hash: string } {
  const code = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  return { code, hash };
}

describe('GrowPixel Username & Password Auth Pure Logic', () => {
  test('Validates username constraints (3-16 chars, allowed chars)', () => {
    assert.equal(validateUsername('PixelMaster').valid, true);
    assert.equal(validateUsername('p_123-x').valid, true);
    assert.equal(validateUsername('ab').valid, false); // too short (<3)
    assert.equal(validateUsername('12345678901234567').valid, false); // too long (>16)
    assert.equal(validateUsername('invalid!user').valid, false); // special char not allowed
    assert.equal(validateUsername('user with spaces').valid, false);
    assert.equal(validateUsername('  validUser  ').valid, true);
    assert.equal(validateUsername('  validUser  ').normalized, 'validuser');
  });

  test('Validates password constraints (min 8 chars and matching confirmation)', () => {
    assert.equal(validatePassword('short').valid, false);
    assert.equal(validatePassword('12345678').valid, true);
    assert.equal(validatePassword('StrongPass123!', 'StrongPass123!').valid, true);
    assert.equal(validatePassword('StrongPass123!', 'DifferentPass!').valid, false);
  });

  test('HMAC-SHA256 internal identity derivation is deterministic and case-insensitive', () => {
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const id1 = deriveHmacIdentifier('GamerOne', testSecret);
    const id2 = deriveHmacIdentifier('gamerone', testSecret);
    const id3 = deriveHmacIdentifier('  GAMERONE  ', testSecret);
    const idOther = deriveHmacIdentifier('GamerTwo', testSecret);

    assert.equal(id1, id2);
    assert.equal(id2, id3);
    assert.notEqual(id1, idOther);
    assert.equal(id1.length, 64);
  });

  test('Throws server configuration error when AUTH_HMAC_SECRET is missing', () => {
    assert.throws(() => {
      deriveHmacIdentifier('PlayerOne', '');
    }, /Server configuration error: AUTH_HMAC_SECRET is missing/);
  });

  test('Recovery codes are cryptographically unique and their hashes verify accurately', () => {
    const rec1 = generateRecoveryCode();
    const rec2 = generateRecoveryCode();

    assert.notEqual(rec1.code, rec2.code);
    assert.equal(rec1.code.length, 32);
    assert.equal(rec1.hash.length, 64);

    const recomputedHash = crypto.createHash('sha256').update(rec1.code).digest('hex');
    assert.equal(recomputedHash, rec1.hash);
  });
});

describe('Live Edge Functions / HTTP Auth Integration', () => {
  const SERVER_URL = 'http://localhost:3000';
  const testSuffix = Math.random().toString(36).substring(2, 7);
  const testUser = `test_${testSuffix}`;
  const testPass = 'SecureP@ssw0rd123';
  let savedRecoveryCode = '';

  test('POST /functions/v1/register-player creates account and returns session + recovery code', async () => {
    const res = await fetch(`${SERVER_URL}/functions/v1/register-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser,
        password: testPass,
        confirmPassword: testPass,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.username, testUser);
    assert.ok(data.session.access_token);
    assert.ok(data.session.refresh_token);
    assert.ok(data.recoveryCode);
    savedRecoveryCode = data.recoveryCode;
  });

  test('POST /functions/v1/register-player rejects duplicate username (case-insensitive)', async () => {
    const res = await fetch(`${SERVER_URL}/functions/v1/register-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser.toUpperCase(),
        password: testPass,
        confirmPassword: testPass,
      }),
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /already taken/i);
  });

  test('POST /functions/v1/login-player succeeds with valid credentials', async () => {
    const res = await fetch(`${SERVER_URL}/functions/v1/login-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser,
        password: testPass,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.username, testUser);
    assert.ok(data.session.access_token);
  });

  test('POST /functions/v1/login-player prevents enumeration on invalid credentials', async () => {
    // 1. Wrong password
    const resBadPass = await fetch(`${SERVER_URL}/functions/v1/login-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser,
        password: 'IncorrectPassword999',
      }),
    });
    assert.equal(resBadPass.status, 401);
    const dataBadPass = await resBadPass.json();
    assert.equal(dataBadPass.error, 'Invalid username or password.');

    // 2. Non-existent username returns identical message
    const resNonExistent = await fetch(`${SERVER_URL}/functions/v1/login-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'nonexistent_user_99999',
        password: 'SomePassword123',
      }),
    });
    assert.equal(resNonExistent.status, 401);
    const dataNonExistent = await resNonExistent.json();
    assert.equal(dataNonExistent.error, 'Invalid username or password.');
  });

  test('POST /functions/v1/recover-player resets password with valid one-time code', async () => {
    assert.ok(savedRecoveryCode, 'Should have received recovery code during registration');
    const newPassword = 'BrandNewPassword456!';

    const res = await fetch(`${SERVER_URL}/functions/v1/recover-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recoveryCode: savedRecoveryCode,
        newPassword: newPassword,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Old password should now fail
    const oldLoginRes = await fetch(`${SERVER_URL}/functions/v1/login-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser,
        password: testPass,
      }),
    });
    assert.equal(oldLoginRes.status, 401);

    // New password succeeds
    const newLoginRes = await fetch(`${SERVER_URL}/functions/v1/login-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: testUser,
        password: newPassword,
      }),
    });
    assert.equal(newLoginRes.status, 200);
  });

  test('POST /functions/v1/recover-player rejects reused recovery code (single-use enforcement)', async () => {
    const res = await fetch(`${SERVER_URL}/functions/v1/recover-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recoveryCode: savedRecoveryCode,
        newPassword: 'AnotherPassword789!',
      }),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /invalid or already redeemed/i);
  });
});

describe('Multiplayer WebSocket Authoritative Supabase Auth Integration', () => {
  const SERVER_URL = 'http://localhost:3000';
  const WS_URL = 'ws://localhost:3000/ws';

  let player1Token = '';
  let player1User = '';
  let player1Id = '';

  let player2Token = '';
  let player2User = '';
  let player2Id = '';

  test('Registers two test players to obtain valid access tokens', async () => {
    const suffix1 = Math.random().toString(36).substring(2, 7);
    player1User = `ws_p1_${suffix1}`;
    const res1 = await fetch(`${SERVER_URL}/functions/v1/register-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: player1User,
        password: 'Password123!',
        confirmPassword: 'Password123!',
      }),
    });
    const d1 = await res1.json();
    assert.equal(res1.status, 200);
    player1Token = d1.session.access_token;
    player1Id = d1.user.id;

    const suffix2 = Math.random().toString(36).substring(2, 7);
    player2User = `ws_p2_${suffix2}`;
    const res2 = await fetch(`${SERVER_URL}/functions/v1/register-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: player2User,
        password: 'Password123!',
        confirmPassword: 'Password123!',
      }),
    });
    const d2 = await res2.json();
    assert.equal(res2.status, 200);
    player2Token = d2.session.access_token;
    player2Id = d2.user.id;
  });

  test('Rejects WebSocket connection when access token is missing', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'world:join', worldName: 'WSTEST' }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth:error') {
          assert.match(msg.error, /missing/i);
        }
      });
      ws.on('close', (code) => {
        assert.equal(code, 4001);
        ws.terminate();
        resolve();
      });
    });
  });

  test('Rejects WebSocket connection when access token is invalid', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${WS_URL}?token=invalid_token_12345`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'world:join', worldName: 'WSTEST', token: 'invalid_token_12345' }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth:error') {
          assert.match(msg.error, /invalid or expired/i);
        }
      });
      ws.on('close', (code) => {
        assert.equal(code, 4001);
        ws.terminate();
        resolve();
      });
    });
  });

  test('Rejects WebSocket connection when access token is expired', async () => {
    const secret = process.env.AUTH_HMAC_SECRET || 'secret';
    const expiredPayload = Buffer.from(JSON.stringify({ sub: 'expired_user', exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(expiredPayload).digest('base64url');
    const expiredToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${expiredPayload}.${signature}`;

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${WS_URL}?token=${expiredToken}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'world:join', worldName: 'WSTEST', token: expiredToken }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth:error') {
          assert.match(msg.error, /invalid or expired/i);
        }
      });
      ws.on('close', (code) => {
        assert.equal(code, 4001);
        ws.terminate();
        resolve();
      });
    });
  });

  test('Accepts WebSocket connection with valid token and ignores client-supplied fake username', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${WS_URL}?token=${player1Token}`);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'world:join',
          worldName: 'AUTHTESTWORLD',
          token: player1Token,
          user: 'FakeImpersonatedUsername' // Should be ignored by server
        }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init:world') {
          assert.equal(msg.myUsername, player1User, 'Server must return official verified username, not fake user');
          assert.equal(msg.myId, player1Id, 'Server must return official verified userId');
          ws.terminate();
          resolve();
        }
      });
    });
  });

  test('Two authenticated players join same world and synchronize presence', async () => {
    let p1Joined = false;
    let p2Init = false;

    await new Promise<void>((resolve) => {
      const ws1 = new WebSocket(`${WS_URL}?token=${player1Token}`);
      let ws2: WebSocket | null = null;

      const checkDone = () => {
        if (p1Joined && p2Init) {
          try { ws1.terminate(); } catch {}
          try { if (ws2) ws2.terminate(); } catch {}
          resolve();
        }
      };

      ws1.on('open', () => {
        ws1.send(JSON.stringify({ type: 'world:join', worldName: 'MULTIWORLD', token: player1Token }));
      });

      ws1.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init:world') {
          // Player 1 in room, now connect Player 2
          ws2 = new WebSocket(`${WS_URL}?token=${player2Token}`);
          ws2.on('open', () => {
            ws2!.send(JSON.stringify({ type: 'world:join', worldName: 'MULTIWORLD', token: player2Token }));
          });
          ws2.on('message', (raw2) => {
            const msg2 = JSON.parse(raw2.toString());
            if (msg2.type === 'init:world') {
              assert.equal(msg2.myUsername, player2User);
              assert.ok(msg2.players.some((p: any) => p.username === player1User), 'Player 2 must see Player 1 in world players');
              p2Init = true;
              checkDone();
            }
          });
        } else if (msg.type === 'player:joined') {
          // Player 1 receives notification that Player 2 joined
          assert.equal(msg.player.username, player2User);
          p1Joined = true;
          checkDone();
        }
      });
    });
  });

  test('Player identity consistency across reconnects', async () => {
    let initialMyId = '';

    await new Promise<void>((resolve) => {
      const wsFirst = new WebSocket(`${WS_URL}?token=${player1Token}`);
      wsFirst.on('open', () => {
        wsFirst.send(JSON.stringify({ type: 'world:join', worldName: 'RECONNECTWORLD', token: player1Token }));
      });
      wsFirst.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init:world') {
          initialMyId = msg.myId;
          assert.equal(msg.myUsername, player1User);
          wsFirst.terminate();
          resolve();
        }
      });
    });

    await new Promise<void>((resolve) => {
      const wsSecond = new WebSocket(`${WS_URL}?token=${player1Token}`);
      wsSecond.on('open', () => {
        wsSecond.send(JSON.stringify({ type: 'world:join', worldName: 'RECONNECTWORLD', token: player1Token }));
      });
      wsSecond.on('message', (rawSecond) => {
        const msgSecond = JSON.parse(rawSecond.toString());
        if (msgSecond.type === 'init:world') {
          assert.equal(msgSecond.myId, initialMyId, 'Reconnected player ID must be consistent');
          assert.equal(msgSecond.myUsername, player1User);
          wsSecond.terminate();
          resolve();
        }
      });
    });
  });
});

