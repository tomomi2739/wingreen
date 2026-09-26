/**
 * 仕訳明細の一覧API（税理士との共有用）
 *
 *   GET /api/journal?period=1
 *
 * 指定した期の仕訳を1件ずつ返す。リレーション（勘定科目・補助科目・支払先・
 * 取引先・請求書）はすべて名前に解決してから返すので、画面側はIDを扱わない。
 * 絞り込みは画面側で行う想定。
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

/** リレーションのID配列を名前の配列に変換する */
const names = (ids, map, key) => (ids ?? []).map((id) => map.get(id)?.[key] ?? '（不明）');
const first = (arr) => arr[0] ?? '';

export default async function handler(req, res) {
  try {
    const period = req.query.period ? getPeriod(req.query.period) : getCurrentPeriod();

    const [accountPages, subPages, payeePages, clientPages, invoicePages, journalPages] =
      await Promise.all([
        queryDatabaseAll(masters.accounts.id),
        queryDatabaseAll(masters.subAccounts.id),
        queryDatabaseAll(masters.payees.id),
        queryDatabaseAll(masters.clients.id),
        queryDatabaseAll(getPeriodDatabaseId(period.no, 'invoice')),
        queryDatabaseAll(getPeriodDatabaseId(period.no, 'journal')),
      ]);

    const toMap = (pages) => new Map(pages.map(flattenPage).map((p) => [p._id, p]));
    const accounts = toMap(accountPages);
    const subs = toMap(subPages);
    const payees = toMap(payeePages);
    const clients = toMap(clientPages);
    const invoices = toMap(invoicePages);

    const rows = journalPages.map(flattenPage).map((j) => {
      const debitAccount = first(names(j['借方勘定科目'], accounts, '科目名'));
      const creditAccount = first(names(j['貸方勘定科目'], accounts, '科目名'));
      const accountOf = (name) => [...accounts.values()].find((a) => a['科目名'] === name);

      const gross = j['金額（税込）'] ?? 0;
      const net = j['税抜金額'] ?? gross;

      return {
        id: j._id,
        date: j['取引日'],
        name: j['名前'] ?? '',
        memo: j['摘要'] ?? '',
        debit: {
          account: debitAccount,
          sub: first(names(j['借方補助科目'], subs, '補助科目名')),
          category: accountOf(debitAccount)?.['分類'] ?? '',
        },
        credit: {
          account: creditAccount,
          sub: first(names(j['貸方補助科目'], subs, '補助科目名')),
          category: accountOf(creditAccount)?.['分類'] ?? '',
        },
        gross,
        net,
        tax: j['消費税額'] ?? 0,
        deductible: j['仕入税額控除'] ?? 0,
        taxCategory: j['税区分'] ?? '',
        status: j['承認ステータス'] ?? '',
        payee: names(j['支払先マスタ WG'], payees, '氏名/名称').join('、'),
        client: names(j['取引先マスタ WG'], clients, '会社名/氏名').join('、'),
        invoices: names(j['請求書'], invoices, 'ID').join('、'),
        // 添付ファイルのURLはNotionの署名付きURLで、しばらくすると失効する
        receipts: Array.isArray(j['証票画像']) ? j['証票画像'] : [],
        receiptKey: j['レシートキー'] ?? '',
      };
    });

    // 取引日の新しい順。日付が無い行は先頭に集めて気づけるようにする
    rows.sort((a, b) => (b.date ?? '9999').localeCompare(a.date ?? '9999'));

    // 画面の絞り込みに使う選択肢
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      period: {
        no: period.no,
        label: period.label,
        start: period.start,
        end: period.end,
        available: listPeriods().map((p) => ({ no: p.no, label: p.label })),
      },
      months: listMonths(period.no),
      rows,
      options: {
        accounts: uniq(rows.flatMap((r) => [r.debit.account, r.credit.account])),
        taxCategories: uniq(rows.map((r) => r.taxCategory)),
        statuses: uniq(rows.map((r) => r.status)),
      },
      // 税理士が最初に確認したくなる箇所を数えておく
      attention: {
        noDate: rows.filter((r) => !r.date).length,
        noTaxCategory: rows.filter((r) => !r.taxCategory).length,
        noStatus: rows.filter((r) => !r.status).length,
        rejected: rows.filter((r) => r.status === '却下').length,
        noAccount: rows.filter((r) => !r.debit.account || !r.credit.account).length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
