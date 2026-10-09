# bash-guard

Mod do [Claude Code](https://claude.com/claude-code), który pilnuje komend Bash uruchamianych przez Claude'a. Katastrofalne blokuje od razu. Ryzykowne wstrzymuje i pokazuje, co by zmieniły: pliki do usunięcia, zmiany do wyrzucenia, commity, które przepadną. Decydujesz przyciskiem **Proceed** albo **Cancel**.

*English summary below.*

## Co robi

**Blokada** (odmowa bez pytania, toast z powodem):

- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`
- `mkfs`, `dd … of=/dev/…`
- `chmod 777 /…`
- `curl … | sh`, `wget … | bash`
- fork bomb

**Wstrzymanie** (panel z podglądem i Proceed / Cancel):

| Komenda | Co pokazuje panel |
|---|---|
| `rm -r`, `rm -f`, `rm -rf` | pliki do usunięcia, ich liczbę i łączny rozmiar; globy i `~` są rozwijane |
| `git reset --hard` | pliki z niezacommitowanymi zmianami i `git diff --shortstat` |
| `git checkout -- .`, `git restore .` | pliki ze zmianami unstaged |
| `git clean` | nieśledzone ścieżki, z `git clean -n` z tymi samymi flagami |
| `git push --force` (też `-f`, `--force-with-lease`, `+ref`) | commity na zdalnej gałęzi, których nie masz lokalnie i które push wyrzuci |
| `manage.py migrate`, `db:migrate`, `alembic upgrade`, `prisma migrate` | oczekujące migracje, z komendy statusu danego narzędzia |

Każda inna komenda przechodzi bez zmian. `cd dir &&`, `pushd`/`popd` i `git -C dir` przesuwają folder, w którym liczony jest podgląd. `cd` w `( … )` działa tylko w nawiasie, jak w powłoce.

Przycisk **Cancel** ma domyślny fokus, więc przypadkowy Enter niczego nie uruchomi. Claude dostaje odmowę z powodem i tym, co komenda by zrobiła. Bez odpowiedzi przez 10 minut komenda jest odrzucana. W wąskim terminalu (panel się nie mieści) podgląd jest rysowany w pasku nad polem wpisywania.

## Instalacja

Wymagania: Claude Code w wersji obsługującej mody, testowane na **2.1.295**; sprawdzisz przez `claude --version`.

Najprościej, wpisane w Claude Code (od 2.1.275):

```
/plugin install bash-guard --marketplace hugo88/claude-code-bash-guard
```

potwierdź dodanie marketplace (`y`) i wybierz zakres (Enter = użytkownik). Mod działa od razu. Aktualizacja: `claude plugin update bash-guard`.

### Instalacja z klonu repozytorium

Linux, macOS albo WSL:

```sh
git clone https://github.com/hugo88/claude-code-bash-guard
cd claude-code-bash-guard
./install.sh            # testy, potem kopia do ~/.claude/mods/bash-guard
```

Aktualizacja: `git pull && ./install.sh`. Przy pierwszej instalacji dopisz folder do `CLAUDE_CODE_PLUGIN_DIRS` w `~/.claude/settings.json` (kilka folderów oddzielasz `:`) i uruchom Claude Code ponownie:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/bash-guard"
  }
}
```

**Sprawdzenie:** w testowym folderze poproś Claude'a o `rm -rf build`. Powinien pojawić się panel z listą plików i przyciskami Proceed / Cancel.

### Odinstalowanie

Zainstalowany przez `/plugin install`: `claude plugin uninstall bash-guard`. Z klonu: usuń folder z `CLAUDE_CODE_PLUGIN_DIRS` i `rm -rf ~/.claude/mods/bash-guard`.

## Ograniczenia

To pomoc, nie zabezpieczenie. Reguły czytają tekst komendy, więc skrypt, alias czy `eval` je obejdą. Twarda ochrona to `permissions.deny` w ustawieniach Claude Code.

- Pilnowane są tylko komendy Claude'a (narzędzie Bash), nie te, które wpisujesz sam przez `!`.
- Podgląd migracji uruchamia komendę statusu projektu (np. `python3 manage.py showmigrations`, `bin/rails db:migrate:status`), zanim klikniesz Proceed.
- Podgląd `git push --force` opiera się na ostatnim `git fetch`.
- Naraz wstrzymywana jest jedna komenda; kolejne (np. subagenta) czekają na odpowiedź.

## Rozwój

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # typy generuje Claude Code przy pierwszym załadowaniu moda
```

## Pochodzenie

Wstrzymywanie z podglądem skutków jest przeniesione z moda [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) (Copyright 2026 Anthropic PBC, Apache-2.0), przepisane na TypeScript i połączone z blokadą bash-guard.

---

## English

A [Claude Code](https://claude.com/claude-code) mod that guards the Bash commands Claude runs. Catastrophic ones (`rm -rf /`, `mkfs`, `dd of=/dev/…`, `curl | sh`, fork bomb) are denied outright. Risky ones (`rm -r`, `git reset --hard`, `git clean`, force push, migrations) are held while a pane shows what they would change, with **Proceed** and **Cancel** (Cancel has focus). Based on Anthropic's Blast Radius example mod.

Install: `/plugin install bash-guard --marketplace hugo88/claude-code-bash-guard` in Claude Code, or clone the repo and run `./install.sh`. Messages in the pane are in English, docs in Polish.

## Licencja

Apache-2.0
