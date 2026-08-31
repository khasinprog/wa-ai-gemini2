// ── Unit Tests: config.js ──────────────────────────────────────────
const config = require('../../config');

describe('Configuration Constants', () => {
  test('MESSAGE_LIMIT should be a positive number', () => {
    expect(typeof config.MESSAGE_LIMIT).toBe('number');
    expect(config.MESSAGE_LIMIT).toBeGreaterThan(0);
  });

  test('MAX_RETRY_COUNT should be between 1 and 10', () => {
    expect(config.MAX_RETRY_COUNT).toBeGreaterThanOrEqual(1);
    expect(config.MAX_RETRY_COUNT).toBeLessThanOrEqual(10);
  });

  test('LOGIN_MAX_ATTEMPTS should be reasonable for security', () => {
    expect(config.LOGIN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(config.LOGIN_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  test('LOGIN_WINDOW_MS should be at least 30 seconds', () => {
    expect(config.LOGIN_WINDOW_MS).toBeGreaterThanOrEqual(30000);
  });

  test('ORDER_DEDUP_WINDOW_MS should be between 1 and 30 minutes', () => {
    expect(config.ORDER_DEDUP_WINDOW_MS).toBeGreaterThanOrEqual(60000);
    expect(config.ORDER_DEDUP_WINDOW_MS).toBeLessThanOrEqual(1800000);
  });

  test('ALL_PRODUCTS_KEYWORDS should be an array of strings', () => {
    expect(Array.isArray(config.ALL_PRODUCTS_KEYWORDS)).toBe(true);
    config.ALL_PRODUCTS_KEYWORDS.forEach(kw => {
      expect(typeof kw).toBe('string');
      expect(kw.length).toBeGreaterThan(0);
    });
  });

  test('DEFAULT_MODEL should be a valid Gemini model name', () => {
    expect(config.DEFAULT_MODEL).toMatch(/^gemini-/);
  });

  test('DEFAULT_TEMPERATURE should be between 0 and 1', () => {
    expect(config.DEFAULT_TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(config.DEFAULT_TEMPERATURE).toBeLessThanOrEqual(1);
  });
});
