// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock the database module before importing the middleware (it reads the JWT
// secret at import time and looks up users at runtime).
const TEST_SECRET = 'test-jwt-secret';
const TEST_USER = { id: 1, username: 'alice' };

vi.mock('../modules/database/index.js', () => ({
  appConfigDb: { getOrCreateJwtSecret: () => TEST_SECRET },
  usersDb: {
    getUserById: (id) => (Number(id) === TEST_USER.id ? TEST_USER : null),
    getFirstUser: () => TEST_USER,
  },
}));

vi.mock('../constants/config.js', () => ({ IS_PLATFORM: false }));

const {
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
  authenticateToken,
} = await import('./auth.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
  };
  return res;
};

describe('refresh token', () => {
  it('generateRefreshToken produces a token that verifyRefreshToken accepts', () => {
    const rt = generateRefreshToken(TEST_USER);
    const user = verifyRefreshToken(rt);
    expect(user).toEqual(TEST_USER);
  });

  it('rejects an access token passed as a refresh token (wrong type claim)', () => {
    const accessToken = generateToken(TEST_USER);
    expect(() => verifyRefreshToken(accessToken)).toThrow();
  });

  it('rejects an expired refresh token', () => {
    const expired = jwt.sign(
      { userId: TEST_USER.id, username: TEST_USER.username, type: 'refresh' },
      TEST_SECRET,
      { expiresIn: -10 },
    );
    expect(() => verifyRefreshToken(expired)).toThrow();
  });

  it('rejects a refresh token for a non-existent user', () => {
    const rt = jwt.sign(
      { userId: 999, username: 'ghost', type: 'refresh' },
      TEST_SECRET,
      { expiresIn: '30d' },
    );
    expect(() => verifyRefreshToken(rt)).toThrow();
  });
});

describe('authenticateToken with expired access token', () => {
  it('returns 401 (recoverable) when the access token is expired', async () => {
    const expired = jwt.sign(
      { userId: TEST_USER.id, username: TEST_USER.username, type: 'access' },
      TEST_SECRET,
      { expiresIn: -10 },
    );
    const req = { headers: { authorization: `Bearer ${expired}` }, query: {} };
    const res = makeRes();
    let nextCalled = false;
    await authenticateToken(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('token_expired');
  });

  it('returns 403 when the access token signature is invalid', async () => {
    const badToken = jwt.sign(
      { userId: TEST_USER.id, username: TEST_USER.username, type: 'access' },
      'wrong-secret',
      { expiresIn: '1h' },
    );
    const req = { headers: { authorization: `Bearer ${badToken}` }, query: {} };
    const res = makeRes();
    let nextCalled = false;
    await authenticateToken(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('calls next() for a valid access token', async () => {
    const good = generateToken(TEST_USER);
    const req = { headers: { authorization: `Bearer ${good}` }, query: {} };
    const res = makeRes();
    let nextCalled = false;
    await authenticateToken(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.user).toEqual(TEST_USER);
  });
});
