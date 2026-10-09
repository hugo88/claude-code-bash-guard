#!/usr/bin/env bash
# Instaluje / aktualizuje moda: testy, potem kopia kodu do folderu modów.
# Użycie: ./install.sh [folder docelowy]   (domyślnie ~/.claude/mods/bash-guard)
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:-$HOME/.claude/mods/bash-guard}"

if [ "${SKIP_TESTS:-}" != 1 ] && command -v claude >/dev/null; then
  echo "Testy..."
  claude plugin test "$src" >/dev/null || { echo "Testy nie przechodzą, nic nie skopiowano. Szczegóły: claude plugin test $src" >&2; exit 1; }
fi

mkdir -p "$dest/.claude-plugin"
rm -f "$dest/hooks/register.ts" # wersja 0.1.0 miała hooki w register.ts
cp -r "$src/hooks" "$src/tests" "$src/tsconfig.json" "$dest/"
cp "$src/.claude-plugin/plugin.json" "$dest/.claude-plugin/"
echo "Zainstalowano w $dest ($(git -C "$src" describe --always --dirty 2>/dev/null || echo '?'))"

settings="$HOME/.claude/settings.json"
if ! grep -qs "${dest/#$HOME/\~}\|$dest" "$settings"; then
  echo
  echo "Dopisz folder do CLAUDE_CODE_PLUGIN_DIRS w $settings (env) i uruchom Claude Code ponownie:"
  echo "  \"CLAUDE_CODE_PLUGIN_DIRS\": \"${dest/#$HOME/\~}\""
else
  echo "Mod jest w CLAUDE_CODE_PLUGIN_DIRS: działająca sesja przeładuje go sama."
fi
