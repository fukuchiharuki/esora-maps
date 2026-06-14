#!/usr/bin/env bash
# =====================================================================
# Esora Maps をローカル配信して動作確認する。
#
# ES モジュールは file:// 不可なので HTTP 配信が必要。配信対象は src/main
# （アプリ本体＋PWA）のみ。src/test は配信しない。
# 依存は Python3 標準ライブラリだけ（ビルド・追加依存なし）。
#
# 使い方:  tools/serve.sh [PORT]      （省略時 8000）
#          NO_OPEN=1 tools/serve.sh   （ブラウザを自動で開かない）
#   停止:  Ctrl-C
# =====================================================================
set -euo pipefail

PORT="${1:-${PORT:-8000}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/src/main"
URL="http://localhost:$PORT/"

command -v python3 >/dev/null || { echo "python3 が必要です" >&2; exit 1; }
[ -f "$DIR/index.html" ] || { echo "配信対象が見つかりません: $DIR/index.html" >&2; exit 1; }

echo "Esora Maps を配信: $DIR"
echo "  → $URL"
# 同一 LAN のスマホから「閲覧」する場合の URL（ただし PWA インストール/SW は
# HTTPS か localhost が前提なので、LAN の HTTP では地図表示のみ・インストール不可）。
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null \
      || hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "${IP:-}" ] && echo "  → http://$IP:$PORT/  (同一LANのスマホから閲覧用 / インストールは不可)"

# 起動後にブラウザを開く（NO_OPEN=1 で抑止）。
if [ -z "${NO_OPEN:-}" ]; then
  ( sleep 1
    if command -v open >/dev/null 2>&1; then open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
    fi ) >/dev/null 2>&1 &
fi

# サーバを exec（Ctrl-C で確実に止まる）。既定で全インターフェースに bind。
exec python3 -m http.server --directory "$DIR" "$PORT"
