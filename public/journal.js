/** 仕訳明細画面。税理士との共有を前提に、1件ずつ追えることを優先している。 */

import { yen, esc, ymd, el, api } from './common.js';

const state = {
  data: null,
  period: '',
  month: 'all',
  account: '',
  taxCategory: '',
  status: '',
  query: '',
  attention: '',     // 要確認の絞り込み（'noTaxCategory' など）
  selectedId: null,
};

const ATTENTION_LABEL = {
  noDate:        ['取引日なし',   (r) => !r.date],
  noTaxCategory: ['税区分が未入力', (r) => !r.taxCategory],
  noStatus:      ['承認ステータス未設定', (r) => !r.status],
  rejected:      ['却下',         (r) => r.status === '却下'],
  noAccount:     ['勘定科目が未設定', (r) => !r.debit.account || !r.credit.account],
};

function visibleRows() {
  const d = state.data;
  const q = state.query.trim().toLowerCase();
  const attn = ATTENTION_LABEL[state.attention]?.[1];

  return d.rows.filter((r) => {
    if (state.month !== 'all' && (r.date ?? '').slice(0, 7) !== state.month) return false;
    if (state.account && r.debit.account !== state.account && r.credit.account !== state.account) return false;
    if (state.taxCategory && r.taxCategory !== state.taxCategory) return false;
    if (state.status && r.status !== state.status) return false;
    if (attn && !attn(r)) return false;
    if (q) {
      const hay = [
        r.name, r.memo, r.debit.account, r.debit.sub, r.credit.account, r.credit.sub,
        r.payee, r.client, r.invoices, r.taxCategory, r.status,
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ---- CSV出力（税理士が会計ソフトに取り込めるように） ---- */
const CSV_COLUMNS = [
  ['取引日',        (r) => r.date ?? ''],
  ['名前',          (r) => r.name],
  ['摘要',          (r) => r.memo],
  ['借方勘定科目',   (r) => r.debit.account],
  ['借方補助科目',   (r) => r.debit.sub],
  ['貸方勘定科目',   (r) => r.credit.account],
  ['貸方補助科目',   (r) => r.credit.sub],
  ['税区分',        (r) => r.taxCategory],
  ['税込金額',      (r) => r.gross],
  ['税抜金額',      (r) => r.net],
  ['消費税額',      (r) => r.tax],
  ['仕入税額控除',   (r) => r.deductible],
  ['承認ステータス', (r) => r.status],
  ['支払先',        (r) => r.payee],
  ['取引先',        (r) => r.client],
  ['請求書',        (r) => r.invoices],
  ['レシートキー',   (r) => r.receiptKey],
];

function downloadCsv(rows, label) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    CSV_COLUMNS.map(([h]) => cell(h)).join(','),
    ...rows.map((r) => CSV_COLUMNS.map(([, get]) => cell(get(r))).join(',')),
  ];
  // ExcelでUTF-8と認識させるためBOMを付ける
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `仕訳明細_${label}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---- 1件の詳細 ---- */
function renderDetail(host, row) {
  host.innerHTML = '';
  if (!row) return;

  const receipts = row.receipts.length
    ? row.receipts.map((f, i) =>
        `<a href="${esc(f.url ?? '#')}" target="_blank" rel="noopener">${esc(f.name || `証票${i + 1}`)}</a>`).join('　')
    : '—';

  host.append(el(`
    <div class="panel">
      <h2>${esc(row.name || '(名前なし)')}</h2>
      <p class="note">${ymd(row.date)}　/　${esc(row.taxCategory || '税区分未入力')}　/　${esc(row.status || '承認ステータス未設定')}</p>
      <dl class="detail">
        <dt>借方</dt><dd>${esc(row.debit.account || '—')}${row.debit.sub ? `　（補助: ${esc(row.debit.sub)}）` : ''}${row.debit.category ? `　<span style="color:var(--text-muted)">${esc(row.debit.category)}</span>` : ''}</dd>
        <dt>貸方</dt><dd>${esc(row.credit.account || '—')}${row.credit.sub ? `　（補助: ${esc(row.credit.sub)}）` : ''}${row.credit.category ? `　<span style="color:var(--text-muted)">${esc(row.credit.category)}</span>` : ''}</dd>
        <dt>金額（税込）</dt><dd>${yen(row.gross)}</dd>
        <dt>税抜金額</dt><dd>${yen(row.net)}</dd>
        <dt>消費税額</dt><dd>${yen(row.tax)}</dd>
        <dt>仕入税額控除</dt><dd>${yen(row.deductible)}</dd>
        <dt>摘要</dt><dd>${esc(row.memo) || '—'}</dd>
        <dt>支払先</dt><dd>${esc(row.payee) || '—'}</dd>
        <dt>取引先</dt><dd>${esc(row.client) || '—'}</dd>
        <dt>請求書</dt><dd>${esc(row.invoices) || '—'}</dd>
        <dt>証票画像</dt><dd>${receipts}</dd>
        <dt>レシートキー</dt><dd>${esc(row.receiptKey) || '—'}</dd>
      </dl>
      <p class="note" style="padding-left:0;margin-top:12px">証票画像のリンクはNotionが発行する一時URLです。時間が経つと開けなくなるので、その場合は画面を再読み込みしてください。</p>
    </div>`));
}

/* ---- 画面 ---- */
function render(root) {
  const d = state.data;
  root.innerHTML = '';

  const opt = (list, sel, label) =>
    `<option value="">${label}</option>` +
    list.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

  const filters = el(`
    <div class="filters">
      <label for="jPeriod">会計期</label>
      <select id="jPeriod">${
        d.period.available.map((p) => `<option value="${p.no}"${p.no === d.period.no ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
      }</select>
      <div class="seg" id="jMonth"></div>
      <select id="jAccount">${opt(d.options.accounts, state.account, 'すべての勘定科目')}</select>
      <select id="jTax">${opt(d.options.taxCategories, state.taxCategory, 'すべての税区分')}</select>
      <select id="jStatus">${opt(d.options.statuses, state.status, 'すべての承認状態')}</select>
      <input type="search" class="search" id="jQuery" placeholder="摘要・相手先で検索" value="${esc(state.query)}">
      <span class="right"><button class="btn" id="jCsv">CSVで書き出す</button></span>
    </div>`);
  root.append(filters);

  const seg = filters.querySelector('#jMonth');
  const mk = (key, text) => {
    const b = el(`<button aria-pressed="${state.month === key}">${text}</button>`);
    b.onclick = () => { state.month = key; render(root); };
    return b;
  };
  seg.append(mk('all', '期全体'));
  d.months.forEach((m) => seg.append(mk(m, `${m.slice(5)}月`)));

  filters.querySelector('#jPeriod').onchange = (e) => { state.period = e.target.value; state.selectedId = null; load(root); };
  filters.querySelector('#jAccount').onchange = (e) => { state.account = e.target.value; render(root); };
  filters.querySelector('#jTax').onchange = (e) => { state.taxCategory = e.target.value; render(root); };
  filters.querySelector('#jStatus').onchange = (e) => { state.status = e.target.value; render(root); };

  const q = filters.querySelector('#jQuery');
  q.oninput = (e) => {
    state.query = e.target.value;
    render(root);
    // 再描画で入力欄が作り直されるため、カーソルを戻す
    const next = root.querySelector('#jQuery');
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  };

  // 要確認の件数。押すとその条件だけに絞る
  const attn = el('<div class="attention"></div>');
  const hits = Object.entries(d.attention).filter(([, n]) => n > 0);
  if (!hits.length) {
    attn.append(el('<span class="none">要確認の仕訳はありません</span>'));
  } else {
    for (const [key, n] of hits) {
      const b = el(`<button aria-pressed="${state.attention === key}">${ATTENTION_LABEL[key][0]} ${n}件</button>`);
      b.onclick = () => { state.attention = state.attention === key ? '' : key; render(root); };
      if (state.attention === key) b.style.background = 'color-mix(in srgb, var(--warning) 22%, transparent)';
      attn.append(b);
    }
    if (state.attention) {
      const c = el('<button class="clear">絞り込みを解除</button>');
      c.onclick = () => { state.attention = ''; render(root); };
      attn.append(c);
    }
  }
  root.append(attn);

  const rows = visibleRows();
  const sum = rows.reduce((a, r) => ({
    gross: a.gross + r.gross, net: a.net + r.net, tax: a.tax + r.tax,
  }), { gross: 0, net: 0, tax: 0 });

  const scopeLabel = state.month === 'all' ? `${d.period.label}全体` : `${state.month.replace('-', '年')}月`;
  root.append(el(`
    <div class="summary">
      <span>${esc(scopeLabel)}</span>
      <span>表示 <b>${rows.length}</b> 件 / 全 ${d.rows.length} 件</span>
      <span>税込 <b>${yen(sum.gross)}</b></span>
      <span>税抜 <b>${yen(sum.net)}</b></span>
      <span>消費税 <b>${yen(sum.tax)}</b></span>
    </div>`));

  // 絞り込み中に「1期全体」というファイル名で渡すと全件だと誤解されるため、状態を名前に残す
  const filtered = Boolean(state.account || state.taxCategory || state.status || state.query.trim() || state.attention);
  filters.querySelector('#jCsv').onclick = () =>
    downloadCsv(rows, filtered ? `${scopeLabel}_絞り込み${rows.length}件` : scopeLabel);

  const panel = el(`
    <div class="panel"><h2>仕訳明細</h2>
      <p class="note">取引日の新しい順。行を選ぶと証票画像や関連する請求書まで確認できます。</p>
      <table>
        <thead><tr>
          <th>取引日</th><th class="t-left">摘要</th>
          <th class="t-left col-debit">借方</th><th class="t-left col-credit">貸方</th>
          <th class="t-left">税区分</th><th>税込金額</th><th>税抜金額</th><th>消費税</th><th class="t-left">承認</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>`);
  const tbody = panel.querySelector('tbody');
  const detailHost = document.createElement('div');

  if (!rows.length) {
    tbody.append(el('<tr class="zero"><td colspan="9">条件に合う仕訳がありません</td></tr>'));
  }

  const entryCell = (side, cls) => `
    <td class="entry ${cls}">
      <span class="acc">${esc(side.account || '—')}</span>
      ${side.sub ? `<span class="sub2">${esc(side.sub)}</span>` : ''}
    </td>`;

  for (const r of rows) {
    const tr = el(`<tr class="clickable${r.id === state.selectedId ? ' selected' : ''}" tabindex="0">
      <td>${r.date ? ymd(r.date) : '<span class="warnchip">日付なし</span>'}</td>
      <td class="t-left">${esc(r.name || '—')}${r.memo ? `<span class="sub2">${esc(r.memo)}</span>` : ''}</td>
      ${entryCell(r.debit, 'col-debit')}
      ${entryCell(r.credit, 'col-credit')}
      <td class="t-left">${r.taxCategory ? esc(r.taxCategory) : '<span class="warnchip">未入力</span>'}</td>
      <td>${yen(r.gross)}</td>
      <td>${yen(r.net)}</td>
      <td>${yen(r.tax)}</td>
      <td class="t-left">${r.status ? esc(r.status) : '<span class="warnchip">未設定</span>'}</td>
    </tr>`);
    const open = () => {
      state.selectedId = r.id;
      tbody.querySelectorAll('tr').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      renderDetail(detailHost, r);
      detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    tr.onclick = open;
    tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    tbody.append(tr);
  }

  root.append(panel, detailHost);

  const selected = rows.find((r) => r.id === state.selectedId);
  if (selected) renderDetail(detailHost, selected);
}

export async function load(root) {
  if (!state.data) root.innerHTML = '<div class="msg">読み込み中…</div>';
  const qs = new URLSearchParams();
  if (state.period) qs.set('period', state.period);
  try {
    const json = await api(`/api/journal?${qs}`);
    state.data = json;
    state.period = String(json.period.no);
    if (state.month !== 'all' && !json.months.includes(state.month)) state.month = 'all';
    render(root);
  } catch (err) {
    root.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
