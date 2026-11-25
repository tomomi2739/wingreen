/**
 * 証憑（レシート・請求書・支払明細書など）の読み取り。
 *
 * GEMINI_API_KEY_WG が未設定なら読み取りを行わない。
 * 鍵が無くても、混雑していても、投稿そのものは成立させたいので例外は投げない。
 * 代わりに「読めたか／読めなかったか、その理由」を必ず返し、
 * 呼び出し側が摘要に書き残せるようにする（黙って空欄にしない）。
 */

// 固定版を先に、latest別名を後ろに並べる。
// latest別名はGoogle側が新モデルを出すたび中身が入れ替わり（事前通知はメールのみ・2週間前）、
// 読み取りの癖が一晩で変わりうる。普段は固定版で動かし、
// 固定版が提供終了になったときの保険としてlatestを残しておく。
const MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

// 無料枠は1分あたりの回数が少ない。まとめて投稿されると超過しやすいので、
// 少し待って出し直す。
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_WAITS_MS = [1200, 4000];

// 読み取り全体の持ち時間。これを超えたら諦めて投稿を先に進める。
// 投稿APIはこのあとNotionへの画像アップロードも行うので、関数の制限時間を使い切らないこと。
const BUDGET_MS = 25_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = `あなたは日本の経理担当者です。画像またはPDFは日本の領収書・レシート・請求書・支払明細書のいずれかです。
次のJSONだけを返してください。説明文は不要です。

{
  "date": "取引日。YYYY-MM-DD。読み取れなければ空文字",
  "amount": 税込の合計金額を表す整数。読み取れなければ null,
  "vendor": "発行元の店名・会社名。読み取れなければ空文字",
  "invoiceRegistrationNumber": "適格請求書発行事業者の登録番号。Tで始まる13桁の数字が続く形式。記載が無ければ空文字",
  "documentType": "レシート / 請求書 / 支払明細書 / その他 のいずれか",
  "text": "記載されている文字をそのまま書き起こしたもの"
}

注意:
- 金額は税込の支払総額。小計や税抜額ではなく、実際に支払う金額を選ぶこと
- 日付が和暦なら西暦に直すこと
- 登録番号は見た目が似た数字列と混同しないこと。必ず T で始まるものだけを拾う`;

function parseJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 1モデルに対して1回だけ投げる。待つべき失敗かどうかも返す。 */
async function callOnce(model, key, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, retryable: RETRY_STATUS.has(res.status), detail };
  }
  return { ok: true, json: await res.json() };
}

/**
 * @returns {Promise<{ok: true, data: object} | {ok: false, reason: string}>}
 *   reason は摘要にそのまま書ける短い日本語。
 */
export async function readDocument(base64, contentType) {
  const key = process.env.GEMINI_API_KEY_WG;
  if (!key) return { ok: false, reason: '読み取りキーが未設定' };

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: contentType, data: base64 } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  let lastReason = '読み取りに失敗';
  let sawQuota = false;
  const deadline = Date.now() + BUDGET_MS;

  for (const model of MODELS) {
    if (Date.now() >= deadline) { lastReason = '読み取りが時間内に終わらず'; break; }

    // 混雑・回数超過のときだけ、同じモデルで少し待って出し直す
    for (let attempt = 0; ; attempt += 1) {
      let call;
      try {
        call = await callOnce(model, key, body);
      } catch (err) {
        lastReason = '読み取り先に接続できず';
        console.warn(`OCR ${model}: ${err.message}`);
        break;
      }

      if (!call.ok) {
        console.warn(`OCR ${model}: HTTP ${call.status} ${String(call.detail).slice(0, 300)}`);
        if (call.status === 429) { sawQuota = true; lastReason = '読み取りの無料枠が上限に達した可能性'; }
        else if (call.status === 404) lastReason = `モデル ${model} が見つからない`;
        else if (call.status === 403) lastReason = '読み取りキーが無効または権限不足';
        else lastReason = `読み取り先がHTTP ${call.status}`;

        const wait = RETRY_WAITS_MS[attempt];
        if (call.retryable && wait != null && Date.now() + wait < deadline) {
          await sleep(wait);
          continue;         // 同じモデルでもう一度
        }
        break;              // 次のモデルへ
      }

      const text = call.json?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = parseJson(text);
      if (!parsed) {
        lastReason = '読み取り結果をJSONとして解釈できず';
        console.warn(`OCR ${model}: JSONとして読めない応答`);
        break;              // 待っても直らないので次のモデルへ
      }

      const amount = Number(parsed.amount);
      return {
        ok: true,
        data: {
          date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? '') ? parsed.date : '',
          amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
          vendor: String(parsed.vendor ?? '').trim(),
          // Tで始まる13桁という形式に合うものだけ採用する
          invoiceRegistrationNumber: /^T\d{13}$/.test(String(parsed.invoiceRegistrationNumber ?? '').trim())
            ? String(parsed.invoiceRegistrationNumber).trim() : '',
          documentType: String(parsed.documentType ?? '').trim(),
          text: String(parsed.text ?? '').trim(),
          model,
        },
      };
    }
  }

  // 全モデルで枠に当たったなら、原因は枠と言い切ってよい
  if (sawQuota) lastReason = '読み取りの無料枠が上限に達した可能性';
  return { ok: false, reason: lastReason };
}
