// Integration Test — ShrikDB Migration
// Tests: health, signup, login, refresh, projects, datasets, jobs, models, eval, guardrails
// Run: npx ts-node --esm src/test-integration.ts

import http from 'http';

const BASE = 'http://localhost:3000';

let accessToken = '';
let refreshToken = '';
let userId = '';
let projectId = '';
let datasetId = '';
let jobId = '';
let modelId = '';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg, duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  console.log('\n🧪 ShrikDB Migration — Integration Tests\n');

  // ── Health ────────────────────────────────────────
  console.log('── Health ──');
  await test('GET /health returns 200', async () => {
    const { status, data } = await request('GET', '/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data['status'] === 'ok', `Expected status ok, got ${data['status']}`);
  });

  // ── Auth: Signup ──────────────────────────────────
  console.log('\n── Auth ──');
  const email = `test-${Date.now()}@modelforge.dev`;
  
  await test('POST /auth/signup — creates user', async () => {
    const { status, data } = await request('POST', '/auth/signup', {
      name: 'Test User',
      email,
      password: 'StrongP@ss1!',
      role: 'RESEARCHER',
    });
    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    assert(typeof data['accessToken'] === 'string', 'Missing accessToken');
    assert(typeof data['refreshToken'] === 'string', 'Missing refreshToken');
    accessToken = data['accessToken'] as string;
    refreshToken = data['refreshToken'] as string;
    const user = data['user'] as Record<string, unknown>;
    userId = user['id'] as string;
    assert(typeof userId === 'string', 'Missing user.id');
  });

  await test('POST /auth/signup — duplicate email returns 409', async () => {
    const { status } = await request('POST', '/auth/signup', {
      name: 'Dup',
      email,
      password: 'AnotherP@ss1!',
    });
    assert(status === 409, `Expected 409, got ${status}`);
  });

  await test('POST /auth/signup — invalid input returns 400', async () => {
    const { status } = await request('POST', '/auth/signup', { name: 'x' });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  // ── Auth: Login ───────────────────────────────────
  await test('POST /auth/login — valid credentials', async () => {
    const { status, data } = await request('POST', '/auth/login', { email, password: 'StrongP@ss1!' });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    accessToken = data['accessToken'] as string;
    refreshToken = data['refreshToken'] as string;
  });

  await test('POST /auth/login — wrong password returns 401', async () => {
    const { status } = await request('POST', '/auth/login', { email, password: 'WrongPass1!' });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test('POST /auth/login — non-existent email returns 401', async () => {
    const { status } = await request('POST', '/auth/login', { email: 'nobody@x.com', password: 'X' });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  // ── Auth: Refresh ─────────────────────────────────
  await test('POST /auth/refresh — rotates access token', async () => {
    const { status, data } = await request('POST', '/auth/refresh', { refreshToken });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    accessToken = data['accessToken'] as string;
    assert(typeof accessToken === 'string', 'Missing accessToken');
  });

  await test('POST /auth/refresh — reuse detection returns 401', async () => {
    // The same refreshToken was already used — should be rejected
    const { status } = await request('POST', '/auth/refresh', { refreshToken });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  // Need a fresh login since refresh invalidated tokens
  const freshLogin = await request('POST', '/auth/login', { email, password: 'StrongP@ss1!' });
  accessToken = freshLogin.data['accessToken'] as string;

  // ── Projects ──────────────────────────────────────
  console.log('\n── Projects ──');
  await test('POST /projects — creates project', async () => {
    const { status, data } = await request('POST', '/projects', { name: 'Test Project Alpha' }, accessToken);
    assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    projectId = data['id'] as string;
    assert(typeof projectId === 'string', 'Missing project id');
  });

  await test('GET /projects — lists user projects', async () => {
    const { status, data } = await request('GET', '/projects', undefined, accessToken);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), 'Expected array');
  });

  await test('POST /projects — invalid input returns 400', async () => {
    const { status } = await request('POST', '/projects', { name: '' }, accessToken);
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('GET /projects — no auth returns 401', async () => {
    const { status } = await request('GET', '/projects');
    assert(status === 401, `Expected 401, got ${status}`);
  });

  // ── Jobs ──────────────────────────────────────────
  console.log('\n── Jobs ──');
  await test('POST /jobs/train — missing fields returns 400', async () => {
    const { status } = await request('POST', '/jobs/train', { projectId }, accessToken);
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('POST /jobs/train — non-existent project returns 404', async () => {
    const { status } = await request('POST', '/jobs/train', {
      projectId: '00000000-0000-0000-0000-000000000000',
      datasetId: '00000000-0000-0000-0000-000000000000',
      modelName: 'test', method: 'finetune',
    }, accessToken);
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ── Eval ──────────────────────────────────────────
  console.log('\n── Eval ──');
  await test('GET /eval/:modelId — non-existent returns 404', async () => {
    const { status } = await request('GET', '/eval/nonexistent', undefined, accessToken);
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ── Guardrails ────────────────────────────────────
  console.log('\n── Guardrails ──');
  await test('POST /guardrails — non-existent model returns 404', async () => {
    const { status } = await request('POST', '/guardrails', {
      modelId: 'nonexistent',
      rules: { maxTokens: 100 },
    }, accessToken);
    assert(status === 404, `Expected 404, got ${status}`);
  });

  await test('GET /guardrails/:modelId — non-existent model returns 404', async () => {
    const { status } = await request('GET', '/guardrails/nonexistent', undefined, accessToken);
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ── 404 Route ─────────────────────────────────────
  console.log('\n── Edge Cases ──');
  await test('Unknown route returns 404', async () => {
    const { status } = await request('GET', '/nonexistent-route');
    assert(status === 404, `Expected 404, got ${status}`);
  });

  await test('Expired/invalid JWT returns 401', async () => {
    const { status } = await request('GET', '/projects', undefined, 'invalid.jwt.token');
    assert(status === 401, `Expected 401, got ${status}`);
  });

  // ── Summary ───────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`   - ${r.name}: ${r.error}`);
    }
  } else {
    console.log('\n✅ All tests passed!');
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Integration test runner crashed:', err);
  process.exit(1);
});
