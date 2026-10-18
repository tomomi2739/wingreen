/** 合計残高試算表。月次と累積を切り替えて見る。 */

import { yen, esc, el, api } from './common.js';

const state = { data: null, period: '', month: '', mode: 'cumulative', showEmpty: false };

/** 分類の並び順。マスタに無い分類は末尾へ回す。 */
const CATEGORY_ORDER = [
  '流動資産', '固定資産',
  '流動負債', '固定負債',
  '株主資本',
  '売上高', '販管費', '営業外収益', '営業外費用',
];
const catRank = (c) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

/**
 * 選択中の条件で、科目1件ぶんの前残・借方・貸方・残高を出す。
 *   月次 … その月だけの動き。前残はその月の期首残高
 *   累積 … 期首から選択月末までの累計
 */
function figuresFor(account, months, month, mode) {
  const upto = months.indexOf(month);
  const before = months.slice(0, upto);
  const through = months.slice(0, upto + 1);

  const sum = (list) => list.reduce((a, m) => {
    const x = account.byMonth[m];
    return { debit: a.debit + x.debit, credit: a.credit + x.credit, count: a.count + x.count };
  }, { debit: 0, credit: 0, count: 0 });

  const signed = ({ debit, credit }) =>
    (account.normalSide === 'debit' ? debit - credit : credit - debit);

  if (mode === 'monthly') {
    const m = account.byMonth[month];
    const opening = account.opening + signed(sum(before));
    return { opening, debit: m.debit, credit: m.credit, count: m.count, closing: opening + signed(m) };
  }
  const all = sum(through);
  return {
    opening: account.opening,
    debit: all.debit,
    credit: all.credit,
    count: all.count,
    closing: account.opening + signed(all),
  };
}

