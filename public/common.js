/** 画面共通のユーティリティ。月次レポートと請求書の両方から使う。 */

export const yen = (n) => '¥' + Math.round(n ?? 0).toLocaleString('ja-JP');
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const ymd = (s) => (s ? `${s.slice(0, 4)}/${s.slice(5, 7)}/${s.slice(8, 10)}` : '—');

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export const NS = 'http://www.w3.org/2000/svg';
export function svgEl(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/* ---- ツールチップ ---- */
let tip;
function tipEl() {
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  return tip;
}
export function showTip(e, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.style.opacity = '1';
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export const hideTip = () => { if (tip) tip.style.opacity = '0'; };

/** ホバーで説明を出す図形にする。当たり判定はマークより大きめに取っておくこと。 */
export function hoverable(node, html) {
  node.addEventListener('mousemove', (e) => showTip(e, html));
  node.addEventListener('mouseleave', hideTip);
  return node;
}

/* ---- グラフの部品 ---- */

/** データ端だけ4px丸め、基線側は角のままにする */
export function barPath(x, y, w, h, r = 4, dir = 'up') {
  const rr = Math.min(r, w / 2, Math.max(h, 0));
  if (h <= 0.5) return `M${x} ${y} h${w}`;
  if (dir === 'up') {
    return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} `
      + `L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
  }
  return `M${x} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} `
    + `L${x + w} ${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} L${x} ${y + h} Z`;
}

/** 目盛りの刻み幅を 1/2/5×10^n から選ぶ */
export function niceStep(range, target = 4) {
  if (range <= 0) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/** APIを叩いてJSONを返す。エラーはメッセージ付きで投げる。 */
export async function api(path) {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
