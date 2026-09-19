/**
 * Notion側の実際のDB構造を確認するためのローカル実行専用スクリプト。
 *
 *   node scripts/notion-schema.mjs
 *
 * インテグレーションに接続済みのDBを検索し、末尾が "WG" のものについて
 * プロパティ名・型・選択肢・リレーション先を一覧表示する。
 * 結果は notion-schema.json にも保存する（.gitignore 済み）。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const NOTION_VERSION = '2022-06-28';

// .env を読む（依存パッケージなし）
function loadEnv() {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env が無い場合は環境変数のみで動かす
  }
}

async function notion(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN_WG}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json;
}

// 接続済みのDBをすべて取得（ページネーション対応）
async function fetchAllDatabases() {
  const results = [];
  let cursor;
  do {
    const page = await notion('/search', {
      filter: { property: 'object', value: 'database' },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

const plainTitle = (db) => (db.title ?? []).map((t) => t.plain_text).join('').trim();

// プロパティ1件を人間が読める1行に整形する
function describeProperty(name, prop) {
  const parts = [`  - ${JSON.stringify(name)}  [${prop.type}]`];
  switch (prop.type) {
    case 'select':
    case 'multi_select':
    case 'status': {
      // 選択肢名自体に "/" を含むことがあるため、1件ずつ引用符で囲んで境界を明示する
      const opts = (prop[prop.type].options ?? []).map((o) => JSON.stringify(o.name));
      if (opts.length) parts.push(`      選択肢(${opts.length}件): ${opts.join(', ')}`);
      break;
    }
    case 'relation':
      parts.push(`      リレーション先DB ID: ${prop.relation.database_id}`);
      break;
    case 'rollup':
      parts.push(`      rollup: ${prop.rollup.function} of ${prop.rollup.rollup_property_name} via ${prop.rollup.relation_property_name}`);
      break;
    case 'formula':
      parts.push(`      式: ${prop.formula.expression}`);
      break;
    case 'number':
      parts.push(`      表示形式: ${prop.number.format}`);
      break;
    case 'unique_id':
      parts.push(`      プレフィックス: ${prop.unique_id.prefix ?? '(なし)'}`);
      break;
  }
  return parts.join('\n');
}

async function main() {
  loadEnv();
  if (!process.env.NOTION_TOKEN_WG) {
    console.error('NOTION_TOKEN_WG が未設定です。.env.example をコピーして .env を作り、トークンを記入してください。');
    process.exit(1);
  }

  const all = await fetchAllDatabases();
  const wg = all.filter((db) => plainTitle(db).includes('WG'));

  console.log(`インテグレーションに接続済みのDB: ${all.length}件 / うち名前に"WG"を含む: ${wg.length}件\n`);

  if (wg.length === 0) {
    console.log('名前に"WG"を含むDBが見つかりません。Notion側で各DBの「…」→「接続」からインテグレーションを追加してください。');
    console.log('接続済みのDB名一覧:');
    for (const db of all) console.log(`  - ${plainTitle(db) || '(無題)'}`);
    return;
  }

  const snapshot = {};
  for (const db of wg) {
    const title = plainTitle(db);
    console.log('='.repeat(70));
    console.log(`${title}`);
    console.log(`  DB ID: ${db.id}`);
    console.log(`  プロパティ数: ${Object.keys(db.properties).length}`);
    console.log('-'.repeat(70));
    for (const [name, prop] of Object.entries(db.properties)) {
      console.log(describeProperty(name, prop));
    }
    console.log('');
    snapshot[title] = {
      id: db.id,
      properties: Object.fromEntries(
        Object.entries(db.properties).map(([name, p]) => [name, { id: p.id, type: p.type }]),
      ),
    };
  }

  // DB ID を .env に貼りやすい形でも出しておく
  console.log('='.repeat(70));
  console.log('DB ID一覧（.env に貼る用の下書き）');
  console.log('-'.repeat(70));
  for (const db of wg) {
    console.log(`# ${plainTitle(db)}\n${db.id}`);
  }

  writeFileSync(new URL('../notion-schema.json', import.meta.url), JSON.stringify(snapshot, null, 2));
  console.log('\nnotion-schema.json に保存しました。');
}

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  process.exit(1);
});
