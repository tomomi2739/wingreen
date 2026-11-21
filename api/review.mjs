/**
 * 経理確認API
 *
 *   GET  /api/review?period=1     → 仮登録の仕訳と、入力に使うマスタ一覧
 *   POST /api/review              → 1件を確定（または対象外に）する
 *
 * 投稿で作られた「仮登録」の行に、科目・税区分・支払先などを入れて仕上げる。
 */

import { queryDatabaseAll, flattenPage, retrieveDatabase, updatePage } from '../lib/notion.mjs';
import {
  masters, getPeriod, getCurrentPeriod, getPeriodDatabaseId, listPeriods,
} from '../lib/periods.mjs';

const PENDING = '仮登録';
const rich = (t) => (t ? [{ text: { content: String(t).slice(0, 2000) } }] : []);
const relation = (id) => ({ relation: id ? [{ id }] : [] });

export default async function handler(req, res) {
  try {
    const query = req.method === 'POST' ? (req.body ?? {}) : req.query;
    const period = query.period ? getPeriod(query.period) : getCurrentPeriod();
    const journalDb = getPeriodDatabaseId(period.no, 'journal');

    res.setHeader('Cache-Control', 'no-store');

    /* ---- 確定・対象外 ---- */
    if (req.method === 'POST') {
      const { pageId, action } = query;
      if (!pageId) return res.status(400).json({ error: 'pageId がありません' });

      if (action === 'reject') {
        await updatePage(pageId, { properties: { '承認ステータス': { select: { name: '却下' } } } });
        return res.status(200).json({ ok: true, status: '却下' });
      }

      const properties = {
        '承認ステータス': { select: { name: '確認済' } },
        '借方勘定科目': relation(query.debitAccountId),
        '借方補助科目': relation(query.debitSubId),
        '貸方勘定科目': relation(query.creditAccountId),
        '貸方補助科目': relation(query.creditSubId),
        '支払先マスタ WG': relation(query.payeeId),
        '取引先マスタ WG': relation(query.clientId),
      };
      if (query.date) properties['取引日'] = { date: { start: query.date } };
      if (query.name != null) properties['名前'] = { title: rich(query.name) };
      if (query.memo != null) properties['摘要'] = { rich_text: rich(query.memo) };
      if (query.amount != null && query.amount !== '') {
        properties['金額（税込）'] = { number: Number(query.amount) };
      }
      // 税区分は空にもできるようにする（未判断のまま確定したい場合がある）
      properties['税区分'] = query.taxCategory ? { select: { name: query.taxCategory } } : { select: null };

      await updatePage(pageId, { properties });
      return res.status(200).json({ ok: true, status: '確認済' });
    }

    /* ---- 一覧とマスタ ---- */
    const [journalSchema, pending, accountPages, subPages, payeePages, clientPages] = await Promise.all([
      retrieveDatabase(journalDb),
      queryDatabaseAll(journalDb, {
        filter: { property: '承認ステータス', select: { equals: PENDING } },
      }),
      queryDatabaseAll(masters.accounts.id),
      queryDatabaseAll(masters.subAccounts.id),
      queryDatabaseAll(masters.payees.id),
      queryDatabaseAll(masters.clients.id),
    ]);

    const accounts = accountPages.map(flattenPage).map((a) => ({
      id: a._id, name: a['科目名'], category: a['分類'] ?? '', type: a['科目タイプ'] ?? '',
    }));
    const subAccounts = subPages.map(flattenPage).map((s) => ({
      id: s._id,
      name: s['補助科目名'],
      parents: s['所属勘定科目'] ?? [],
      order: s['表示順'] ?? 0,
      active: s['有効'] !== false,
    }));

    const items = pending.map(flattenPage).map((j) => ({
      pageId: j._id,
      date: j['取引日'] ?? '',
      name: j['名前'] ?? '',
      amount: j['金額（税込）'] ?? null,
      memo: j['摘要'] ?? '',
      taxCategory: j['税区分'] ?? '',
      debitAccountId: (j['借方勘定科目'] ?? [])[0] ?? '',
      debitSubId: (j['借方補助科目'] ?? [])[0] ?? '',
      creditAccountId: (j['貸方勘定科目'] ?? [])[0] ?? '',
      creditSubId: (j['貸方補助科目'] ?? [])[0] ?? '',
      payeeId: (j['支払先マスタ WG'] ?? [])[0] ?? '',
      clientId: (j['取引先マスタ WG'] ?? [])[0] ?? '',
      // 添付のURLはNotionの一時URL。時間が経つと開けなくなる。
      files: Array.isArray(j['証票画像']) ? j['証票画像'] : [],
    })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

    res.status(200).json({
      period: {
        no: period.no,
        label: period.label,
        available: listPeriods().map((p) => ({ no: p.no, label: p.label })),
      },
      count: items.length,
      items,
      options: {
        accounts,
        subAccounts,
        payees: payeePages.map(flattenPage).map((p) => ({ id: p._id, name: p['氏名/名称'] })),
        clients: clientPages.map(flattenPage).map((c) => ({ id: c._id, name: c['会社名/氏名'] })),
        // 選択肢はNotionの定義をそのまま使う（こちらで決め打ちしない）
        taxCategories: (journalSchema.properties['税区分']?.select?.options ?? []).map((o) => o.name),
      },
      ocrEnabled: Boolean(process.env.GEMINI_API_KEY_WG),
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
