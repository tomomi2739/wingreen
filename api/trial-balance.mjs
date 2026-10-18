/**
 * 合計残高試算表API
 *
 *   GET /api/trial-balance?period=1
 *
 * 勘定科目ごとに、月別の借方合計・貸方合計を返す。
 * 「月次」「累積」の切り替えと前残・残高の計算は画面側で行うため、
 * ここでは素材となる月別の集計だけを返す。
 *
 * 金額は税込。仕訳に仮払消費税・仮受消費税の科目が無いため、
 * 税抜で組むと消費税のぶん貸借が一致しなくなる。
 */

import { queryDatabaseAll, flattenPage } from '../lib/notion.mjs';
import {
  masters,
  getPeriod,
  getCurrentPeriod,
  getPeriodDatabaseId,
  listMonths,
  listPeriods,
} from '../lib/periods.mjs';

// 科目タイプから大区分を決める。表示順もこの並び。
const SECTIONS = [
  { key: 'asset',     label: '資産の部',   types: ['BS / 資産'],         normalSide: 'debit'  },
  { key: 'liability', label: '負債の部',   types: ['BS / 負債'],         normalSide: 'credit' },
  { key: 'equity',    label: '純資産の部', types: ['BS / 純資産'],       normalSide: 'credit' },
  { key: 'revenue',   label: '収益',       types: ['PL / 収益'],         normalSide: 'credit' },
  { key: 'expense',   label: '費用',       types: ['PL / 費用'],         normalSide: 'debit'  },
  { key: 'nonop',     label: '営業外損益', types: ['PL / 営業外損益'],   normalSide: 'credit' },
];

/** 科目タイプの表記ゆれ（空白の数など）に左右されないよう、比較用に整える */
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

function sectionOf(type) {
  const target = squash(type);
  return SECTIONS.find((s) => s.types.some((t) => squash(t) === target)) ?? null;
}

export default async function handler(req, res) {
  try {
    const period = req.query.period ? getPeriod(req.query.period) : getCurrentPeriod();
    const months = listMonths(period.no);

    const [accountPages, journalPages] = await Promise.all([
      queryDatabaseAll(masters.accounts.id),
      queryDatabaseAll(getPeriodDatabaseId(period.no, 'journal')),
    ]);

    // Notion上の並び順をそのまま表示順として使う
    const accounts = new Map();
    accountPages.map(flattenPage).forEach((a, index) => {
      const section = sectionOf(a['科目タイプ']);
      if (!section) return;                      // 科目タイプ未設定の行は試算表に出さない
      accounts.set(a._id, {
        id: a._id,
        name: a['科目名'],
        type: a['科目タイプ'],
        category: a['分類'] ?? '',
        section: section.key,
        normalSide: section.normalSide,
        order: index,
        opening: period.openingBalances?.[a['科目名']] ?? 0,
        byMonth: Object.fromEntries(months.map((m) => [m, { debit: 0, credit: 0, count: 0 }])),
      });
    });

    const skipped = { noDate: 0, outOfPeriod: 0, noAccount: 0 };

    for (const j of journalPages.map(flattenPage)) {
      const date = j['取引日'];
      if (!date) { skipped.noDate += 1; continue; }
      const month = date.slice(0, 7);
      if (!months.includes(month)) { skipped.outOfPeriod += 1; continue; }

      const gross = j['金額（税込）'] ?? 0;
      let hit = false;

      for (const [side, key] of [['debit', '借方勘定科目'], ['credit', '貸方勘定科目']]) {
        const id = (j[key] ?? [])[0];
        const account = id ? accounts.get(id) : null;
        if (!account) continue;
        hit = true;
        account.byMonth[month][side] += gross;
        account.byMonth[month].count += 1;
      }
      if (!hit) skipped.noAccount += 1;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      period: {
        no: period.no,
        label: period.label,
        start: period.start,
        end: period.end,
        available: listPeriods().map((p) => ({ no: p.no, label: p.label })),
      },
      months,
      sections: SECTIONS.map(({ key, label, normalSide }) => ({ key, label, normalSide })),
      accounts: [...accounts.values()].sort((a, b) => a.order - b.order),
      basis: '税込',
      skipped,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
