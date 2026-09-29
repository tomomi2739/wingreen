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

// 貸借対照表科目のうち、実際の資金の出入りを表す科目。
// 「借方 未払金 / 貸方 預り金」のような振替を支払と数えないための判定に使う。
const CASH_ACCOUNTS = new Set(['普通預金', '現金']);

// 資産は借方で増え、負債・純資産は貸方で増える
const ASSET_CATEGORIES = new Set(['流動資産', '固定資産']);
const BS_CATEGORIES = new Set([
  '流動資産', '固定資産', '流動負債', '固定負債', '株主資本',
]);

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

    // マスタを読み、リレーションIDから名前・分類を引けるようにする。
    // 支払先・取引先は、売掛金や未払金を相手先別に出すために使う。
    const [accountPages, subAccountPages, payeePages, clientPages] = await Promise.all([
      queryDatabaseAll(masters.accounts.id),
      queryDatabaseAll(masters.subAccounts.id),
      queryDatabaseAll(masters.payees.id),
      queryDatabaseAll(masters.clients.id),
    ]);

    const accounts = new Map(
      accountPages.map(flattenPage).map((a) => [a._id, { name: a['科目名'], category: a['分類'] }]),
    );
    const subAccounts = new Map(
      subAccountPages.map(flattenPage).map((s) => [s._id, s['補助科目名']]),
    );
    const payees = new Map(payeePages.map(flattenPage).map((p) => [p._id, p['氏名/名称']]));
    const clients = new Map(clientPages.map(flattenPage).map((c) => [c._id, c['会社名/氏名']]));
    const partyOf = (j) =>
      (j['支払先マスタ WG'] ?? []).map((id) => payees.get(id)).filter(Boolean).join('、')
      || (j['取引先マスタ WG'] ?? []).map((id) => clients.get(id)).filter(Boolean).join('、')
      || '';

    const journals = (await queryDatabaseAll(getPeriodDatabaseId(period.no, 'journal'))).map(flattenPage);

    const months = listMonths(period.no);
    const byMonth = Object.fromEntries(months.map((m) => [m, emptyMonth()]));

    // 貸借対照表科目の増減。売掛金の回収状況・未払金の支払状況・役員借入金の精算額に使う。
    const bs = {};
    const bsBucket = (name, category) => {
      bs[name] ??= {
        name,
        category,
        isAsset: ASSET_CATEGORIES.has(category),
        opening: period.openingBalances?.[name] ?? 0,
        byMonth: Object.fromEntries(months.map((m) => [m, {
          increase: 0, decrease: 0, decreaseCash: 0, count: 0, parties: {}, subs: {},
        }])),
      };
      return bs[name];
    };
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

      // --- 貸借対照表科目の増減を記録する ---
      const sides = ['debit', 'credit'].map((side) => {
        const id = (j[side === 'debit' ? '借方勘定科目' : '貸方勘定科目'] ?? [])[0];
        const subId = (j[side === 'debit' ? '借方補助科目' : '貸方補助科目'] ?? [])[0];
        return { side, account: id ? accounts.get(id) : null, sub: subId ? subAccounts.get(subId) : null };
      });

      for (const { side, account, sub } of sides) {
        if (!account || !BS_CATEGORIES.has(account.category)) continue;

        const b = bsBucket(account.name, account.category);
        const m = b.byMonth[month];
        const increases = b.isAsset ? side === 'debit' : side === 'credit';

        m.count += 1;
        const party = partyOf(j);
        const key = sub || party || '（内訳なし）';
        m.parties[key] ??= { increase: 0, decrease: 0 };
        if (sub) { m.subs[sub] ??= { increase: 0, decrease: 0 }; }

        if (increases) {
          m.increase += gross;
          m.parties[key].increase += gross;
          if (sub) m.subs[sub].increase += gross;
        } else {
          m.decrease += gross;
          m.parties[key].decrease += gross;
          if (sub) m.subs[sub].decrease += gross;
          // 相手側が資金科目のときだけ、実際の入出金として数える
          const other = sides.find((x) => x.side !== side)?.account;
          if (other && CASH_ACCOUNTS.has(other.name)) m.decreaseCash += gross;
        }
      }
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
      // 債権・債務の状況。期首残高からの累計残高も月ごとに持たせる
      balances: Object.values(bs)
        .map((b) => {
          let running = b.opening;
          const series = months.map((m) => {
            const x = b.byMonth[m];
            running += b.isAsset ? x.increase - x.decrease : x.increase - x.decrease;
            return { month: m, ...x, closing: running };
          });
          const total = series.reduce((a, x) => ({
            increase: a.increase + x.increase,
            decrease: a.decrease + x.decrease,
            decreaseCash: a.decreaseCash + x.decreaseCash,
            count: a.count + x.count,
          }), { increase: 0, decrease: 0, decreaseCash: 0, count: 0 });
          return {
            name: b.name, category: b.category, isAsset: b.isAsset,
            opening: b.opening, series, total, closing: running,
          };
        })
        .sort((a, b) => b.total.increase - a.total.increase),
      cashAccounts: [...CASH_ACCOUNTS],
      skipped,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
}
