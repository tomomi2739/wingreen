/**
 * Notion APIの薄いラッパー。api/配下のサーバーレス関数から共通利用する。
 * （lib/配下はサーバーレス関数としてカウントされない）
 */

// DB取得・ページ更新は 2022-06-28 で固定する。
// 新しいバージョンではデータベースとデータソースが分離され、クエリの形が変わるため。
const NOTION_VERSION = '2022-06-28';
// ファイルアップロードのエンドポイントだけは、このバージョン以上でないと利用できない。
const FILE_UPLOAD_VERSION = '2026-03-11';
const API_BASE = 'https://api.notion.com/v1';

export function getToken() {
  const token = process.env.NOTION_TOKEN_WG;
  if (!token) throw new Error('NOTION_TOKEN_WG が未設定です');
  return token;
}

async function request(path, { method = 'GET', body, version = NOTION_VERSION, form } = {}) {
  const headers = {
    Authorization: `Bearer ${getToken()}`,
    'Notion-Version': version,
  };
  // FormData のときは Content-Type を自前で付けない（boundary が壊れるため）
  if (!form) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message ?? `Notion API ${res.status}`);
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

/** DBを1ページ分クエリする */
export function queryDatabase(databaseId, body = {}) {
  return request(`/databases/${databaseId}/query`, { method: 'POST', body });
}

/** DBの全ページをページネーション込みで取得する */
export async function queryDatabaseAll(databaseId, body = {}) {
  const results = [];
  let cursor;
  do {
    const page = await queryDatabase(databaseId, {
      page_size: 100,
      ...body,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** DBのスキーマ（プロパティ定義）を取得する */
export function retrieveDatabase(databaseId) {
  return request(`/databases/${databaseId}`);
}

export function createPage(body) {
  return request('/pages', { method: 'POST', body });
}

export function updatePage(pageId, body) {
  return request(`/pages/${pageId}`, { method: 'PATCH', body });
}

/**
 * ファイルをNotionにアップロードし、file_upload の ID を返す。
 * 20MiB以下は single_part で送れる（請求書PDFは十分収まる）。
 */
export async function uploadFile(bytes, filename, contentType = 'application/pdf') {
  const created = await request('/file_uploads', {
    method: 'POST',
    version: FILE_UPLOAD_VERSION,
    body: { mode: 'single_part', filename, content_type: contentType },
  });

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);

  const sent = await request(`/file_uploads/${created.id}/send`, {
    method: 'POST',
    version: FILE_UPLOAD_VERSION,
    form,
  });

  if (sent.status !== 'uploaded') {
    throw new Error(`ファイルのアップロードが完了しませんでした（status: ${sent.status}）`);
  }
  return sent.id;
}

/** ワークスペースの1ファイルあたりの上限バイト数を調べる（無料プランは5MiB） */
export async function getMaxFileUploadSize() {
  const me = await request('/users/me', { version: FILE_UPLOAD_VERSION });
  return me.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? null;
}

/**
 * Notionのプロパティ値を素のJSに変換する。
 * プロパティ「名」は各DBの実データを確認してから指定すること（推測しない）。
 */
export function readProperty(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':      return prop.title.map((t) => t.plain_text).join('');
    case 'rich_text':  return prop.rich_text.map((t) => t.plain_text).join('');
    case 'number':     return prop.number;
    case 'select':     return prop.select?.name ?? null;
    case 'status':     return prop.status?.name ?? null;
    case 'multi_select': return prop.multi_select.map((o) => o.name);
    case 'date':       return prop.date?.start ?? null;
    case 'checkbox':   return prop.checkbox;
    case 'email':      return prop.email;
    case 'phone_number': return prop.phone_number;
    case 'url':        return prop.url;
    case 'relation':   return prop.relation.map((r) => r.id);
    case 'unique_id':  return prop.unique_id
      ? [prop.unique_id.prefix, prop.unique_id.number].filter(Boolean).join('-')
      : null;
    case 'formula':    return prop.formula?.[prop.formula.type] ?? null;
    case 'rollup':     return prop.rollup?.type === 'number' ? prop.rollup.number : null;
    case 'created_time':     return prop.created_time;
    case 'last_edited_time': return prop.last_edited_time;
    default:           return null;
  }
}

/** ページ全体を { プロパティ名: 値 } のフラットな形に変換する */
export function flattenPage(page) {
  const out = { _id: page.id };
  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    out[name] = readProperty(prop);
  }
  return out;
}
