/**
 * 請求書の一覧・明細取得API
 *
 *   GET /api/invoices?period=1             → 一覧
 *   GET /api/invoices?period=1&id=<pageId> → 1件の詳細（明細・取引先・自社情報つき）
 */

import { getPeriod, getCurrentPeriod } from '../lib/periods.mjs';
import { listInvoices, loadInvoice } from '../lib/invoice-data.mjs';

export default async function handler(req, res) {
  try {
    const period = req.query.period ? getPeriod(req.query.period) : getCurrentPeriod();
    const meta = { no: period.no, label: period.label };

    res.setHeader('Cache-Control', 'no-store');

    if (!req.query.id) {
      return res.status(200).json({ period: meta, invoices: await listInvoices(period.no) });
    }
    return res.status(200).json({ period: meta, ...(await loadInvoice(period.no, req.query.id)) });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
