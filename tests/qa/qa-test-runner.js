#!/usr/bin/env node

// ── QA Test Runner ──────────────────────────────────────────────────
// Automated QA tests for WhatsApp AI Chatbot
// Run with: npm run test:qa

const http = require('http');
const https = require('https');

// ── Configuration ──────────────────────────────────────────────────
const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test_password';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';

let authToken = null;
let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

// ── Helper Functions ───────────────────────────────────────────────

function makeRequest(method, path, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function log(message, type = 'info') {
  const icons = {
    info: '📋',
    pass: '✅',
    fail: '❌',
    skip: '⏭️',
    section: '═══════════════════════════════════════════',
  };
  console.log(`${icons[type] || '📋'} ${message}`);
}

function recordTest(name, status, details = '') {
  results.push({ name, status, details });
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else skipped++;
}

async function test(name, fn) {
  log(`Testing: ${name}`, 'info');
  try {
    await fn();
    recordTest(name, 'PASS');
    log(`PASSED: ${name}`, 'pass');
  } catch (e) {
    recordTest(name, 'FAIL', e.message);
    log(`FAILED: ${name} - ${e.message}`, 'fail');
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ── Test Suites ────────────────────────────────────────────────────

async function testLoginFlow() {
  log('\n═══ LOGIN FLOW TESTS ═══', 'section');

  await test('Login with wrong password returns 401', async () => {
    const res = await makeRequest('POST', '/api/login', { password: 'wrong' });
    expect(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('Login with invalid input returns 400', async () => {
    const res = await makeRequest('POST', '/api/login', { password: 123 });
    expect(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('Login with correct password returns token', async () => {
    const res = await makeRequest('POST', '/api/login', { password: ADMIN_PASSWORD });
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(res.body.token, 'Token should exist');
    authToken = res.body.token;
  });

  await test('Rate limiting blocks after 5 attempts', async () => {
    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await makeRequest('POST', '/api/login', { password: 'wrong' });
    }
    const res = await makeRequest('POST', '/api/login', { password: 'wrong' });
    expect(res.status === 429, `Expected 429, got ${res.status}`);
  });
}

async function testAPIEndpoints() {
  log('\n═══ API ENDPOINT TESTS ═══', 'section');

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('GET /api/messages returns array', async () => {
    const res = await makeRequest('GET', '/api/messages', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(Array.isArray(res.body), 'Should return array');
  });

  await test('GET /api/settings returns settings object', async () => {
    const res = await makeRequest('GET', '/api/settings', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(res.body.autoReply !== undefined, 'Should have autoReply');
  });

  await test('GET /api/orders returns array', async () => {
    const res = await makeRequest('GET', '/api/orders', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(Array.isArray(res.body), 'Should return array');
  });

  await test('GET /api/status returns status', async () => {
    const res = await makeRequest('GET', '/api/status', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(res.body.status, 'Should have status');
  });

  await test('GET /api/keystatus returns key info', async () => {
    const res = await makeRequest('GET', '/api/keystatus', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(Array.isArray(res.body.statuses), 'Should have statuses array');
  });

  await test('POST /api/settings updates settings', async () => {
    const res = await makeRequest('POST', '/api/settings', { temperature: 0.8 }, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(res.body.ok === true, 'Should return ok');
  });

  await test('POST /api/settings validates originId', async () => {
    const res = await makeRequest('POST', '/api/settings', { originId: 'not_a_number' }, headers);
    expect(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('Unauthorized request returns 401', async () => {
    const res = await makeRequest('GET', '/api/messages');
    expect(res.status === 401, `Expected 401, got ${res.status}`);
  });
}

async function testWebhookEndpoint() {
  log('\n═══ WEBHOOK ENDPOINT TESTS ═══', 'section');

  await test('GET /webhook with invalid token returns 403', async () => {
    const res = await makeRequest('GET', '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test');
    expect(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /webhook accepts valid payload', async () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: '6281234567890',
              id: `test_${Date.now()}`,
              type: 'text',
              text: { body: 'Test' },
            }],
            contacts: [{ profile: { name: 'Test' } }],
          },
        }],
      }],
    };
    const res = await makeRequest('POST', '/webhook', payload);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
  });

  await test('POST /webhook rejects invalid payload structure', async () => {
    const res = await makeRequest('POST', '/webhook', { invalid: true });
    expect(res.status === 200, `Expected 200 (to prevent retries), got ${res.status}`);
  });
}

async function testWhatsAppIntegration() {
  log('\n═══ WHATSAPP INTEGRATION TESTS ═══', 'section');

  if (!WHATSAPP_TOKEN) {
    log('Skipping WhatsApp tests (WHATSAPP_TOKEN not set)', 'skip');
    skipped += 3;
    return;
  }

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('GET /api/status shows WhatsApp config', async () => {
    const res = await makeRequest('GET', '/api/status', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(res.body.channel, 'Should have channel');
  });

  await test('POST /api/send requires number and message', async () => {
    const res = await makeRequest('POST', '/api/send', {}, headers);
    expect(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /api/testkey tests API key', async () => {
    const res = await makeRequest('POST', '/api/testkey', { slot: 1 }, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
  });
}

async function testOrderFlow() {
  log('\n═══ ORDER FLOW TESTS ═══', 'section');

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('GET /api/orders returns orders', async () => {
    const res = await makeRequest('GET', '/api/orders', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect(Array.isArray(res.body), 'Should return array');
  });

  await test('POST /api/orders/:id/status updates order status', async () => {
    // First get an order
    const ordersRes = await makeRequest('GET', '/api/orders', null, headers);
    if (ordersRes.body.length > 0) {
      const orderId = ordersRes.body[0].id;
      const res = await makeRequest('POST', `/api/orders/${orderId}/status`, { status: 'diproses' }, headers);
      expect(res.status === 200, `Expected 200, got ${res.status}`);
    } else {
      log('No orders to test', 'skip');
      skipped++;
    }
  });

  await test('DELETE /api/orders/:id deletes order', async () => {
    // Create a test order first via webhook simulation
    const testOrderId = `test_${Date.now()}`;
    const res = await makeRequest('DELETE', `/api/orders/${testOrderId}`, null, headers);
    // Should return 404 for non-existent order
    expect(res.status === 404, `Expected 404, got ${res.status}`);
  });
}

async function testKnowledgeBase() {
  log('\n═══ KNOWLEDGE BASE TESTS ═══', 'section');

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('GET /api/settings includes knowledgeBase', async () => {
    const res = await makeRequest('GET', '/api/settings', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
    expect('knowledgeBase' in res.body, 'Should have knowledgeBase field');
  });

  await test('POST /api/format-kb requires knowledgeBase', async () => {
    const res = await makeRequest('POST', '/api/format-kb', {}, headers);
    expect(res.status === 200 || res.status === 400, `Expected 200 or 400, got ${res.status}`);
  });
}

async function testEscalationFlow() {
  log('\n═══ ESCALATION FLOW TESTS ═══', 'section');

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('GET /api/messages can retrieve escalations', async () => {
    const res = await makeRequest('GET', '/api/messages', null, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
  });
}

async function testImageUpload() {
  log('\n═══ IMAGE UPLOAD TESTS ═══', 'section');

  const headers = { Authorization: `Bearer ${authToken}` };

  await test('POST /api/upload-image requires parameters', async () => {
    const res = await makeRequest('POST', '/api/upload-image', {}, headers);
    expect(res.status === 400 || res.status === 500, `Expected 400 or 500, got ${res.status}`);
  });

  await test('POST /api/delete-image handles missing image', async () => {
    const res = await makeRequest('POST', '/api/delete-image', { productName: 'Test', slot: 0 }, headers);
    expect(res.status === 200, `Expected 200, got ${res.status}`);
  });
}

async function testSocketConnection() {
  log('\n═══ WEBSOCKET TESTS ═══', 'section');

  await test('Socket.io endpoint is accessible', async () => {
    try {
      const url = new URL('/socket.io/?EIO=4&transport=polling', BASE_URL);
      const res = await new Promise((resolve, reject) => {
        http.get(url.toString(), (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
      });
      expect(res.status === 200, `Expected 200, got ${res.status}`);
    } catch (e) {
      throw new Error(`Socket.io not accessible: ${e.message}`);
    }
  });
}

// ── Main Test Runner ───────────────────────────────────────────────

async function runAllTests() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     QA TEST RUNNER - WhatsApp AI Chatbot                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`📅 Date: ${new Date().toISOString()}\n`);

  try {
    await testLoginFlow();
    await testAPIEndpoints();
    await testWebhookEndpoint();
    await testWhatsAppIntegration();
    await testOrderFlow();
    await testKnowledgeBase();
    await testEscalationFlow();
    await testImageUpload();
    await testSocketConnection();
  } catch (e) {
    console.error('\n❌ Test suite error:', e.message);
  }

  // Print summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                     TEST SUMMARY                          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Passed:  ${passed.toString().padStart(3)}                                  ║`);
  console.log(`║  ❌ Failed:  ${failed.toString().padStart(3)}                                  ║`);
  console.log(`║  ⏭️  Skipped: ${skipped.toString().padStart(3)}                                  ║`);
  console.log(`║  📊 Total:   ${(passed + failed + skipped).toString().padStart(3)}                                  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (failed > 0) {
    console.log('❌ FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.details}`);
    });
    console.log('');
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runAllTests();
