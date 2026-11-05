import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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
