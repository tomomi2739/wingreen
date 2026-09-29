#!/bin/bash
# 請求書PDF用フォントの作成。
#
# pdf-libは日本語フォントのサブセット化が正しく動かない（文字が無言で欠ける）ため、
# 全埋め込みにせざるを得ない。そのままだとPDFが1.2MBを超えるので、
# 帳票に使わない字種（ギリシャ・キリル・ラテン拡張・装飾記号）を
# あらかじめ落としたフォントを用意しておく。
#
# 日本語・英数の範囲は1文字も削っていない（漢字・かな・半角全角形はすべて維持）。
#
#   bash scripts/build-font.sh
#
# 必要: python3 と fonttools（pip install fonttools）

set -euo pipefail
cd "$(dirname "$0")/.."

SRC_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/mplus1p/MPLUS1p-Regular.ttf"
LICENSE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/mplus1p/OFL.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "元フォントを取得中..."
curl -sL -o "$TMP/full.ttf" "$SRC_URL"
curl -sL -o assets/fonts/OFL.txt "$LICENSE_URL"

# 残す範囲：英数記号・かな・漢字・半角全角形・日本語文書で使う記号
RANGES="U+0020-007E,U+00A0-00FF,U+2000-206F,U+2103,U+212B,U+2160-217F,U+2190-2193,\
U+2460-24FF,U+25A0-25FF,U+3000-303F,U+3040-309F,U+30A0-30FF,U+31F0-31FF,\
U+3300-33FF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF"

echo "サブセット化中..."
python3 -m fontTools.subset "$TMP/full.ttf" \
  --unicodes="$RANGES" \
  --layout-features='' --no-hinting --desubroutinize \
  --output-file=assets/fonts/MPLUS1p-Regular-subset.ttf

ls -l assets/fonts/MPLUS1p-Regular-subset.ttf | awk '{printf "完成: %.0f KB\n", $5/1024}'
