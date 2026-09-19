/**
 * 請求書PDFの生成・発行API
 *
 *   GET  /api/issue-invoice?period=1&id=<pageId>  → PDFを返すだけ（プレビュー。Notionは一切変更しない）
 *   POST /api/issue-invoice  { period, id }       → PDFを生成し、NotionのPDF欄に添付して
 *                                                   ステータスを「発行済み」にする
 */

import { readFileSync } from 'node:fs';
import { getPeriod, getCurrentPeriod } from '../lib/periods.mjs';
import { loadInvoice } from '../lib/invoice-data.mjs';
import { buildInvoicePdf } from '../lib/invoice-pdf.mjs';
import { uploadFile, updatePage } from '../lib/notion.mjs';

const LOGO_PATH = new URL('../public/assets/logo.png', import.meta.url);

function readLogo() {
  try {
    return readFileSync(LOGO_PATH);
  } catch {
    return null; // ロゴが無くても請求書は出せる
  }
}

/** ファイル名に使えない文字を落とす */
const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();

export default async function handler(req, res) {
  try {
    const query = req.method === 'POST' ? (req.body ?? {}) : req.query;
    const period = query.period ? getPeriod(query.period) : getCurrentPeriod();

    if (!query.id) return res.status(400).json({ error: '請求書のid が指定されていません' });

    const data = await loadInvoice(period.no, query.id);
    const bytes = await buildInvoicePdf({ ...data, logoBytes: readLogo() });

    const filename = `${safeName(data.invoice.number || 'invoice')}_${safeName(data.invoice.clientName || '請求書')}.pdf`;

    // プレビューはNotionを変更しない
    if (req.method !== 'POST') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(Buffer.from(bytes));
    }

    // 発行：PDFを添付し、ステータスと発行日を更新する
    const fileUploadId = await uploadFile(bytes, filename, 'application/pdf');

    const properties = {
      'PDF': { files: [{ type: 'file_upload', name: filename, file_upload: { id: fileUploadId } }] },
      'ステータス': { status: { name: '発行済み' } },
    };
    // 発行日が未設定なら今日を入れる（既に入っていれば尊重する）
    if (!data.invoice.issueDate) {
      properties['発行日'] = { date: { start: new Date().toISOString().slice(0, 10) } };
    }

    await updatePage(data.invoice.id, { properties });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      invoiceNumber: data.invoice.number,
      filename,
      bytes: bytes.length,
      attachedTo: data.invoice.id,
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
