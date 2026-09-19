/**
 * 各DBの実データを確認するためのローカル実行専用スクリプト（読み取りのみ）。
 *
 *   node scripts/notion-dump.mjs
 *
 * マスタの登録内容と、仕訳・請求書の件数＆サンプルを表示する。
 */

import { readFileSync } from 'node:fs';
import { queryDatabaseAll, flattenPage } from '../lib/notion.mjs';
import { masters, getPeriodDatabaseId, getCurrentPeriod } from '../lib/periods.mjs';

function loadEnv() {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

const head = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'-'.repeat(70)}`);

async function main() {
  loadEnv();
  const period = getCurrentPeriod();

  // 勘定科目マスタ（リレーション解決用にIDと名前の対応も作る）
  const accounts = (await queryDatabaseAll(masters.accounts.id)).map(flattenPage);
  const accountName = new Map(accounts.map((a) => [a._id, a['科目名']]));

  head(`勘定科目マスタ WG（${accounts.length}件）`);
  const byType = {};
  for (const a of accounts) (byType[a['科目タイプ']] ??= []).push(a);
  for (const [type, list] of Object.entries(byType)) {
    console.log(`\n【${type}】`);
    for (const a of list) console.log(`  ${a['科目名']}  — 分類:${a['分類']} / 税区分:${a['税区分']}`);
  }

  // 補助科目マスタ
  const subs = (await queryDatabaseAll(masters.subAccounts.id)).map(flattenPage);
  head(`補助科目マスタ WG（${subs.length}件）`);
  for (const s of subs.sort((x, y) => (x['表示順'] ?? 0) - (y['表示順'] ?? 0))) {
    const parent = (s['所属勘定科目'] ?? []).map((id) => accountName.get(id) ?? '?').join(',');
    console.log(`  [${s['表示順'] ?? '-'}] ${s['補助科目名']}  ← ${parent || '(所属なし)'}  ${s['有効'] ? '' : '※無効'}`);
  }

  // 固定費マスタ
  const fixed = (await queryDatabaseAll(masters.fixedCosts.id)).map(flattenPage);
  head(`固定費マスタ WG（${fixed.length}件）`);
  for (const f of fixed) {
    const acc = (f['勘定科目'] ?? []).map((id) => accountName.get(id) ?? '?').join(',');
    console.log(`  ${f['費目名']}  ¥${f['月額（税込）'] ?? 0}  ${acc}  ${f['支払方法']}/${f['支払日']}  ${f['有効'] ? '' : '※無効'}`);
  }

  // 取引先・支払先
  const clients = (await queryDatabaseAll(masters.clients.id)).map(flattenPage);
  head(`取引先マスタ WG（${clients.length}件）`);
  for (const c of clients) console.log(`  ${c['会社名/氏名']}  支払サイクル:${c['支払サイクル'] ?? '-'}`);

  const payees = (await queryDatabaseAll(masters.payees.id)).map(flattenPage);
  head(`支払先マスタ WG（${payees.length}件）`);
  for (const p of payees) console.log(`  ${p['氏名/名称']}  区分:${p['区分'] ?? '-'} / ${p['法人/個人'] ?? '-'} / 源泉:${p['源泉徴収対象'] ? 'あり' : 'なし'}`);

  // 仕訳明細
  const journals = (await queryDatabaseAll(getPeriodDatabaseId(period.no, 'journal'))).map(flattenPage);
  head(`${period.databases.journal.label}（${journals.length}件）`);
  for (const j of journals.slice(0, 10)) {
    const dr = (j['借方勘定科目'] ?? []).map((id) => accountName.get(id) ?? '?').join(',');
    const cr = (j['貸方勘定科目'] ?? []).map((id) => accountName.get(id) ?? '?').join(',');
    console.log(`  ${j['取引日'] ?? '日付なし'}  ${j['名前']}  借:${dr || '-'} / 貸:${cr || '-'}  ¥${j['金額（税込）'] ?? 0}  [${j['税区分'] ?? '-'}] ${j['承認ステータス'] ?? '-'}`);
  }
  if (journals.length > 10) console.log(`  …ほか${journals.length - 10}件`);

  // 請求書
  const invoices = (await queryDatabaseAll(getPeriodDatabaseId(period.no, 'invoice'))).map(flattenPage);
  head(`${period.databases.invoice.label}（${invoices.length}件）`);
  for (const iv of invoices.slice(0, 10)) {
    console.log(`  ${iv['ID']}  ${iv['件名']}  発行:${iv['発行日'] ?? '-'} 期日:${iv['支払期日'] ?? '-'}  税抜¥${iv['小計（税抜）'] ?? 0} → 税込¥${iv['合計（税込）'] ?? 0}  [${iv['ステータス']}]`);
  }
}

main().catch((e) => { console.error(`\nエラー: ${e.message}`); process.exit(1); });
