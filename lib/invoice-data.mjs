/**
 * 請求書データの取得。一覧表示とPDF生成の両方から使う。
 * プロパティ名は実際のNotion DBを確認したうえで固定している。
 */

import { queryDatabaseAll, flattenPage } from './notion.mjs';
import { getPeriodDatabaseId, getMasterDatabaseId } from './periods.mjs';
import { company } from './company.mjs';

export { company };

function shapeInvoice(page) {
  return {
    id: page._id,
    number: page['ID'],                   // unique_id（プレフィックス WG）
    subject: page['件名'],
    status: page['ステータス'],
    issueDate: page['発行日'],
    dueDate: page['支払期日'],
    subtotal: page['小計（税抜）'] ?? 0,   // rollup
    tax: page['消費税額'] ?? 0,            // formula
    total: page['合計（税込）'] ?? 0,      // formula
    note: page['備考'],
    clientIds: page['取引先'] ?? [],
    itemIds: page['明細'] ?? [],
    hasPdf: Array.isArray(page['PDF']) ? page['PDF'].length > 0 : false,
  };
}

async function loadClients() {
  const clients = (await queryDatabaseAll(getMasterDatabaseId('clients'))).map(flattenPage);
  return new Map(clients.map((c) => [c._id, c]));
}

export async function listInvoices(periodNo) {
  const [pages, clientById] = await Promise.all([
    queryDatabaseAll(getPeriodDatabaseId(periodNo, 'invoice')).then((r) => r.map(flattenPage)),
    loadClients(),
  ]);
  return pages
    .map(shapeInvoice)
    .map((iv) => ({
      ...iv,
      clientName: iv.clientIds.map((id) => clientById.get(id)?.['会社名/氏名'] ?? '（不明）').join('、'),
    }))
    .sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''));
}

/** 1件ぶんの請求書を、明細・取引先・自社情報つきで返す */
export async function loadInvoice(periodNo, invoiceId) {
  const [pages, clientById, itemPages] = await Promise.all([
    queryDatabaseAll(getPeriodDatabaseId(periodNo, 'invoice')).then((r) => r.map(flattenPage)),
    loadClients(),
    queryDatabaseAll(getPeriodDatabaseId(periodNo, 'invoiceItem')).then((r) => r.map(flattenPage)),
  ]);

  const page = pages.find((p) => p._id === invoiceId);
  if (!page) {
    const err = new Error('該当する請求書がありません');
    err.status = 404;
    throw err;
  }

  const invoice = shapeInvoice(page);
  const client = clientById.get(invoice.clientIds[0]);

  const items = itemPages
    .filter((it) => (it['親請求書'] ?? []).includes(invoice.id))
    .map((it) => ({
      id: it._id,
      name: it['品目名'],
      quantity: it['数量'] ?? 0,
      unitPrice: it['単価（税抜）'] ?? 0,
      amount: it['金額（税抜）'] ?? 0,
      note: it['備考'],
    }));

  return {
    company,
    invoice: {
      ...invoice,
      clientName: invoice.clientIds.map((id) => clientById.get(id)?.['会社名/氏名'] ?? '（不明）').join('、'),
    },
    client: client && {
      name: client['会社名/氏名'],
      contact: client['担当者'],
      address: client['住所'],
      email: client['メール'],
      tel: client['電話'],
      paymentCycle: client['支払サイクル'],
    },
    items,
  };
}
