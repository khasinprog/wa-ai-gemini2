const {
  fetchMengantarOrders,
  syncOrdersWithMengantar,
  processOrderPickup,
  renderThermalLabelHtml
} = require('../../mengantar-service');

describe('Mengantar Service Tests', () => {
  describe('renderThermalLabelHtml', () => {
    it('should generate printable thermal label HTML with correct details', () => {
      const order = {
        id: '1234567890',
        nama: 'Budi Santoso',
        hp: '081234567890',
        alamat: 'Jl. Melati No 5, Tamantirto, Kasihan, Bantul',
        ai_alamat: 'Jl. Melati No 5, Desa Tamantirto, Kec Kasihan, Bantul, DI Yogyakarta',
        produk: 'Baby Walking Assistant',
        courier: 'SPX',
        metode_pengiriman: 'COD',
        no_resi: 'SPXID1234567890',
        created_at: new Date().toISOString()
      };

      const html = renderThermalLabelHtml(order);
      expect(html).toContain('SPX EXPRESS');
      expect(html).toContain('SPXID1234567890');
      expect(html).toContain('Budi Santoso');
      expect(html).toContain('081234567890');
      expect(html).toContain('COD : Rp 99.000');
      expect(html).toContain('Baby Walking Assistant');
      expect(html).toContain('window.print()');
    });

    it('should handle Non-COD (Transfer) order correctly', () => {
      const order = {
        id: '9999999999',
        nama: 'Siti Aminah',
        hp: '08987654321',
        alamat: 'Jl. Mawar No 10',
        produk: 'Pasta Dempul',
        courier: 'SAP',
        metode_pengiriman: 'Transfer'
      };

      const html = renderThermalLabelHtml(order);
      expect(html).toContain('SAP EXPRESS');
      expect(html).toContain('NON-COD (LUNAS)');
      expect(html).toContain('Siti Aminah');
    });
  });

  describe('processOrderPickup (Draft Mode)', () => {
    it('should generate draft resi and preview URL without calling courier in testing mode', async () => {
      const order = {
        id: '179354352989595',
        nama: 'Khasin Khafabi',
        hp: '081233350792',
        alamat: 'Rukeman, Tamantirto',
        produk: 'Baby Walking Assistant',
        courier: 'SPX',
        metode_pengiriman: 'COD'
      };

      const res = await processOrderPickup(order, true);
      expect(res.ok).toBe(true);
      expect(res.isDraft).toBe(true);
      expect(order.no_resi).toMatch(/^DFT-SPX-/);
      expect(order.pickup_status).toBe('draft');
      expect(order.tracking_status).toContain('Draft Pesanan');
      expect(order.pdf_label_url).toBe(`/api/orders/${order.id}/preview-label`);
    });
  });

  describe('syncOrdersWithMengantar', () => {
    it('should sync local orders with fetched Mengantar orders', async () => {
      const localOrders = [
        {
          id: 'test-1',
          nama: 'Albilla Fauziah',
          hp: '082173943448',
          produk: 'Baby Walking Assitant',
          no_resi: null,
          pickup_status: 'belum_pickup'
        }
      ];

      const res = await syncOrdersWithMengantar(localOrders);
      expect(res).toBeDefined();
      expect(typeof res.syncedCount).toBe('number');
      // If Mengantar API returns orders, Albilla Fauziah (Item 0) matches!
      if (res.mengantarTotal > 0) {
        expect(localOrders[0].no_resi).toBe('IDJ1001233701427');
        expect(localOrders[0].pdf_label_url).toContain('https://app.mengantar.com/print?ids=');
        expect(localOrders[0].courier).toBe('iDexpress');
      }
    });
  });
});

