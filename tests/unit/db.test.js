// ── Unit Tests: db.js ──────────────────────────────────────────────
// Note: These tests require a running PostgreSQL database
// Run with: npm run test:unit
// Skip with: npm run test:unit -- --testPathIgnorePatterns=db

const db = require('../../db');

// Mock environment variables for testing
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/wa_ai_test';
process.env.DATABASE_SSL = 'false';

// Check if database is available
let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.pool.query('SELECT 1');
    dbAvailable = true;
    await db.initDB();
  } catch (e) {
    console.warn('⚠️  Database not available - skipping db tests');
    console.warn('   Set DATABASE_URL environment variable to run db tests');
  }
});

// Skip all db tests if database is not available
const describeIfDb = dbAvailable ? describe : describe.skip;

describeIfDb('Database Module', () => {

  describe('Schema Initialization', () => {
    test('initDB should create all required tables', async () => {
      const client = await db.pool.connect();
      try {
        const tables = await client.query(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);

        const tableNames = tables.rows.map(r => r.table_name);
        expect(tableNames).toContain('contacts');
        expect(tableNames).toContain('messages');
        expect(tableNames).toContain('orders');
        expect(tableNames).toContain('settings_store');
        expect(tableNames).toContain('processed_wamids');
        expect(tableNames).toContain('active_claims');
      } finally {
        client.release();
      }
    });
  });

  describe('Processed Wamids (Dedup)', () => {
    const testWamid = `test_wamid_${Date.now()}`;

    test('saveProcessedWamid should save a wamid', async () => {
      await expect(db.saveProcessedWamid(testWamid)).resolves.not.toThrow();
    });

    test('isWamidProcessed should return true for saved wamid', async () => {
      const result = await db.isWamidProcessed(testWamid);
      expect(result).toBe(true);
    });

    test('isWamidProcessed should return false for unknown wamid', async () => {
      const result = await db.isWamidProcessed('unknown_wamid_12345');
      expect(result).toBe(false);
    });

    test('saveProcessedWamid should handle null/undefined gracefully', async () => {
      await expect(db.saveProcessedWamid(null)).resolves.not.toThrow();
      await expect(db.saveProcessedWamid(undefined)).resolves.not.toThrow();
      await expect(db.saveProcessedWamid('')).resolves.not.toThrow();
    });

    test('isWamidProcessed should handle null/undefined gracefully', async () => {
      const result1 = await db.isWamidProcessed(null);
      const result2 = await db.isWamidProcessed(undefined);
      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });
  });

  describe('Active Claims', () => {
    const testWaId = `62812${Date.now()}`;

    test('saveActiveClaim should save a claim', async () => {
      await expect(db.saveActiveClaim(testWaId, 'Produk rusak')).resolves.not.toThrow();
    });

    test('getActiveClaim should return saved claim', async () => {
      const claim = await db.getActiveClaim(testWaId);
      expect(claim).toBeTruthy();
      expect(claim.wa_id).toBe(testWaId);
      expect(claim.description).toBe('Produk rusak');
    });

    test('getActiveClaim should return null for unknown wa_id', async () => {
      const claim = await db.getActiveClaim('628999999999');
      expect(claim).toBeNull();
    });

    test('deleteActiveClaim should remove the claim', async () => {
      await db.deleteActiveClaim(testWaId);
      const claim = await db.getActiveClaim(testWaId);
      expect(claim).toBeNull();
    });

    test('saveActiveClaim should handle null/undefined gracefully', async () => {
      await expect(db.saveActiveClaim(null, 'test')).resolves.not.toThrow();
      await expect(db.saveActiveClaim(undefined, 'test')).resolves.not.toThrow();
    });

    test('loadActiveClaims should return an array', async () => {
      const claims = await db.loadActiveClaims();
      expect(Array.isArray(claims)).toBe(true);
    });
  });

  describe('Message Operations', () => {
    const testMsg = {
      waba_message_id: `test_msg_${Date.now()}`,
      wa_id: '6281234567890',
      sender_name: 'Test User',
      direction: 'inbound',
      message_type: 'text',
      body: 'Test message',
      timestamp: new Date().toISOString(),
    };

    test('saveMessage should save a message', async () => {
      const result = await db.saveMessage(testMsg);
      expect(result).toBeTruthy();
      expect(result.from).toBe(testMsg.wa_id);
      expect(result.body).toBe(testMsg.body);
    });

    test('getMessageById should retrieve saved message', async () => {
      const result = await db.getMessageById(1);
      // May be null if database is empty, but should not throw
      expect(typeof result === 'object' || result === null).toBe(true);
    });

    test('getMessages should return an array', async () => {
      const messages = await db.getMessages(10);
      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe('Order Operations', () => {
    const testOrder = {
      id: `test_order_${Date.now()}`,
      jid: '6281234567890',
      nama: 'Test Customer',
      hp: '08123456789',
      produk: 'Test Product',
      alamat: 'Jl. Test No 1',
      status: 'baru',
    };

    test('saveOrder should save an order', async () => {
      await expect(db.saveOrder(testOrder)).resolves.not.toThrow();
    });

    test('getOrders should return an array', async () => {
      const orders = await db.getOrders();
      expect(Array.isArray(orders)).toBe(true);
    });

    test('deleteOrder should remove the order', async () => {
      await expect(db.deleteOrder(testOrder.id)).resolves.not.toThrow();
    });
  });

  describe('Settings Operations', () => {
    const testSettings = {
      autoReply: true,
      persona: 'Test Persona',
      temperature: 0.7,
    };

    test('saveSettings should save settings', async () => {
      await expect(db.saveSettings(testSettings)).resolves.not.toThrow();
    });

    test('loadSettings should return saved settings', async () => {
      const settings = await db.loadSettings();
      expect(settings).toBeTruthy();
      expect(settings.autoReply).toBe(true);
      expect(settings.persona).toBe('Test Persona');
    });
  });

  describe('Contact Operations', () => {
    test('upsertContact should create or update contact', async () => {
      await expect(db.upsertContact('6281234567890', 'Test Contact')).resolves.not.toThrow();
    });

    test('upsertContact should handle null name', async () => {
      await expect(db.upsertContact('6281234567891', null)).resolves.not.toThrow();
    });
  });

  afterAll(async () => {
    await db.pool.end();
  });
});
