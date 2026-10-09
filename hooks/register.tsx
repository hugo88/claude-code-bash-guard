// bash-guard: dwa poziomy ochrony komend Bash.
// - BLOCK: komendy bez sensownego "tak" (rm -rf /, mkfs, curl | sh...): odmowa od razu.
// - HOLD: komendy, które coś nieodwracalnie zmieniają (rm -r, git reset --hard, git clean,
//   git push --force, migracje): panel z tym, co by się zmieniło, i przyciski Proceed / Cancel.
//
// Hook ma 10 s własnego czasu, ale czas wewnątrz wywołań `$` się nie liczy, więc pętla
// czekania śpi na `$.process.run(['sleep', ...])`, aż przycisk ustawi decyzję.

import type { ElementTable, EngineInterface, Register } from 'claude-code'

import { LIST_MAX, classify } from './radius'
import type { Report, Risk } from './radius'

const BLOCK: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME)(\s|\/?$|\/\*)/, reason: 'rm -rf on / or home' },
  { pattern: /\bmkfs(\.\w+)?\b|\bdd\b.*\bof=\/dev\//, reason: 'writes to a block device' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: 'chmod 777 on a system path' },
  { pattern: /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: 'pipes a download into a shell' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
]

const PANE_ID = 'bash-guard'
const POLL_SECONDS = '0.25'
const HOLD_LIMIT_MS = 10 * 60 * 1000

type Decision = 'proceed' | 'cancel' | 'timeout' | 'interrupted' | 'error'
type Held = { command: string; risk: Risk; report: Report | null; decision: Decision | null; where: 'pane' | 'band' }

// Wstrzymane wywołanie albo null. Jedno naraz: wywołania Bash w turze idą po kolei.
let held: Held | null = null

const WHY: Record<Decision, string> = {
  proceed: '',
  cancel: 'the user pressed Cancel',
  timeout: 'no answer within 10 minutes',
  interrupted: 'the turn was interrupted',
  error: 'bash-guard hit an error while holding it',
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const hit = BLOCK.find((rule) => rule.pattern.test(command))
    if (hit !== undefined) {
      $.ui.toast(`🛡 bash-guard blocked: ${hit.reason}`, { timeoutMs: 8000 })
      return { deny: `bash-guard: blocked (${hit.reason}). Ask the user to run it themselves if it is really intended.` }
    }
    const risk = classify(command)
    if (risk === null) return next(e)

    // Inne wstrzymane wywołanie (np. subagenta): czekamy na jego odpowiedź.
    // `held` jest zajmowany bez await między sprawdzeniem a zajęciem.
    while (held !== null) {
      if (next.signal.aborted) return { deny: 'bash-guard held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to.' }
      await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
    }
    const mine: Held = { command, risk, report: null, decision: null, where: 'pane' }
    held = mine

    let placed = false
    let summary = risk.label
    try {
      const sessionCwd = await $.session.cwd()
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd
      mine.report =
        cwd === null
          ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
          : await measure($, risk, cwd)
      summary = mine.report.summary

      const rows = Math.min(24, 9 + mine.report.lines.length + (mine.report.more ? 1 : 0))
      placed = (await $.ui.open({ id: PANE_ID, title: 'bash-guard', focus: true, rows })).isPlaced
      if (!placed) mine.where = 'band' // wąski terminal: raport w pasku nad promptem
      $.ui.invalidate('ui.render')

      const startedAt = await $.clock.now()
      while (mine.decision === null) {
        if (next.signal.aborted) mine.decision = 'interrupted'
        else if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) mine.decision = 'timeout'
        else await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
      }
    } catch {
      mine.decision = 'error' // coś nieoczekiwanego: komenda nie rusza
    } finally {
      // Zamykamy swój panel przed zwolnieniem, żeby nie zamknąć panelu następnego wywołania.
      if (placed) await $.ui.close({ id: PANE_ID }).catch(() => undefined)
      if (held === mine) held = null
      $.ui.invalidate('ui.render')
    }

    if (mine.decision === 'proceed') {
      $.ui.toast('bash-guard: running it')
      return next(e)
    }
    return {
      deny: `bash-guard held this command and did not run it: ${WHY[mine.decision ?? 'error']}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    }
  }).catch(($, e, next) =>
    // hook padł przed decyzją: komenda nie rusza
    next.called ? next(e) : { deny: 'bash-guard could not check this command, so it did not run. Ask the user to run it themselves.' },
  )

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) return next(e)
    return draw($.ui.resolve(e), held)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== 'band') return next(e)
    return draw($.ui.resolve(e), held)
  })
}

function draw({ Box, Text, Button }: ElementTable, state: Held) {
  const report = state.report as Report
  // Przyciski odpowiadają wywołaniu, dla którego panel narysowano, nie temu, które czeka teraz.
  const decide = (choice: Decision) => () => {
    if (state.decision === null) state.decision = choice
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{`⚠ bash-guard · ${state.risk.label}`}</Text>
      <Text wrap="truncate-end">
        <Text dimColor>{'Command  '}</Text>
        <Text bold>{state.command}</Text>
      </Text>
      <Text>
        <Text dimColor>{'Would    '}</Text>
        <Text color="red" bold>{report.summary}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {report.lines.map((line, i) => (
          <Text key={`l${i}`} wrap="truncate-end">{`  ${line}`}</Text>
        ))}
        {report.more ? <Text dimColor>{`  + ${report.more} more`}</Text> : null}
      </Box>
      {report.note ? (
        <Text dimColor italic wrap="wrap">
          {report.note}
        </Text>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Button label="Proceed" hotkey="1" plain onPress={decide('proceed')} />
        {/* Cancel ma fokus: Enter odmawia, nie uruchamia */}
        <Button label="Cancel" hotkey="2" plain autoFocus onPress={decide('cancel')} />
        <Text dimColor>Claude is waiting on your answer</Text>
      </Box>
    </Box>
  )
}

// ---- Pomiar (przeniesiony z Blast Radius, Apache-2.0) ----------------------
// Ścieżki trafiają do bash jako argumenty, nigdy jako kod. Komendy sprawdzające są tylko do odczytu.

const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`

/** Folder po `cd` jako ścieżka bezwzględna albo null, gdy nie istnieje. */
async function resolveDir($: EngineInterface, sessionCwd: string, dir: string): Promise<string | null> {
  if (dir === '-') return null // `cd -` zależy od historii powłoki
  const run = await $.process.run(['bash', '-c', CD_SCRIPT, 'bash-guard', dir], { cwd: sessionCwd, timeoutMs: 5000 })
  const out = run.stdout.trim()
  return run.exitCode === 0 && out !== '' ? out : null
}

/** Raport do panelu. Nie rzuca: błąd odczytu jest pokazany, nie ukryty. */
async function measure($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  try {
    if (risk.kind === 'rm') return await measureRm($, risk, cwd)
    if (risk.kind === 'migrate') return await measureMigrations($, risk, cwd)
    if (risk.kind === 'git-push-force') return await measurePush($, risk, cwd)
    if (risk.kind === 'git-clean') return await measureClean($, risk, cwd)
    return await measureDiscard($, risk, cwd)
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }
}

// compgen -G rozwija glob bez podstawiania komend.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# Względna ścieżka dostaje ./ z przodu, żeby find nie czytał nazwy typu -delete jako akcji.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`

async function measureRm($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const targets = risk.targets ?? []
  if (targets.length === 0) return { summary: 'rm with no paths', lines: [], note: 'No paths to expand.' }
  const run = await $.process.run(['bash', '-c', RM_SCRIPT, 'bash-guard', ...targets], { cwd, timeoutMs: 15000 })
  const [head, ...rest] = run.stdout.split('\n').filter((l) => l !== '')
  const [files = 0, bytes = 0, found = 0] = (head ?? '0 0 0').split(' ').map(Number)
  if (!found) return { summary: `delete nothing: no file matches ${targets.join(' ')}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." }
  if (!files) return { summary: `delete ${found} ${found === 1 ? 'path' : 'paths'} with no files in ${found === 1 ? 'it' : 'them'}`, lines: [], note: `Paths: ${targets.join(' ')}` }
  return {
    summary: `delete ${files} ${files === 1 ? 'file' : 'files'} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, '')),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${targets.join(' ')}`,
  }
}

async function measureClean($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const args = risk.args ?? []
  const flags: string[] = []
  const paths: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (a === '--') {
      paths.push(...args.slice(i + 1))
      break
    }
    if (a === '-e' || a === '--exclude') {
      flags.push(a, args[i + 1] ?? '')
      i += 1
    } else if (a.startsWith('--exclude=') || /^-e./.test(a)) flags.push(a)
    else if (/^-[a-zA-Z]+$/.test(a)) {
      const kept = a.replace(/[finq]/g, '') // -n dodajemy sami; -f, -i i -q zmieniłyby próbę
      if (kept !== '-') flags.push(kept)
    } else if (!a.startsWith('-')) paths.push(a)
  }
  const run = await $.process.run(['git', 'clean', '-n', ...flags, '--', ...paths], { cwd, timeoutMs: 15000 })
  if (run.exitCode !== 0) return { summary: 'git clean (could not dry-run it)', lines: [], note: run.stderr.trim().slice(0, 200) }
  const gone = run.stdout.split('\n').filter((l) => l.startsWith('Would remove ')).map((l) => l.slice(13))
  return {
    summary: gone.length === 0 ? 'remove nothing: no untracked files match' : `remove ${gone.length} untracked ${gone.length === 1 ? 'path' : 'paths'}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
  }
}

