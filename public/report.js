/** 月次レポート画面 */

import { yen, esc, el, svgEl, hoverable, barPath, niceStep, api } from './common.js';

const state = { data: null, month: 'total', statusFilter: 'all', period: '' };

// ステータスの表示色。名前が必ず隣にあるので、色だけで意味を運ばせない。
const STATUS_COLOR = {
  '承認':   'var(--good)',
  '確認済': 'var(--series-1)',
  '仮登録': 'var(--warning)',
  '却下':   'var(--critical)',
  '未設定': 'var(--text-muted)',
};

/* ---- 月次推移：売上・経費の縦棒 ＋ 営業利益の折れ線 ---- */
function trendChart(series) {
  if (series.every((s) => s.journalCount === 0)) {
    return el('<div class="msg">この条件に該当する仕訳がありません</div>');
  }

  const W = 1140, H = 320, L = 74, R = 18, T = 16, B = 34;
  const iw = W - L - R, ih = H - T - B;

  const vals = series.flatMap((s) => [s.net.revenue, s.net.expense, s.operatingProfit]);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const step = niceStep(max - min);
  const top = Math.ceil(max / step) * step, bottom = Math.floor(min / step) * step;
  const y = (v) => T + ih - ((v - bottom) / (top - bottom || 1)) * ih;
  // 刻みが1万円未満だと「万」表記では目盛りが潰れるので円表示に切り替える
  const tickLabel = (v) => (step >= 10000 ? `${(v / 10000).toLocaleString('ja-JP')}万` : yen(v));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '月次の売上・経費・営業利益の推移' });

  for (let v = bottom; v <= top + 1e-6; v += step) {
    svg.append(svgEl('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { class: 'tick', x: L - 10, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = tickLabel(v);
    svg.append(t);
  }

  const bandW = iw / series.length;
  const GAP = 2;                                   // 隣り合う棒の間にサーフェス色の隙間を残す
  const barW = Math.min(30, (bandW - 26 - GAP) / 2);

  series.forEach((s, i) => {
    const cx = L + bandW * i + bandW / 2;
    const label = svgEl('text', { class: 'cat', x: cx, y: H - B + 20, 'text-anchor': 'middle' });
    label.textContent = `${s.month.slice(5)}月`;
    svg.append(label);

    [
      { v: s.net.revenue, color: 'var(--series-1)', name: '売上' },
      { v: s.net.expense, color: 'var(--series-2)', name: '経費' },
    ].forEach((p, k) => {
      if (p.v <= 0) return;
      const x = cx - barW - GAP / 2 + k * (barW + GAP);
      const h = Math.abs(y(p.v) - y(0));
      svg.append(hoverable(
        svgEl('path', { class: 'bar', d: barPath(x, y(p.v), barW, h), fill: p.color }),
        `<b>${s.month}</b><br>${p.name} ${yen(p.v)}`,
      ));
    });

    // 当たり判定を月の帯全体に広げ、3系列まとめて読めるようにする
    svg.append(hoverable(
      svgEl('rect', { class: 'hit', x: L + bandW * i, y: T, width: bandW, height: ih }),
      `<b>${s.month}</b><br>売上 ${yen(s.net.revenue)}<br>経費 ${yen(s.net.expense)}<br>営業利益 ${yen(s.operatingProfit)}`,
    ));
  });

  // 仕訳がまだ無い月まで線を引くと「利益ゼロ」と誤読されるため、最後にデータのある月で止める
  let lastIdx = -1;
  series.forEach((s, i) => { if (s.journalCount > 0) lastIdx = i; });

  if (lastIdx >= 0) {
    const pts = series.slice(0, lastIdx + 1).map((s, i) => [L + bandW * i + bandW / 2, y(s.operatingProfit)]);
    if (pts.length > 1) {
      svg.append(svgEl('polyline', {
        points: pts.map((p) => p.join(',')).join(' '),
        fill: 'none', stroke: 'var(--series-3)', 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }
    pts.forEach(([px, py], i) => {
      svg.append(svgEl('circle', {
        cx: px, cy: py, r: 5, fill: 'var(--series-3)',
        stroke: 'var(--surface-1)', 'stroke-width': 2,   // 重なり回避のリング
      }));
      const profit = series[i].operatingProfit;
      if (profit === 0) return;
      // マイナスでもラベルは点の上に置く（下に出すと軸の月ラベルと衝突する）
      const t = svgEl('text', { class: 'val', x: px, y: py - 11, 'text-anchor': 'middle' });
      t.textContent = step >= 10000 ? `${Math.round(profit / 10000).toLocaleString('ja-JP')}万` : yen(profit);
      svg.append(t);
    });
  }

  // データがまだ無い月は薄く「—」を置き、ゼロと区別する
  series.forEach((s, i) => {
    if (i <= lastIdx || s.journalCount > 0) return;
    const t = svgEl('text', { class: 'tick', x: L + bandW * i + bandW / 2, y: y(0) - 8, 'text-anchor': 'middle' });
    t.textContent = '—';
    svg.append(t);
  });

  svg.append(svgEl('line', { class: 'axis-line', x1: L, x2: L, y1: T, y2: T + ih }));
  return svg;
}

/* ---- 内訳：横棒（単一系列なので凡例なし・値を直接ラベル） ---- */
function breakdownChart(entries, color, emptyText) {
  if (!entries.length) return el(`<div class="msg">${esc(emptyText)}</div>`);

  const rows = [...entries].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const LH = 34, W = 540, L = 132, R = 96, T = 6;
  const H = T * 2 + rows.length * LH;
  const iw = W - L - R;
  const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  const total = rows.reduce((a, [, v]) => a + v, 0);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  rows.forEach(([name, v], i) => {
    const yTop = T + i * LH + 7, bh = 20;
    const w = Math.max(1, (Math.abs(v) / max) * iw);

    const cat = svgEl('text', { class: 'cat', x: L - 12, y: yTop + 14, 'text-anchor': 'end' });
    cat.textContent = name;
    svg.append(cat);

    svg.append(svgEl('path', { d: barPath(L, yTop, w, bh, 4, 'right'), fill: color }));

    const vt = svgEl('text', { class: 'val', x: L + w + 10, y: yTop + 14 });
    vt.textContent = yen(v);
    svg.append(vt);

    const share = total ? Math.round((v / total) * 1000) / 10 : 0;
    svg.append(hoverable(
      svgEl('rect', { class: 'hit', x: 0, y: T + i * LH, width: W, height: LH }),
      `<b>${esc(name)}</b><br>${yen(v)}<br>構成比 ${share}%`,
    ));
  });
  return svg;
}

/* ---- 画面の組み立て ---- */
function scopeOf(d) {
  if (state.month === 'total') return { ...d.totals, label: `${d.period.label}累計` };
  const s = d.series.find((x) => x.month === state.month);
  return { ...s, label: `${s.month.replace('-', '年')}月` };
}

function render(root) {
  const d = state.data;
  root.innerHTML = '';

  const filters = el(`
    <div class="filters">
      <label for="periodSel">会計期</label>
      <select id="periodSel">${
        d.availablePeriods.map((p) => `<option value="${p.no}"${p.no === d.period.no ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
      }</select>
      <div class="seg" id="monthSeg"></div>
      <span class="right">
        <label for="statusSel">集計対象</label>
        <select id="statusSel">
          <option value="all">全件</option>
          <option value="approved">承認済のみ</option>
          <option value="unapproved">未承認のみ</option>
        </select>
      </span>
    </div>`);
  root.append(filters);

  const seg = filters.querySelector('#monthSeg');
  const mk = (key, text, empty) => {
    const b = el(`<button aria-pressed="${state.month === key}" class="${empty ? 'empty' : ''}">${text}</button>`);
    b.onclick = () => { state.month = key; render(root); };
    return b;
  };
  seg.append(mk('total', '期累計', false));
  d.series.forEach((s) => seg.append(mk(s.month, `${s.month.slice(5)}月`, s.journalCount === 0)));

  filters.querySelector('#periodSel').onchange = (e) => { state.period = e.target.value; load(root); };
  const statusSel = filters.querySelector('#statusSel');
  statusSel.value = state.statusFilter;
  statusSel.onchange = (e) => { state.statusFilter = e.target.value; load(root); };

  const sc = scopeOf(d);
  root.append(el(`
    <div class="tiles">
      <div class="tile"><div class="k">売上（税抜）</div><div class="v">${yen(sc.net.revenue)}</div><div class="n">税込 ${yen(sc.gross.revenue)}</div></div>
      <div class="tile"><div class="k">経費（税抜）</div><div class="v">${yen(sc.net.expense)}</div><div class="n">税込 ${yen(sc.gross.expense)}</div></div>
      <div class="tile"><div class="k">営業利益</div><div class="v${sc.operatingProfit < 0 ? ' neg' : ''}">${yen(sc.operatingProfit)}</div><div class="n">売上 − 経費</div></div>
      <div class="tile"><div class="k">経常利益</div><div class="v${sc.ordinaryProfit < 0 ? ' neg' : ''}">${yen(sc.ordinaryProfit)}</div><div class="n">仕訳 ${sc.journalCount}件 / ${esc(sc.label)}</div></div>
    </div>`));

  const trend = el(`<div class="panel"><h2>月次推移</h2>
    <p class="note">税抜ベース。棒が売上と経費、折れ線が営業利益。仕訳がまだ無い月は「—」。</p>
    <div class="legend">
      <span><i class="swatch" style="background:var(--series-1)"></i>売上</span>
      <span><i class="swatch" style="background:var(--series-2)"></i>経費</span>
      <span><i class="swatch" style="background:var(--series-3)"></i>営業利益</span>
    </div></div>`);
  trend.append(trendChart(d.series));
  root.append(trend);

  const cols = el('<div class="cols"></div>');
  const rev = el(`<div class="panel"><h2>売上内訳</h2><p class="note">貸方の補助科目別・${esc(sc.label)}</p></div>`);
  rev.append(breakdownChart(Object.entries(sc.revenueBreakdown), 'var(--series-1)', 'この期間の売上仕訳はまだありません'));
  const exp = el(`<div class="panel"><h2>経費内訳</h2><p class="note">借方の勘定科目別・${esc(sc.label)}</p></div>`);
  exp.append(breakdownChart(Object.entries(sc.expenseBreakdown), 'var(--series-2)', 'この期間の経費仕訳はまだありません'));
  cols.append(rev, exp);
  root.append(cols);

  // 承認状況
  const st = sc.byStatus;
  const stRows = d.statuses.filter((k) => st[k].count > 0);
  const stTotal = d.statuses.reduce((a, k) => a + st[k].count, 0);
  const approved = st['承認'].count;
  root.append(el(`
    <div class="panel"><h2>承認状況</h2>
      <p class="note">${esc(sc.label)}・仕訳 ${stTotal}件のうち 承認済 ${approved}件 / 未承認 ${stTotal - approved}件</p>
      <div class="statusbar">${
        stRows.map((k) => `<i style="background:${STATUS_COLOR[k]};flex:${st[k].count}"></i>`).join('')
        || '<i style="background:var(--grid);flex:1"></i>'
      }</div>
      <table>
        <thead><tr><th>ステータス</th><th>件数</th><th>売上</th><th>経費</th></tr></thead>
        <tbody>${(stRows.length ? stRows : d.statuses).map((k) => `
          <tr class="${st[k].count === 0 ? 'zero' : ''}">
            <td class="status-cell"><i class="dot" style="background:${STATUS_COLOR[k]}"></i>${esc(k)}</td>
            <td>${st[k].count}</td>
            <td>${st[k].count ? yen(st[k].revenue) : '—'}</td>
            <td>${st[k].count ? yen(st[k].expense) : '—'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`));

  // 一覧表（グラフと同じ数字を必ず文字でも読めるようにする）
  const rows = d.series.map((s) => {
    if (s.journalCount === 0) {
      return `<tr class="zero"><td>${s.month}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>0</td><td>—</td></tr>`;
    }
    const pending = s.journalCount - s.byStatus['承認'].count;
    return `<tr>
      <td>${s.month}</td><td>${yen(s.net.revenue)}</td><td>${yen(s.net.expense)}</td>
      <td class="${s.operatingProfit < 0 ? 'neg' : ''}">${yen(s.operatingProfit)}</td>
      <td class="${s.ordinaryProfit < 0 ? 'neg' : ''}">${yen(s.ordinaryProfit)}</td>
      <td>${s.journalCount}</td><td>${pending > 0 ? pending : '—'}</td>
    </tr>`;
  }).join('');

  root.append(el(`
    <div class="panel"><h2>月次一覧</h2><p class="note">税抜ベース</p>
      <table>
        <thead><tr><th>年月</th><th>売上</th><th>経費</th><th>営業利益</th><th>経常利益</th><th>仕訳件数</th><th>うち未承認</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td>${esc(d.period.label)}累計</td><td>${yen(d.totals.net.revenue)}</td><td>${yen(d.totals.net.expense)}</td>
          <td class="${d.totals.operatingProfit < 0 ? 'neg' : ''}">${yen(d.totals.operatingProfit)}</td>
          <td class="${d.totals.ordinaryProfit < 0 ? 'neg' : ''}">${yen(d.totals.ordinaryProfit)}</td>
          <td>${d.totals.journalCount}</td>
          <td>${d.totals.journalCount - d.totals.byStatus['承認'].count || '—'}</td>
        </tr></tfoot>
      </table>
    </div>`));

  const sk = d.skipped;
  const dropped = Object.values(sk).reduce((a, b) => a + b, 0);
  if (dropped > 0) {
    root.append(el(`<div class="msg">集計から除外した仕訳 ${dropped}件 —
      日付なし ${sk.noDate} / 期間外 ${sk.outOfPeriod} / 集計対象の絞り込み ${sk.byStatusFilter} / 損益科目なし ${sk.noAccount}</div>`));
  }
}

export async function load(root) {
  root.innerHTML = '<div class="msg">読み込み中…</div>';
  const qs = new URLSearchParams();
  if (state.period) qs.set('period', state.period);
  if (state.statusFilter !== 'all') qs.set('status', state.statusFilter);
  try {
    const json = await api(`/api/monthly-report?${qs}`);
    state.data = json;
    state.period = String(json.period.no);
    if (state.month !== 'total' && !json.months.includes(state.month)) state.month = 'total';
    render(root);
  } catch (err) {
    root.innerHTML = `<div class="msg err">読み込みに失敗しました: ${esc(err.message)}</div>`;
  }
}
