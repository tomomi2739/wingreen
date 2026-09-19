/**
 * config/periods.json を読み、会計期とNotion DBの対応を解決する。
 * 新しい期の追加は config/periods.json への追記のみで完結し、このファイルの修正は不要。
 */

import { readFileSync } from 'node:fs';

const config = JSON.parse(
  readFileSync(new URL('../config/periods.json', import.meta.url), 'utf8'),
);

export const masters = config.masters;

/** 期の一覧（期番号の昇順） */
export function listPeriods() {
  return [...config.periods].sort((a, b) => a.no - b.no);
}

/** 期番号から期を取得する */
export function getPeriod(no) {
  const period = config.periods.find((p) => p.no === Number(no));
  if (!period) {
    const available = config.periods.map((p) => p.no).join(', ');
    throw new Error(`${no}期は config/periods.json に未登録です（登録済み: ${available}）`);
  }
  return period;
}

/** 指定日（省略時は今日）が属する期。該当が無ければ最新の期を返す */
export function getCurrentPeriod(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  const hit = config.periods.find((p) => p.start <= ymd && ymd <= p.end);
  return hit ?? listPeriods().at(-1);
}

/**
 * 期に属するDBのIDを取得する。
 * key: 'journal' | 'invoice' | 'invoiceItem'
 */
export function getPeriodDatabaseId(no, key) {
  const period = getPeriod(no);
  const db = period.databases[key];
  if (!db) throw new Error(`${period.label}に "${key}" のDB定義がありません`);
  if (!db.id) throw new Error(`${period.label}の「${db.label}」のDB IDが未設定です（config/periods.json）`);
  return db.id;
}

/** マスタDBのIDを取得する */
export function getMasterDatabaseId(key) {
  const db = masters[key];
  if (!db?.id) throw new Error(`マスタ "${key}" のDB IDが未設定です（config/periods.json）`);
  return db.id;
}

/** 期に含まれる年月を "YYYY-MM" の配列で返す（月次レポートの月セレクタ用） */
export function listMonths(no) {
  const { start, end } = getPeriod(no);
  const months = [];
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  const last = `${end.slice(0, 7)}`;
  while (true) {
    const ym = cursor.toISOString().slice(0, 7);
    months.push(ym);
    if (ym >= last) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
