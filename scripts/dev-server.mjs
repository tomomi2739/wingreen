/**
 * ローカル開発用の簡易サーバー（本番はVercelが同等の役割を担う）。
 *
 *   npm run dev   →  http://localhost:3000
 *
 * public/ を静的配信し、/api/xxx を api/xxx.mjs の default export に振り分ける。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

// .env を読み込む（api/配下がprocess.envを参照するため、起動時に流し込む）
try {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  console.warn('.env が読めませんでした。NOTION_TOKEN_WG が未設定だとAPIは失敗します。');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Vercelのハンドラ互換の res を組み立てる */
function decorateResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => { res.end(body); return res; };
  return res;
}

/** VercelのNodeランタイムに合わせ、JSONボディを req.body に載せる */
async function readJsonBody(req) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function serveApi(name, req, res, url) {
  const file = join(ROOT, 'api', `${name}.mjs`);
  try {
    await stat(file);
  } catch {
    return res.status(404).json({ error: `/api/${name} は存在しません` });
  }

  // 毎回キャッシュを外して読み込み、編集が即座に反映されるようにする
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  req.query = Object.fromEntries(url.searchParams);
  req.body = await readJsonBody(req);
  await mod.default(req, res);
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = join(ROOT, 'public', normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  decorateResponse(res);
  try {
    if (url.pathname.startsWith('/api/')) {
      await serveApi(url.pathname.slice('/api/'.length), req, res, url);
    } else {
      await serveStatic(url.pathname, res);
    }
  } catch (err) {
    console.error(err);
    if (!res.writableEnded) res.status(500).json({ error: err.message });
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT} で起動しました`);
});
