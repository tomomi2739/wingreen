/**
 * サイト全体のアクセス制限（Basic認証）。
 *
 * Vercel Hobbyプランにはデプロイ保護が無く、デプロイすると
 * 売上・利益・取引先名・選手名がURLを知る誰にでも見えてしまうため、
 * 静的HTMLよりも前段のここで止める。
 *
 * 環境変数:
 *   WG_PASSWORD … 必須。未設定なら「開いてしまう」のではなく塞ぐ（フェイルクローズ）。
 *   WG_USER     … 任意。既定は "wingreen"。
 */

const REALM = 'WinGreen';

/** 文字列比較にかかる時間を入力内容によらず一定に近づける */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const unauthorized = (message) =>
  new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });

export default function middleware(request) {
  const password = process.env.WG_PASSWORD;

  // パスワード未設定のまま公開されるのが最悪のケースなので、その場合は全面的に拒否する
  if (!password) {
    return new Response(
      'WG_PASSWORD が設定されていないため、アクセスを停止しています。Vercelの環境変数を設定してください。',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

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

  const expectedUser = process.env.WG_USER || 'wingreen';
  if (!safeEqual(user, expectedUser) || !safeEqual(pass, password)) {
    return unauthorized('ユーザー名またはパスワードが違います');
  }

  // 認証を通過。何も返さなければ本来のルーティングに処理が渡る。
  return undefined;
}
