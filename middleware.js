/**
 * サイト全体のアクセス制限（Basic認証）。
 *
 * Vercel Hobbyプランにはデプロイ保護が無く、デプロイすると
 * 売上・利益・取引先名・選手名がURLを知る誰にでも見えてしまうため、
 * 静的HTMLよりも前段のここで止める。
 *
 * 一度認証したら、以後はクッキーで通す（ブラウザを再起動しても聞かれない）。
 * クッキーの値はパスワードから導くので、パスワードを変えれば自動的に無効になる。
 *
 * 環境変数:
 *   WG_PASSWORD … 必須。未設定なら「開いてしまう」のではなく塞ぐ（フェイルクローズ）。
 *   WG_USER     … 任意。既定は "wingreen"。
 */

const REALM = 'WinGreen';
const COOKIE = 'wg_auth';
const MAX_AGE = 60 * 60 * 24 * 90;   // 90日
// クッキーを受け付けない環境で繰り返しリダイレクトしないための目印
const GUARD = '_a';

/** 文字列比較にかかる時間を入力内容によらず一定に近づける */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** パスワードからクッキーの値を導く。パスワードそのものは入れない。 */
async function tokenFor(user, password) {
  const data = new TextEncoder().encode(`${user}:${password}:wingreen-auth-v1`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieValue(request, name) {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

const unauthorized = (message) =>
  new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });

export default async function middleware(request) {
  const password = process.env.WG_PASSWORD;

  // パスワード未設定のまま公開されるのが最悪のケースなので、その場合は全面的に拒否する
  if (!password) {
    return new Response(
      'WG_PASSWORD が設定されていないため、アクセスを停止しています。Vercelの環境変数を設定してください。',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const expectedUser = process.env.WG_USER || 'wingreen';
  const token = await tokenFor(expectedUser, password);

  // 一度通っていればクッキーだけで通す
  if (safeEqual(cookieValue(request, COOKIE), token)) return undefined;

  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return unauthorized('認証が必要です');

  let decoded;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return unauthorized('認証情報を読み取れませんでした');
  }

  const sep = decoded.indexOf(':');
  const user = sep === -1 ? '' : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (!safeEqual(user, expectedUser) || !safeEqual(pass, password)) {
    return unauthorized('ユーザー名またはパスワードが違います');
  }

  // 認証できたので、次回からクッキーで通せるようにする。
  // 本来のルーティングに渡したまま Set-Cookie を足す手段が無いため、
  // 同じURLへ一度だけ転送してクッキーを配る。
  const url = new URL(request.url);
  const alreadyTried = url.searchParams.has(GUARD);
  const isNavigation = request.method === 'GET' || request.method === 'HEAD';

  if (!alreadyTried && isNavigation) {
    url.searchParams.set(GUARD, '1');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // クッキーを受け付けない環境でも、Basic認証が正しければそのまま通す
  return undefined;
}
