/** 経理確認。投稿で仮登録になった仕訳に、証憑を見ながら科目を入れて確定する。 */

import { yen, esc, ymd, el, api } from './common.js';

const state = { data: null, period: '' };

const opt = (list, selected, placeholder) =>
  `<option value="">${esc(placeholder)}</option>` +
  list.map((x) => {
    const value = typeof x === 'string' ? x : x.id;
    const label = typeof x === 'string' ? x : x.name;
    return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');

/** 選んだ勘定科目に属する補助科目だけを返す */
function subsFor(accountId) {
  if (!accountId) return [];
  return state.data.options.subAccounts
    .filter((s) => s.active && s.parents.includes(accountId))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 添付の表示。画像はそのまま出し、PDFはリンクにする。 */
function attachment(files) {
  if (!files.length) return '<div class="msg">証憑が添付されていません</div>';
  return files.map((f, i) => {
    const url = f.url ?? '';
    const name = f.name || `証憑${i + 1}`;
    const isPdf = /\.pdf($|\?)/i.test(name) || /\.pdf($|\?)/i.test(url);
    return isPdf
      ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} を開く</a>`
      : `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="shot" src="${esc(url)}" alt="${esc(name)}"></a>`;
  }).join('');
}

function card(item) {
  const o = state.data.options;
  const node = el(`
    <div class="panel review" data-page="${esc(item.pageId)}">
      <h2>${esc(item.name || '(名前なし)')}</h2>
      <p class="note">${ymd(item.date)}　/　${item.amount != null ? yen(item.amount) : '金額未読み取り'}</p>

      <div class="review-body">
        <div class="shots">${attachment(item.files)}</div>
        <div>
          <div class="readout">
            <h3>読み取り結果</h3>
            <pre>${esc(item.memo) || '（読み取り結果はありません）'}</pre>
          </div>
        </div>
      </div>

      <div class="grid">
        <label>取引日<input type="date" name="date" value="${esc(item.date)}"></label>
        <label>名前<input type="text" name="name" value="${esc(item.name)}"></label>
        <label>金額（税込）<input type="number" name="amount" value="${item.amount ?? ''}"></label>
        <label>税区分<select name="taxCategory">${opt(o.taxCategories, item.taxCategory, '未設定')}</select></label>
        <label>借方勘定科目<select name="debitAccountId">${opt(o.accounts, item.debitAccountId, '選択してください')}</select></label>
        <label>借方補助科目<select name="debitSubId"></select></label>
        <label>貸方勘定科目<select name="creditAccountId">${opt(o.accounts, item.creditAccountId, '選択してください')}</select></label>
        <label>貸方補助科目<select name="creditSubId"></select></label>
        <label>支払先<select name="payeeId">${opt(o.payees, item.payeeId, 'なし')}</select></label>
        <label>取引先<select name="clientId">${opt(o.clients, item.clientId, 'なし')}</select></label>
      </div>

      <div class="actions">
        <button class="btn primary" data-act="confirm">確定する</button>
        <button class="btn" data-act="reject">対象外にする</button>
        <span class="sub" data-role="note"></span>
      </div>
    </div>`);

  // 勘定科目を選ぶと、その科目の補助科目だけに入れ替える
  const bind = (accountName, subName, selectedSubId) => {
    const acc = node.querySelector(`[name="${accountName}"]`);
    const sub = node.querySelector(`[name="${subName}"]`);
    const fill = (keep) => { sub.innerHTML = opt(subsFor(acc.value), keep ?? '', 'なし'); };
    fill(selectedSubId);
    acc.onchange = () => fill('');
  };
  bind('debitAccountId', 'debitSubId', item.debitSubId);
  bind('creditAccountId', 'creditSubId', item.creditSubId);

  const note = node.querySelector('[data-role="note"]');
  const value = (n) => node.querySelector(`[name="${n}"]`).value;

  for (const btn of node.querySelectorAll('[data-act]')) {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      if (act === 'confirm' && (!value('debitAccountId') || !value('creditAccountId'))) {
        note.innerHTML = '<span class="msg err" style="padding:2px 8px">借方と貸方の勘定科目を選んでください</span>';
        return;
      }
      if (act === 'reject' && !confirm(`${item.name || 'この証憑'} を対象外（却下）にします。よろしいですか。`)) return;

      node.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      note.textContent = act === 'confirm' ? '確定中…' : '処理中…';
      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            period: state.period,
            pageId: item.pageId,
            action: act,
            date: value('date'),
            name: value('name'),
            amount: value('amount'),
            taxCategory: value('taxCategory'),
            debitAccountId: value('debitAccountId'),
            debitSubId: value('debitSubId'),
            creditAccountId: value('creditAccountId'),
            creditSubId: value('creditSubId'),
            payeeId: value('payeeId'),
            clientId: value('clientId'),
            memo: item.memo,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        node.remove();
        const host = document.getElementById('view');
        const left = host.querySelectorAll('.panel.review').length;
        host.querySelector('[data-role="count"]').textContent = `未処理 ${left}件`;
        if (!left) host.querySelector('[data-role="empty"]')?.classList.remove('hidden');
      } catch (err) {
        note.innerHTML = `<span class="msg err" style="padding:2px 8px">${esc(err.message)}</span>`;
        node.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    };
  }
  return node;
}

function render(root) {
  const d = state.data;
  root.innerHTML = '';

  root.append(el(`
    <div class="filters">
      <label for="rPeriod">会計期</label>
      <select id="rPeriod">${
        d.period.available.map((p) => `<option value="${p.no}"${p.no === d.period.no ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
      }</select>
      <span class="filterinfo" data-role="count">未処理 ${d.count}件</span>
      ${d.ocrEnabled ? '' : '<span class="sub">読み取りは未設定（GEMINI_API_KEY_WG）</span>'}
    </div>`));
  root.querySelector('#rPeriod').onchange = (e) => { state.period = e.target.value; load(root); };

  root.append(el(`<div class="msg${d.count ? ' hidden' : ''}" data-role="empty">確認待ちの証憑はありません</div>`));
  for (const item of d.items) root.append(card(item));
}

export async function load(root) {
  if (!state.data) root.innerHTML = '<div class="msg">読み込み中…</div>';
  const qs = new URLSearchParams();
  if (state.period) qs.set('period', state.period);
  try {
    const json = await api(`/api/review?${qs}`);
    state.data = json;
    state.period = String(json.period.no);
    render(root);
  } catch (err) {
    root.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
