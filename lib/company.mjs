/**
 * 請求書に印字する自社情報。
 *
 * リポジトリは公開されているため、口座番号・インボイス登録番号・連絡先といった
 * 外に出したくない値はJSONに書かず、環境変数から読む。
 * JSON側には登記簿で公開済みの情報（会社名・住所・代表者名）だけを置く。
 */

import { readFileSync } from 'node:fs';

const base = JSON.parse(
  readFileSync(new URL('../config/company.json', import.meta.url), 'utf8'),
);

const env = (key) => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : '';
};

export const company = {
  ...base,
  // 未設定なら空文字。請求書側は空の項目を出力しない作りになっている。
  postalCode: env('WG_POSTAL_CODE') || base.postalCode || '',
  tel: env('WG_TEL') || base.tel || '',
  email: env('WG_EMAIL') || base.email || '',
  invoiceRegistrationNumber: env('WG_INVOICE_REG_NO'),
  bank: {
    name: env('WG_BANK_NAME'),
    branch: env('WG_BANK_BRANCH'),
    accountType: env('WG_BANK_ACCOUNT_TYPE'),
    accountNumber: env('WG_BANK_ACCOUNT_NUMBER'),
    accountHolder: env('WG_BANK_ACCOUNT_HOLDER'),
  },
};

export default company;
