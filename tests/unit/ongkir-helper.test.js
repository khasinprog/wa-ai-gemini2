'use strict';

const {
  formatSafeEtd,
  formatOngkirForCustomer,
} = require('../../ongkir-helper');

describe('ongkir-helper ETD & Formatting', () => {
  describe('formatSafeEtd', () => {
    test('should calculate max ~ max + 2 for ranges (e.g. 2 - 8 days -> 8~10 hari)', () => {
      expect(formatSafeEtd('2 - 8 days')).toBe('8~10 hari');
      expect(formatSafeEtd('5 - 7 Days')).toBe('7~9 hari');
      expect(formatSafeEtd('2 - 3 days')).toBe('3~5 hari');
      expect(formatSafeEtd('2-4 hari')).toBe('4~6 hari');
      expect(formatSafeEtd('3-6 Day')).toBe('6~8 hari');
      expect(formatSafeEtd('1-2')).toBe('2~4 hari');
    });

    test('should calculate max ~ max + 2 for single day values (e.g. 4 HARI -> 4~6 hari)', () => {
      expect(formatSafeEtd('4 HARI')).toBe('4~6 hari');
      expect(formatSafeEtd('1 hari')).toBe('1~3 hari');
    });

    test('should return null for invalid or empty inputs', () => {
      expect(formatSafeEtd('-')).toBeNull();
      expect(formatSafeEtd('')).toBeNull();
      expect(formatSafeEtd(null)).toBeNull();
      expect(formatSafeEtd(undefined)).toBeNull();
    });
  });

  describe('formatOngkirForCustomer', () => {
    test('should format message with safe ETD buffer', () => {
      const mockResult = {
        allCouriers: [
          {
            courier: 'spx',
            price: 31875,
            codFee: 4000,
            etd: '2 - 8 days',
            unsupportedCod: false,
          }
        ]
      };

      const formatted = formatOngkirForCustomer(mockResult, 'PEUNAYONG, KUTA ALAM, BANDA ACEH');
      expect(formatted).toContain('Ongkir ke PEUNAYONG, KUTA ALAM, BANDA ACEH 📦');
      expect(formatted).toContain('Sebesar Rp 31.000 (SPX)');
      expect(formatted).toContain('biaya COD Rp 4.000');
      expect(formatted).toContain('(Estimasi tiba: 8~10 hari)');
    });
  });
});

