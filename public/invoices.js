/** 請求書画面：一覧 → 明細確認 → PDFプレビュー → 発行 */

import { yen, esc, ymd, el, api } from './common.js';

const state = { data: null, period: '', selectedId: null, detail: null, busy: false };

const STATUS_CLASS = { '下書き': '', '発行済み': 'issued', '入金済み': 'paid' };

function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] ?? ''}">${esc(status ?? '—')}</span>`;
}

/* ---- 選択した請求書の明細と操作 ---- */
function renderDetail(host, root) {
  const d = state.detail;
  host.innerHTML = '';

  if (!d) {
    host.append(el('<div class="msg">一覧から請求書を選ぶと、明細とPDFプレビューが表示されます</div>'));
    return;
  }

  const iv = d.invoice;
  const itemRows = d.items.length
    ? d.items.map((it) => `<tr>
        <td>${esc(it.name)}</td>
        <td>${Number(it.quantity ?? 0).toLocaleString('ja-JP')}</td>
        <td>${yen(it.unitPrice)}</td>
        <td>${yen(it.amount)}</td>
      </tr>`).join('')
    : '<tr class="zero"><td colspan="4">明細が登録されていません</td></tr>';

  const panel = el(`
    <div class="panel">
      <h2>${esc(iv.number ?? '')}　${esc(iv.subject || '(件名未設定)')}</h2>
      <p class="note">${esc(iv.clientName || '取引先未設定')}　/　発行日 ${ymd(iv.issueDate)}　/　支払期日 ${ymd(iv.dueDate)}　/　${iv.status ?? ''}</p>
      <table>
        <thead><tr><th>品目</th><th>数量</th><th>単価</th><th>金額（税抜）</th></tr></thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr><td>小計（税抜）</td><td></td><td></td><td>${yen(iv.subtotal)}</td></tr>
          <tr><td>消費税</td><td></td><td></td><td>${yen(iv.tax)}</td></tr>
          <tr><td>合計（税込）</td><td></td><td></td><td>${yen(iv.total)}</td></tr>
        </tfoot>
      </table>
      <div class="actions">
        <button class="btn" id="btnPreview">PDFプレビュー</button>
        <button class="btn primary" id="btnIssue">${iv.status === '下書き' ? '発行する' : '再発行する'}</button>
        <span id="issueNote" class="sub"></span>
      </div>
      <div id="previewHost"></div>
    </div>`);
  host.append(panel);

  const note = panel.querySelector('#issueNote');
  const previewHost = panel.querySelector('#previewHost');
  const btnIssue = panel.querySelector('#btnIssue');

  if (!d.items.length) {
    btnIssue.disabled = true;
    note.textContent = '明細が無いため発行できません';
  } else if (iv.status !== '下書き') {
    note.textContent = '発行済みです。再発行するとNotionのPDFが差し替わります';
  }

  panel.querySelector('#btnPreview').onclick = () => {
    const url = `/api/issue-invoice?period=${encodeURIComponent(state.period)}&id=${encodeURIComponent(iv.id)}`;
    previewHost.innerHTML = `<iframe class="preview" src="${url}" title="請求書プレビュー"></iframe>`;
  };

  btnIssue.onclick = async () => {
    const msg = iv.status === '下書き'
      ? `${iv.number} を発行します。\n\nNotionの請求書にPDFを添付し、ステータスを「発行済み」に変更します。よろしいですか。`
      : `${iv.number} を再発行します。\n\nNotionに添付済みのPDFが新しいものに差し替わります。よろしいですか。`;
    if (!confirm(msg)) return;

    state.busy = true;
    btnIssue.disabled = true;
    note.textContent = '発行中…';
    try {
      const res = await fetch('/api/issue-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: state.period, id: iv.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      note.innerHTML = `<span class="msg ok" style="padding:2px 8px">発行しました（${esc(json.filename)}）</span>`;
      await load(root);                               // 一覧とステータスを取り直す
    } catch (err) {
      note.innerHTML = `<span class="msg err" style="padding:2px 8px">発行に失敗しました: ${esc(err.message)}</span>`;
      btnIssue.disabled = false;
    } finally {
      state.busy = false;
    }
  };
}

async function select(id, host, root) {
  state.selectedId = id;
  host.innerHTML = '<div class="msg">読み込み中…</div>';
  try {
    state.detail = await api(`/api/invoices?period=${encodeURIComponent(state.period)}&id=${encodeURIComponent(id)}`);
    renderDetail(host, root);
  } catch (err) {
    host.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}

function render(root) {
  const d = state.data;
  root.innerHTML = '';

  root.append(el(`
    <div class="filters">
      <label for="invPeriodSel">会計期</label>
      <select id="invPeriodSel">
        <option value="${d.period.no}">${esc(d.period.label)}</option>
      </select>
      <span class="sub">${d.invoices.length}件</span>
    </div>`));

  const list = el(`
    <div class="panel"><h2>請求書一覧</h2>
      <p class="note">行を選ぶと明細とPDFプレビューが開きます</p>
      <table>
        <thead><tr>
          <th>番号</th><th>件名</th><th>取引先</th><th>発行日</th><th>支払期日</th>
          <th>合計（税込）</th><th>ステータス</th><th>PDF</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>`);
  const tbody = list.querySelector('tbody');

  if (!d.invoices.length) {
    tbody.append(el('<tr class="zero"><td colspan="8">請求書がまだありません</td></tr>'));
  }

  const detailHost = document.createElement('div');

  for (const iv of d.invoices) {
    const tr = el(`<tr class="clickable${iv.id === state.selectedId ? ' selected' : ''}" tabindex="0">
      <td>${esc(iv.number ?? '')}</td>
      <td>${esc(iv.subject || '(件名未設定)')}</td>
      <td>${esc(iv.clientName || '—')}</td>
      <td>${ymd(iv.issueDate)}</td>
      <td>${ymd(iv.dueDate)}</td>
      <td>${yen(iv.total)}</td>
      <td style="text-align:right">${statusBadge(iv.status)}</td>
      <td>${iv.hasPdf ? 'あり' : '—'}</td>
    </tr>`);
    const open = () => {
      tbody.querySelectorAll('tr').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      select(iv.id, detailHost, root);
    };
    tr.onclick = open;
    tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    tbody.append(tr);
  }

  root.append(list, detailHost);

  if (state.selectedId && d.invoices.some((iv) => iv.id === state.selectedId)) {
    select(state.selectedId, detailHost, root);
  } else {
    renderDetail(detailHost, root);
  }
}

export async function load(root) {
  if (!state.data) root.innerHTML = '<div class="msg">読み込み中…</div>';
  const qs = new URLSearchParams();
  if (state.period) qs.set('period', state.period);
  try {
    const json = await api(`/api/invoices?${qs}`);
    state.data = json;
    state.period = String(json.period.no);
    render(root);
  } catch (err) {
    root.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