function render(root) {
  const d = state.data;
  root.innerHTML = '';

  const filters = el(`
    <div class="filters">
      <label for="tPeriod">会計期</label>
      <select id="tPeriod">${
        d.period.available.map((p) => `<option value="${p.no}"${p.no === d.period.no ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
      }</select>
      <div class="seg" id="tMode"></div>
      <label for="tMonth">対象月</label>
      <select id="tMonth">${
        d.months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${m.replace('-', '年')}月</option>`).join('')
      }</select>
      <span class="right">
        <label><input type="checkbox" id="tEmpty"${state.showEmpty ? ' checked' : ''}> 動きのない科目も表示</label>
      </span>
    </div>`);
  root.append(filters);

  const seg = filters.querySelector('#tMode');
  for (const [key, label] of [['monthly', '月次'], ['cumulative', '累積']]) {
    const b = el(`<button aria-pressed="${state.mode === key}">${label}</button>`);
    b.onclick = () => { state.mode = key; render(root); };
    seg.append(b);
  }
  filters.querySelector('#tPeriod').onchange = (e) => { state.period = e.target.value; state.month = ''; load(root); };
  filters.querySelector('#tMonth').onchange = (e) => { state.month = e.target.value; render(root); };
  filters.querySelector('#tEmpty').onchange = (e) => { state.showEmpty = e.target.checked; render(root); };

  // 全科目の数値を先に出し、構成比の分母に使う合計を求める
  const rows = d.accounts.map((a) => ({ account: a, fig: figuresFor(a, d.months, state.month, state.mode) }));
  const sectionTotal = (key) => rows
    .filter((r) => r.account.section === key)
    .reduce((a, r) => a + r.fig.closing, 0);

  const totalAssets = sectionTotal('asset');
  const totalRevenue = sectionTotal('revenue');

  const ratio = (r) => {
    const base = ['asset', 'liability', 'equity'].includes(r.account.section) ? totalAssets : totalRevenue;
    if (!base) return '—';
    return `${(r.fig.closing / base * 100).toFixed(2)}%`;
  };

  const scopeLabel = state.mode === 'monthly'
    ? `${state.month.replace('-', '年')}月の動き`
    : `${d.period.start} 〜 ${state.month.replace('-', '年')}月末の累計`;

  const grandDebit = rows.reduce((a, r) => a + r.fig.debit, 0);
  const grandCredit = rows.reduce((a, r) => a + r.fig.credit, 0);

  root.append(el(`
    <div class="summary">
      <span class="filterinfo">${esc(scopeLabel)}</span>
      <span>借方合計 <b>${yen(grandDebit)}</b></span>
      <span>貸方合計 <b>${yen(grandCredit)}</b></span>
      <span>${grandDebit === grandCredit
        ? '<b style="color:var(--good)">貸借一致</b>'
        : `<b class="neg">貸借不一致 ${yen(Math.abs(grandDebit - grandCredit))}</b>`}</span>
    </div>`));

  const body = [];
  for (const section of d.sections) {
    const inSection = rows.filter((r) => r.account.section === section.key);
    const visible = inSection.filter((r) => state.showEmpty || r.fig.debit || r.fig.credit || r.fig.opening || r.fig.closing);
    if (!visible.length) continue;

    body.push(`<tr class="sec"><td colspan="6">《${esc(section.label)}》</td></tr>`);

    const categories = [...new Set(visible.map((r) => r.account.category))]
      .sort((a, b) => catRank(a) - catRank(b));

    for (const category of categories) {
      const list = visible.filter((r) => r.account.category === category);
      if (category) body.push(`<tr class="cat"><td colspan="6">【${esc(category)}】</td></tr>`);

      for (const r of list) {
        body.push(`<tr>
          <td class="t-left">${esc(r.account.name)}</td>
          <td>${yen(r.fig.opening)}</td>
          <td>${r.fig.debit ? yen(r.fig.debit) : '—'}</td>
          <td>${r.fig.credit ? yen(r.fig.credit) : '—'}</td>
          <td class="${r.fig.closing < 0 ? 'neg' : ''}">${yen(r.fig.closing)}</td>
          <td>${ratio(r)}</td>
        </tr>`);
      }

      const sub = list.reduce((a, r) => ({
        opening: a.opening + r.fig.opening, debit: a.debit + r.fig.debit,
        credit: a.credit + r.fig.credit, closing: a.closing + r.fig.closing,
      }), { opening: 0, debit: 0, credit: 0, closing: 0 });
      body.push(`<tr class="sub">
        <td class="t-left">${esc(category || '区分なし')} 計</td>
        <td>${yen(sub.opening)}</td><td>${yen(sub.debit)}</td><td>${yen(sub.credit)}</td>
        <td>${yen(sub.closing)}</td><td></td>
      </tr>`);
    }

    const secSum = visible.reduce((a, r) => ({
      opening: a.opening + r.fig.opening, debit: a.debit + r.fig.debit,
      credit: a.credit + r.fig.credit, closing: a.closing + r.fig.closing,
    }), { opening: 0, debit: 0, credit: 0, closing: 0 });
    body.push(`<tr class="sectotal">
      <td class="t-left">${esc(section.label)} 合計</td>
      <td>${yen(secSum.opening)}</td><td>${yen(secSum.debit)}</td><td>${yen(secSum.credit)}</td>
      <td>${yen(secSum.closing)}</td><td></td>
    </tr>`);
  }

  root.append(el(`
    <div class="panel"><h2>合計残高試算表</h2>
      <p class="note">金額は税込。仕訳に仮払消費税・仮受消費税の科目が無いため、税抜で組むと貸借が一致しなくなります。</p>
      <table class="trial">
        <thead><tr>
          <th class="t-left">科目名</th><th>前残</th><th>借方金額</th><th>貸方金額</th><th>残高</th><th>構成比</th>
        </tr></thead>
        <tbody>${body.join('')}</tbody>
      </table>
    </div>`));

  // 損益のまとめ
  const profit = sectionTotal('revenue') - sectionTotal('expense') + sectionTotal('nonop');
  root.append(el(`
    <div class="summary">
      <span>収益 <b>${yen(sectionTotal('revenue'))}</b></span>
      <span>費用 <b>${yen(sectionTotal('expense'))}</b></span>
      <span>営業外損益 <b>${yen(sectionTotal('nonop'))}</b></span>
      <span class="filterinfo">当期損益 <b class="${profit < 0 ? 'neg' : ''}">${yen(profit)}</b></span>
    </div>`));
}

export async function load(root) {
  if (!state.data) root.innerHTML = '<div class="msg">読み込み中…</div>';
  const qs = new URLSearchParams();
  if (state.period) qs.set('period', state.period);
  try {
    const json = await api(`/api/trial-balance?${qs}`);
    state.data = json;
    state.period = String(json.period.no);
    if (!json.months.includes(state.month)) {
      // 既定は、動きのある最後の月
      const last = [...json.months].reverse()
        .find((m) => json.accounts.some((a) => a.byMonth[m].count > 0));
      state.month = last ?? json.months.at(-1);
    }
    render(root);
  } catch (err) {
    root.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
