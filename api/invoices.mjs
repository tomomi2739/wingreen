/**
 * 請求書の一覧・明細取得API
 *
 *   GET /api/invoices?period=1             → 一覧
 *   GET /api/invoices?period=1&id=<pageId> → 1件の詳細（明細・取引先・自社情報つき）
 */

import { getPeriod, getCurrentPeriod, listPeriods } from '../lib/periods.mjs';
import { listInvoices, loadInvoice } from '../lib/invoice-data.mjs';

export default async function handler(req, res) {
  try {
    const period = req.query.period ? getPeriod(req.query.period) : getCurrentPeriod();
    const meta = {
      no: period.no,
      label: period.label,
      // 画面の期セレクタ用。設定ファイルは画面側からは見えないのでここで返す。
      available: listPeriods().map((p) => ({ no: p.no, label: p.label })),
    };

    res.setHeader('Cache-Control', 'no-store');

    // 一時的な診断。環境変数が関数に届いているかを、値を出さずに確認する。
    if (req.query.diag === '1') {
      const keys = Object.keys(process.env).filter((k) => k.startsWith('WG_')).sort();
      return res.status(200).json({
        runtime: process.version,
        vercelEnv: process.env.VERCEL_ENV ?? '(なし)',
        wgKeys: keys.map((k) => ({ key: k, length: (process.env[k] ?? '').length })),
        notionTokenSet: Boolean(process.env.NOTION_TOKEN_WG),
      });
    }

    if (!req.query.id) {
      return res.status(200).json({ period: meta, invoices: await listInvoices(period.no) });
    }
    return res.status(200).json({ period: meta, ...(await loadInvoice(period.no, req.query.id)) });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
