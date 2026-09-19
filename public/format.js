/**
 * 表示の整形ルール。
 *
 * PDF（サーバー側の lib/invoice-pdf.mjs）と画面（public/invoices.js）の
 * 両方からこのファイルを読み込む。片方だけ直して表示が食い違うのを防ぐため、
 * 実装を1か所に集約している。DOMには一切触れないこと。
 */

/**
 * 明細の数量表示。
 * 「数量1」と「一式」は意味が違うので、数量の値から単位を推測しない。
 *
 *   単位が「一式」        → 「一式」（数量は出さない）
 *   単位あり・数量2・個   → 「2個」
 *   単位が空・数量1200    → 「1,200」
 */
export function qtyText(item) {
  const unit = String(item?.unit ?? '').trim();
  if (unit === '一式') return '一式';
  const n = Math.round(Number(item?.quantity) || 0).toLocaleString('ja-JP');
  return unit ? `${n}${unit}` : n;
}
