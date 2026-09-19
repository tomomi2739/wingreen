/**
 * 月次レポート用API
 *
 *   GET /api/monthly-report?period=1
 *
 * 指定した期の仕訳明細を集計し、月別の売上・経費・利益と、
 * 売上内訳（貸方補助科目別）・経費内訳（借方勘定科目別）を返す。
 * 期の全月ぶんをまとめて返すので、画面側は月を切り替えても再取得しない。
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

// 勘定科目マスタの「分類」から、P/L上の扱いを決める。
// 「科目タイプ」は選択肢名に表記ゆれ（"PL /  費用" の二重スペース）があるため使わない。
const BUCKET_BY_CATEGORY = {
  '売上高': 'revenue',
  '販管費': 'expense',
  '営業外収益': 'nonOpIncome',
  '営業外費用': 'nonOpExpense',
};

// 各バケットが借方・貸方どちらで増えるか（収益は貸方、費用は借方で増加）
const INCREASES_ON = {
  revenue: 'credit',
  expense: 'debit',
  nonOpIncome: 'credit',
  nonOpExpense: 'debit',
};

const emptyTotals = () => ({ revenue: 0, expense: 0, nonOpIncome: 0, nonOpExpense: 0 });

// 承認ステータスの表示順。Notionの選択肢に無い（未入力の）行は「未設定」に寄せる。
export const STATUSES = ['承認', '確認済', '仮登録', '却下', '未設定'];
const UNSET = '未設定';

const emptyByStatus = () =>
  Object.fromEntries(STATUSES.map((k) => [k, { count: 0, revenue: 0, expense: 0 }]));

function emptyMonth() {
  return {
    net: emptyTotals(),        // 税抜
    gross: emptyTotals(),      // 税込
    revenueBreakdown: {},      // 補助科目名 → 税抜金額
    expenseBreakdown: {},      // 勘定科目名 → 税抜金額
    byStatus: emptyByStatus(), // 承認ステータス別の件数・金額
    journalCount: 0,
  };
}

const addTo = (obj, key, amount) => { obj[key] = (obj[key] ?? 0) + amount; };

export default async function handler(req, res) {
  try {
    const period = req.query.period ? getPeriod(req.query.period) : getCurrentPeriod();
    // status: all（既定）/ approved（承認済のみ）/ unapproved（未承認のみ）
    const statusFilter = ['approved', 'unapproved'].includes(req.query.status) ? req.query.status : 'all';

    // マスタを読み、リレーションIDから名前・分類を引けるようにする
    const [accountPages, subAccountPages] = await Promise.all([
      queryDatabaseAll(masters.accounts.id),
      queryDatabaseAll(masters.subAccounts.id),
    ]);

    const accounts = new Map(
      accountPages.map(flattenPage).map((a) => [a._id, { name: a['科目名'], category: a['分類'] }]),
    );
    const subAccounts = new Map(
      subAccountPages.map(flattenPage).map((s) => [s._id, s['補助科目名']]),
    );

    const journals = (await queryDatabaseAll(getPeriodDatabaseId(period.no, 'journal'))).map(flattenPage);

    const months = listMonths(period.no);
    const byMonth = Object.fromEntries(months.map((m) => [m, emptyMonth()]));
    const skipped = { noDate: 0, outOfPeriod: 0, byStatusFilter: 0, noAccount: 0 };

    for (const j of journals) {
      const date = j['取引日'];
      if (!date) { skipped.noDate += 1; continue; }

      const month = date.slice(0, 7);
      if (!byMonth[month]) { skipped.outOfPeriod += 1; continue; }

      const status = STATUSES.includes(j['承認ステータス']) ? j['承認ステータス'] : UNSET;
      const isApproved = status === '承認';
      if (statusFilter === 'approved' && !isApproved) { skipped.byStatusFilter += 1; continue; }
      if (statusFilter === 'unapproved' && isApproved) { skipped.byStatusFilter += 1; continue; }

      const gross = j['金額（税込）'] ?? 0;
      // 税抜金額は数式プロパティ。税区分未入力の行では税込額と同額になる。
      const net = j['税抜金額'] ?? gross;

      const bucket = byMonth[month];
      bucket.journalCount += 1;
      bucket.byStatus[status].count += 1;

      let matched = false;

      // 借方・貸方それぞれを見て、収益/費用バケットに符号付きで積む
      for (const side of ['debit', 'credit']) {
        const accountKey = side === 'debit' ? '借方勘定科目' : '貸方勘定科目';
        const subKey = side === 'debit' ? '借方補助科目' : '貸方補助科目';

        const accountId = (j[accountKey] ?? [])[0];
        const account = accountId ? accounts.get(accountId) : null;
        const type = account ? BUCKET_BY_CATEGORY[account.category] : null;
        if (!type) continue;

        matched = true;
        // 増加側なら加算、反対側なら減算（返品・値引・訂正仕訳に対応）
        const sign = INCREASES_ON[type] === side ? 1 : -1;
        bucket.net[type] += net * sign;
        bucket.gross[type] += gross * sign;

        const subId = (j[subKey] ?? [])[0];
        const subName = subId ? subAccounts.get(subId) : null;

        if (type === 'revenue') {
          addTo(bucket.revenueBreakdown, subName ?? account.name, net * sign);
          bucket.byStatus[status].revenue += net * sign;
        } else if (type === 'expense') {
          addTo(bucket.expenseBreakdown, account.name, net * sign);
          bucket.byStatus[status].expense += net * sign;
        }
      }

      if (!matched) skipped.noAccount += 1;
    }

    // 月ごとの利益を算出し、期累計も作る
    const totals = { ...emptyMonth(), months: months.length };
    const series = months.map((month) => {
      const m = byMonth[month];
      const operatingProfit = m.net.revenue - m.net.expense;
      const ordinaryProfit = operatingProfit + m.net.nonOpIncome - m.net.nonOpExpense;

      for (const key of Object.keys(totals.net)) {
        totals.net[key] += m.net[key];
        totals.gross[key] += m.gross[key];
      }
      for (const [k, v] of Object.entries(m.revenueBreakdown)) addTo(totals.revenueBreakdown, k, v);
      for (const [k, v] of Object.entries(m.expenseBreakdown)) addTo(totals.expenseBreakdown, k, v);
      for (const st of STATUSES) {
        totals.byStatus[st].count += m.byStatus[st].count;
        totals.byStatus[st].revenue += m.byStatus[st].revenue;
        totals.byStatus[st].expense += m.byStatus[st].expense;
      }
      totals.journalCount += m.journalCount;

      return { month, ...m, operatingProfit, ordinaryProfit };
    });

    totals.operatingProfit = totals.net.revenue - totals.net.expense;
    totals.ordinaryProfit = totals.operatingProfit + totals.net.nonOpIncome - totals.net.nonOpExpense;

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      period: { no: period.no, label: period.label, start: period.start, end: period.end },
      // 画面の期セレクタ用。設定ファイルは画面側からは見えないのでここで返す。
      availablePeriods: listPeriods().map((p) => ({ no: p.no, label: p.label })),
      statusFilter,
      statuses: STATUSES,
      months,
      series,
      totals,
      skipped,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