async function measureDiscard($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 15000 })
  if (status.exitCode !== 0) return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) }
  const rows = status.stdout.split('\n').filter((l) => l.length > 3 && !l.startsWith('??'))
  // reset --hard wyrzuca zmiany staged i unstaged; checkout -- . tylko unstaged.
  const lost = risk.kind === 'git-reset' ? rows : rows.filter((l) => l[1] !== ' ')
  const stat = await $.process.run(['git', 'diff', '--shortstat', risk.kind === 'git-reset' ? 'HEAD' : '--'], { cwd, timeoutMs: 15000 })
  return {
    summary: lost.length === 0 ? 'discard nothing: no uncommitted changes' : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? 'file' : 'files'}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== '' ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : 'From git status --porcelain.',
  }
}

async function measurePush($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const positional = (risk.args ?? []).filter((a) => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  // Refspec to src:dst; bez dwukropka wypychana jest lokalna gałąź o tej samej nazwie.
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source = '', branch = ''] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = branch.replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })
    branch = head.stdout.trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd, timeoutMs: 10000 })
  if (known.exitCode !== 0) return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` }
  const log = await $.process.run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], { cwd, timeoutMs: 15000 })
  const dropped = log.stdout.split('\n').filter((l) => l !== '')
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? 'commit' : 'commits'}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  }
}

// Uwaga: te komendy uruchamiają kod projektu (manage.py, bin/rails), zanim padnie decyzja.
const MIGRATION_LISTERS: Record<string, { argv: string[]; pending: (l: string) => boolean; strip: (l: string) => string }> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], pending: (l) => l.startsWith('[ ]'), strip: (l) => l.slice(4) },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], pending: (l) => l.includes('->'), strip: (l) => l },
  rails: { argv: ['bin/rails', 'db:migrate:status'], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ['npx', '--no-install', 'prisma', 'migrate', 'status'], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
}

async function measureMigrations($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const lister = MIGRATION_LISTERS[risk.tool ?? '']
  if (lister === undefined) return { summary: 'run migrations', lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." }
  const run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (run.exitCode !== 0) return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(' ')} failed).` }
  const pending = run.stdout.split('\n').filter(lister.pending).map(lister.strip)
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? 'migration' : 'migrations'}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(' ')}.`,
  }
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}
