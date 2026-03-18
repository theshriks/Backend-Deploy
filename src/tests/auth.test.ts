// Auth integration tests — signup, login, refresh, edge cases
// Uses supertest against Express app with mocked ShrikDB (in-memory StateStore)

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { stateStore } from '../lib/state-store';

const testEmail = `test-${Date.now()}@modelforge.dev`;
let accessToken: string;
let refreshToken: string;

beforeAll(async () => {
  await stateStore.initialize('test-project');
});

// ── Signup ──────────────────────────────────────────────

describe('POST /auth/signup', () => {
  it('returns 201 with tokens and user', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: testEmail,
      name: 'Test User',
      password: 'testpass123',
    });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.user.id).toBeDefined();
    // Must never leak passwordHash
    expect(res.body.user.passwordHash).toBeUndefined();

    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('returns 409 on duplicate email', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: testEmail,
      name: 'Duplicate',
      password: 'testpass123',
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 400 on invalid email', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: 'notanemail',
      name: 'Test',
      password: 'testpass123',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('returns 400 on short password (< 8 chars)', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: 'new@test.com',
      name: 'Test',
      password: '123',
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 on short name (< 2 chars)', async () => {
    const res = await request(app).post('/auth/signup').send({
      email: 'new2@test.com',
      name: 'X',
      password: 'testpass123',
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/auth/signup').send({});
    expect(res.status).toBe(400);
  });
});

// ── Login ───────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns 200 with tokens on correct credentials', async () => {
    const res = await request(app).post('/auth/login').send({
      email: testEmail,
      password: 'testpass123',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe(testEmail);

    // Update tokens for subsequent tests
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app).post('/auth/login').send({
      email: testEmail,
      password: 'wrongpassword',
    });

    expect(res.status).toBe(401);
  });

  it('returns 401 on non-existent email — same error message as wrong password', async () => {
    const wrongPwRes = await request(app).post('/auth/login').send({
      email: testEmail,
      password: 'wrongpassword',
    });

    const noUserRes = await request(app).post('/auth/login').send({
      email: 'doesnotexist@test.com',
      password: 'testpass123',
    });

    expect(noUserRes.status).toBe(401);
    // Same error message prevents email enumeration
    expect(wrongPwRes.body.error).toBe(noUserRes.body.error);
  });

  it('returns 400 on missing password', async () => {
    const res = await request(app).post('/auth/login').send({
      email: testEmail,
    });

    expect(res.status).toBe(400);
  });
});

// ── Refresh ─────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns 200 with new accessToken', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('returns 401 on reused refresh token (rotation)', async () => {
    // Same refreshToken used again — should be rejected
    const res = await request(app).post('/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(401);
  });

  it('returns 401 on invalid token string', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-valid-jwt-token' });

    expect(res.status).toBe(401);
  });

  it('returns 400 on missing refreshToken field', async () => {
    const res = await request(app).post('/auth/refresh').send({});

    expect(res.status).toBe(400);
  });
});

// ── Protected route without auth ────────────────────────

describe('Protected route without token', () => {
  it('returns 401 on missing Authorization header', async () => {
    const res = await request(app).get('/projects');

    expect(res.status).toBe(401);
  });

  it('returns 401 on invalid Bearer token', async () => {
    const res = await request(app)
      .get('/projects')
      .set('Authorization', 'Bearer invalid-jwt-garbage');

    expect(res.status).toBe(401);
  });
});
