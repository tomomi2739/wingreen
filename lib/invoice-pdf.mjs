/**
 * 請求書PDFの組版。Notionの知識は持たず、渡されたデータだけを描画する。
 * 日本語はサブセット化すると字が欠けるため、フォントは全埋め込みにしている。
 */

import { readFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
// 画面(public/invoices.js)と同じ整形ルールを使う。表示が食い違わないよう実装を共有している。
import { qtyText } from '../public/format.js';

const FONT_PATH = new URL('../assets/fonts/MPLUS1p-Regular.ttf', import.meta.url);

const A4 = { w: 595.28, h: 841.89 };
const M = 48;                       // 余白
const INK = rgb(0.05, 0.05, 0.05);
const SUB = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.80, 0.80, 0.80);
const BRAND = rgb(0.24, 0.65, 0.63);  // ロゴに合わせた青緑
const BG = rgb(0.96, 0.97, 0.97);

const yen = (n) => '¥' + Math.round(n ?? 0).toLocaleString('ja-JP');
const ymd = (s) => (s ? `${s.slice(0, 4)}年${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日` : '—');

export async function buildInvoicePdf({ company, invoice, client, items, logoBytes }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync(FONT_PATH), { subset: false });

  const logo = logoBytes ? await pdf.embedPng(logoBytes) : null;

  let page = pdf.addPage([A4.w, A4.h]);
  const Y = (top) => A4.h - top;                       // 上からの距離で位置を指定する
  const w = (t, size) => font.widthOfTextAtSize(t, size);

  const text = (t, top, x, size = 9.5, color = INK) =>
    page.drawText(String(t ?? ''), { x, y: Y(top), size, font, color });
  const textRight = (t, top, right, size = 9.5, color = INK) =>
    page.drawText(String(t ?? ''), { x: right - w(String(t ?? ''), size), y: Y(top), size, font, color });
  const textCenter = (t, top, size = 9.5, color = INK) =>
    page.drawText(String(t ?? ''), { x: (A4.w - w(String(t ?? ''), size)) / 2, y: Y(top), size, font, color });
  /** 指定幅に収まるところで切り、末尾に…を付ける（長い品目名が数量欄に食い込むのを防ぐ） */
  const fit = (t, size, maxWidth) => {
    let str = String(t ?? '');
    if (w(str, size) <= maxWidth) return str;
    while (str.length > 1 && w(`${str}…`, size) > maxWidth) str = str.slice(0, -1);
    return `${str}…`;
  };
  const line = (top, x1, x2, color = RULE, thickness = 0.8) =>
    page.drawLine({ start: { x: x1, y: Y(top) }, end: { x: x2, y: Y(top) }, thickness, color });

  /* ---- ヘッダー ---- */
  if (logo) {
    const size = 56;
    page.drawImage(logo, { x: A4.w - M - size, y: Y(96), width: size, height: size });
  }
  textCenter('請 求 書', 66, 21);
  line(78, (A4.w - 120) / 2, (A4.w + 120) / 2, BRAND, 1.2);

  /* ---- 請求先 ---- */
  const clientName = client?.name ?? invoice.clientName ?? '';
  text(clientName ? `${clientName}　御中` : '（取引先が未設定です）', 130, M, 15);
  line(138, M, M + 250, RULE);
  if (client?.address) text(client.address, 156, M, 9, SUB);
  if (client?.contact) text(`ご担当: ${client.contact}`, 170, M, 9, SUB);

  /* ---- 請求書情報（右上） ---- */
  const R = A4.w - M;
  const meta = [
    ['請求書番号', invoice.number ?? '—'],
    ['発行日', ymd(invoice.issueDate)],
    ['支払期日', ymd(invoice.dueDate)],
  ];
  meta.forEach(([k, v], i) => {
    const top = 130 + i * 15;
    textRight(k, top, R - 92, 9, SUB);
    textRight(v, top, R, 9.5);
  });

  /* ---- ご請求金額 ---- */
  text('下記の通りご請求申し上げます。', 200, M, 10, SUB);

  const boxTop = 214, boxH = 52;
  page.drawRectangle({ x: M, y: Y(boxTop + boxH), width: A4.w - M * 2, height: boxH, color: BG });
  page.drawRectangle({ x: M, y: Y(boxTop + boxH), width: 4, height: boxH, color: BRAND });
  text('ご請求金額（税込）', boxTop + 21, M + 18, 10, SUB);
  // 金額はすべて同じ右端（ページ右端から8pt内側）に揃える。
  // ここだけボックスの内側余白を基準にすると、下の金額列と縦線がずれる。
  textRight(yen(invoice.total), boxTop + 36, R - 8, 22);

  /* ---- 明細テーブル ---- */
  const COL = { name: M, qty: 330, unit: 400, amount: R };
  let top = 300;

  const header = () => {
    // drawRectangle の y は矩形の下端。見出し文字のベースライン(top+10)を帯の中に収める。
    page.drawRectangle({ x: M, y: Y(top + 16), width: A4.w - M * 2, height: 22, color: BG });
    text('品目', top + 10, COL.name + 8, 9, SUB);
    textRight('数量', top + 10, COL.qty + 40, 9, SUB);
    textRight('単価', top + 10, COL.unit + 60, 9, SUB);
    textRight('金額', top + 10, COL.amount - 8, 9, SUB);
    top += 26;
  };
  header();

  const rows = items.length
    ? items
    : [{ name: '（明細が登録されていません）', quantity: null, unitPrice: null, amount: 0 }];

  for (const it of rows) {
    // 紙面の下端に近づいたら改ページして見出しを引き継ぐ
    if (top > A4.h - 260) {
      page = pdf.addPage([A4.w, A4.h]);
      top = 70;
      header();
    }
    // 数量は右揃えなので、その文字が実際に始まる位置から逆算して品目名を打ち切る。
    // 固定幅で切ると、単位付きで数量が長くなったときに重なる。
    const qty = it.quantity === null ? '' : qtyText(it);
    const qtyLeft = COL.qty + 40 - w(qty, 9.5);
    text(fit(it.name, 9.5, qtyLeft - 10 - (COL.name + 8)), top + 10, COL.name + 8, 9.5);
    if (qty) textRight(qty, top + 10, COL.qty + 40, 9.5);
    if (it.unitPrice !== null) textRight(yen(it.unitPrice), top + 10, COL.unit + 60, 9.5);
    textRight(yen(it.amount), top + 10, COL.amount - 8, 9.5);
    if (it.note) text(fit(it.note, 8, COL.amount - 8 - (COL.name + 8)), top + 22, COL.name + 8, 8, SUB);
    top += it.note ? 34 : 24;
    line(top - 6, M, R, RULE, 0.5);
  }

  /* ---- 合計（税率ごとに区分して記載する） ---- */
  top += 10;
  const totals = [
    ['小計（税抜）', yen(invoice.subtotal)],
    [`消費税（${Math.round((company.taxRate ?? 0.1) * 100)}%対象）`, yen(invoice.tax)],
  ];
  totals.forEach(([k, v]) => {
    textRight(k, top + 10, COL.unit + 60, 9.5, SUB);
    textRight(v, top + 10, R - 8, 9.5);
    top += 20;
  });
  line(top - 4, COL.unit - 40, R, RULE);
  top += 6;
  textRight('合計（税込）', top + 12, COL.unit + 60, 11);
  textRight(yen(invoice.total), top + 12, R - 8, 13);
  top += 28;

  if (invoice.note) {
    text('備考', top + 12, M, 9, SUB);
    text(invoice.note, top + 26, M, 9);
    top += 40;
  }

  /* ---- 自社情報（右下） ---- */
  const footTop = Math.max(top + 24, A4.h - 200);
  const lines = [
    [company.name, 11],
    [[company.postalCode && `〒${company.postalCode}`, company.address].filter(Boolean).join(' '), 9],
    [[company.tel && `TEL: ${company.tel}`, company.email].filter(Boolean).join('　'), 9],
    [company.representative && `${company.representativeTitle ?? ''} ${company.representative}`, 9],
    // 登録番号は取得できるまで行ごと出さない（空欄の「T」だけ印字されるのを避ける）
    [company.invoiceRegistrationNumber && `登録番号: ${company.invoiceRegistrationNumber}`, 9],
  ].filter(([t]) => t);

  let ft = footTop;
  for (const [t, size] of lines) { text(t, ft, M, size, size >= 11 ? INK : SUB); ft += size + 5; }

  const bank = company.bank ?? {};
  if (bank.name) {
    const label = [bank.name, bank.branch, bank.accountType, bank.accountNumber].filter(Boolean).join(' ');
    text('お振込先', footTop, A4.w / 2 + 20, 9, SUB);
    text(label, footTop + 16, A4.w / 2 + 20, 9.5);
    if (bank.accountHolder) text(`口座名義: ${bank.accountHolder}`, footTop + 30, A4.w / 2 + 20, 9);
  } else {
    text('お振込先: 別途ご連絡いたします', footTop + 16, A4.w / 2 + 20, 9, SUB);
  }

  if (company.paymentNote) text(company.paymentNote, A4.h - 60, M, 8, SUB);

  return await pdf.save();
}
