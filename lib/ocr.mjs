/**
 * 証憑（レシート・請求書・支払明細書など）の読み取り。
 *
 * GEMINI_API_KEY_WG が未設定なら読み取りを行わず null を返す。
 * 鍵が無くても投稿そのものは成立させたいので、ここでは例外を投げない。
 */

// 軽いモデルから順に試す。混雑時や一時的な失敗で止まらないようにするため。
const MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];

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

/**
 * @returns {Promise<null | {date, amount, vendor, invoiceRegistrationNumber, documentType, text, model}>}
 *   鍵が無い場合と、すべてのモデルで失敗した場合は null。
 */
export async function readDocument(base64, contentType) {
  const key = process.env.GEMINI_API_KEY_WG;
  if (!key) return null;

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: contentType, data: base64 } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body },
      );
      if (!res.ok) {
        console.warn(`OCR ${model}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = parseJson(text);
      if (!parsed) { console.warn(`OCR ${model}: JSONとして読めない応答`); continue; }

      const amount = Number(parsed.amount);
      return {
        date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? '') ? parsed.date : '',
        amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
        vendor: String(parsed.vendor ?? '').trim(),
        // Tで始まる13桁という形式に合うものだけ採用する
        invoiceRegistrationNumber: /^T\d{13}$/.test(String(parsed.invoiceRegistrationNumber ?? '').trim())
          ? String(parsed.invoiceRegistrationNumber).trim() : '',
        documentType: String(parsed.documentType ?? '').trim(),
        text: String(parsed.text ?? '').trim(),
        model,
      };
    } catch (err) {
      console.warn(`OCR ${model}: ${err.message}`);
    }
  }
  return null;
}
