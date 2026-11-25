/**
 * 証憑の投稿API
 *
 *   POST /api/intake  { filename, contentType, data(base64), memo }
 *
 * 受け取ったファイルを読み取り、Notionへアップロードし、
 * 仕訳明細に「仮登録」の行を1件作る。科目は空のままにして、
 * 経理確認の画面で埋める。
 *
 * 読み取りに失敗しても（鍵が無い場合も）投稿は成立させる。
 * 写真が手元から消えてしまうより、科目が空の行が残るほうがよいため。
 */

import { readFileSync } from 'node:fs';
import { uploadFile, createPage, queryDatabaseAll, flattenPage } from '../lib/notion.mjs';
import { masters, getCurrentPeriod, getPeriodDatabaseId } from '../lib/periods.mjs';
import { readDocument } from '../lib/ocr.mjs';

const paymentConfig = JSON.parse(
  readFileSync(new URL('../config/payment-methods.json', import.meta.url), 'utf8'),
);

/**
 * 支払方法の選択肢を、Notionの勘定科目・補助科目のIDに解決する。
 * 設定に書かれていてもNotionに無い名前は、黙って落とす（画面にも出さない）。
 */
async function resolveMethods() {
  const [accountPages, subPages] = await Promise.all([
    queryDatabaseAll(masters.accounts.id),
    queryDatabaseAll(masters.subAccounts.id),
  ]);
  const accounts = new Map(accountPages.map(flattenPage).map((a) => [a['科目名'], a._id]));
  const subs = new Map(subPages.map(flattenPage).map((s) => [s['補助科目名'], s._id]));

  return paymentConfig.methods.flatMap((m) => {
    // 科目を指定しない選択肢（その他）は、そのまま残して経理に判断を委ねる
    if (!m.account) return [{ key: m.key, label: m.label, hint: m.hint ?? '', accountId: '', subId: '' }];

    const accountId = accounts.get(m.account);
    if (!accountId) {
      console.warn(`支払方法「${m.label}」の勘定科目「${m.account}」がNotionに見つかりません`);
      return [];
    }
    const subId = m.sub ? subs.get(m.sub) : '';
    if (m.sub && !subId) {
      console.warn(`支払方法「${m.label}」の補助科目「${m.sub}」がNotionに見つかりません`);
    }
    return [{ key: m.key, label: m.label, hint: m.hint ?? '', accountId, subId: subId ?? '' }];
  });
}

// Vercelの関数はリクエスト本文4.5MBまで。base64は約1.33倍に膨らむので、
// 実ファイルで3MB程度を上限として扱う。画面側でも縮小している。
const MAX_BYTES = 3 * 1024 * 1024;

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);

const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'receipt';
const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  // 投稿画面が支払方法のボタンを描くために使う
  if (req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ methods: await resolveMethods() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTのみ受け付けます' });

  try {
    const { filename, contentType, data, memo, method } = req.body ?? {};
    if (!data) return res.status(400).json({ error: 'ファイルがありません' });
    if (!ALLOWED.has(contentType)) {
      return res.status(400).json({ error: `この形式は登録できません（${contentType ?? '不明'}）` });
    }

    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_BYTES) {
      return res.status(413).json({
        error: `ファイルが大きすぎます（${(bytes.length / 1024 / 1024).toFixed(1)}MB）。3MB以下にしてください`,
      });
    }

    // 読み取り。失敗しても投稿は続ける。
    // 失敗したことを黙って空欄にすると、経理が「金額が無い行」を見ても
    // 読めなかったのか元から書いていないのか分からないので、理由を摘要に残す。
    const result = await readDocument(data, contentType).catch((err) => {
      console.warn(`読み取りに失敗: ${err.message}`);
      return { ok: false, reason: '読み取り処理が異常終了' };
    });
    const read = result.ok ? result.data : null;
    if (!read) console.warn(`読み取りなし: ${result.reason}`);

    const date = read?.date || today();
    const period = getCurrentPeriod(new Date(date));

    const name = safeName(filename);
    const fileUploadId = await uploadFile(bytes, name, contentType);

    // 摘要には、投稿メモと読み取り全文をまとめて入れる
    const noteParts = [
      String(memo ?? '').trim(),
      read?.invoiceRegistrationNumber ? `登録番号: ${read.invoiceRegistrationNumber}` : '',
      // 読めなかった行は、経理確認の画面で見てすぐ分かるようにしておく
      read ? '' : `※ 自動読み取りなし（${result.reason}）。日付・金額は画像を見て入れてください`,
      read?.text ? `【読み取り】\n${read.text}` : '',
    ].filter(Boolean);

    const properties = {
      '名前': { title: [{ text: { content: (read?.vendor || name).slice(0, 2000) } }] },
      '取引日': { date: { start: date } },
      '摘要': { rich_text: [{ text: { content: noteParts.join('\n').slice(0, 2000) } }] },
      '証票画像': { files: [{ type: 'file_upload', name, file_upload: { id: fileUploadId } }] },
      '承認ステータス': { select: { name: '仮登録' } },
    };
    if (read?.amount != null) properties['金額（税込）'] = { number: read.amount };

    // 支払方法が選ばれていれば、貸方（支払った手段）まで埋めておく。
    // 借方の科目は経理確認で入れるため、ここでは触らない。
    if (method) {
      const chosen = (await resolveMethods()).find((m) => m.key === method);
      if (chosen?.accountId) {
        properties['貸方勘定科目'] = { relation: [{ id: chosen.accountId }] };
        if (chosen.subId) properties['貸方補助科目'] = { relation: [{ id: chosen.subId }] };
      }
    }

    const page = await createPage({
      parent: { database_id: getPeriodDatabaseId(period.no, 'journal') },
      properties,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      pageId: page.id,
      period: { no: period.no, label: period.label },
      // 投稿者には読み取り結果を返さない（画面にも出さない）
      extracted: Boolean(read),
    });
  } catch (err) {
    console.error(`投稿に失敗: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
