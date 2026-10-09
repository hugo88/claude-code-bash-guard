// Rozpoznawanie ryzykownych komend i pomiar ich skutków ("blast radius").
// Przeniesione z moda Blast Radius, Copyright 2026 Anthropic PBC, Apache-2.0:
// https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius
//
//
// Pomiar (funkcje z `$`) jest w register.tsx: silnik śledzi `$` tylko w obrębie jednego pliku.

export const LIST_MAX = 10

export type Risk = {
  kind: 'rm' | 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout' | 'migrate'
  label: string
  dir: string | null // dokąd przeniósł wcześniejszy cd; null = folder sesji
  targets?: string[]
  args?: string[]
  tool?: 'alembic' | 'rails' | 'prisma' | 'django' | 'unknown'
}

export type Report = { summary: string; lines: string[]; more?: number; note?: string }

type Cd = { kind: 'cd'; cd: string | null }

// ---- Co jest ryzykowne -----------------------------------------------------

const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Komendy tylko do odczytu: samo słowo "migrate" w nich to nie migracja.
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git'])
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])

function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) return arg ?? '~'
  return dir ? `${dir}/${arg}` : arg
}

export function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) words.push(m[1] ?? m[2] ?? m[3] ?? '')
  return words
}

/** Pierwszy ryzykowny segment komendy albo null. */
export function classify(command: string): Risk | null {
  let dir: string | null = null
  const scopes: Array<string | null> = [] // dir do przywrócenia, gdy zamyka się ( subshell )
  const pushed: Array<string | null> = [] // stos pushd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // Przekierowania i & na końcu nie zasłaniają nawiasu: `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0
    for (let k = 0; k < opens; k += 1) scopes.push(dir)
    const r = classifySegment(raw, dir, pushed)
    if (r !== null && r.kind !== 'cd') return r
    if (r !== null) dir = r.cd
    for (let k = 0; k < closes && scopes.length > 0; k += 1) dir = scopes.pop() ?? null // cd w ( ... ) nie wychodzi poza nawias
  }
  return null
}

function classifySegment(segment: string, dir: string | null, pushed: Array<string | null>): Risk | Cd | null {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift()
  if (words[0] === 'sudo') {
    words.shift()
    while (words.length > 0 && (words[0] ?? '').startsWith('-')) {
      const option = words.shift() ?? ''
      if (SUDO_VALUE_OPTIONS.has(option)) words.shift()
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? ''))) words.shift()
  if (words[0] === 'nice') {
    words.shift()
    if ((words[0] as string | undefined) === '-n') words.splice(0, 2) // TS zawęża words[0] do 'nice' mimo shift()
    else if (/^-\d+$/.test(words[0] ?? '')) words.shift()
  }
  const [first, ...args] = words
  if (first === undefined) return null
  const cmd = first.replace(/^\\/, '') // \rm omija aliasy, ale to dalej rm
  if (cmd === 'cd') return { kind: 'cd', cd: args[0] === '-' ? '-' : joinDir(dir, args[0]) }
  if (cmd === 'pushd') {
    pushed.push(dir)
    return { kind: 'cd', cd: joinDir(dir, args[0]) }
  }
  if (cmd === 'popd') return { kind: 'cd', cd: pushed.length > 0 ? (pushed.pop() ?? null) : '-' }
  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter((a) => a.startsWith('-'))
    const recursive = flags.some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const force = flags.some((f) => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (recursive || force) {
      const targets = args.filter((a) => !a.startsWith('-') || a === '-')
      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets, dir }
    }
  }
  if (cmd === 'git') {
    // Opcje gita są przed podkomendą; -C zmienia folder.
    let gitDir: string | null = dir
    let i = 0
    while (i < args.length && (args[i] ?? '').startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) {
        gitDir = joinDir(gitDir, args[i + 1])
        i += 2
      } else if (args[i] === '-c' && i + 1 < args.length) i += 2
      else i += 1
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (sub === 'reset' && rest.includes('--hard')) return { kind: 'git-reset', label: 'git reset --hard', args: rest, dir: gitDir }
    if (sub === 'clean') return { kind: 'git-clean', label: 'git clean', args: rest, dir: gitDir }
    if (sub === 'push' && rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))) {
      return { kind: 'git-push-force', label: 'git push --force', args: rest, dir: gitDir }
    }
    const stagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !stagedOnly) {
      return { kind: 'git-checkout', label: `git ${sub} -- .`, args: rest, dir: gitDir }
    }
  }
  const joined = words.join(' ')
  if (/\balembic\s+upgrade\b/.test(joined)) return { kind: 'migrate', tool: 'alembic', label: 'alembic upgrade', dir }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) return { kind: 'migrate', tool: 'rails', label: 'db:migrate', dir }
  if (/\bprisma\s+migrate\b/.test(joined)) return { kind: 'migrate', tool: 'prisma', label: 'prisma migrate', dir }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) return { kind: 'migrate', tool: 'django', label: 'manage.py migrate', dir }
  if (!READ_ONLY.has(cmd) && args.includes('migrate')) return { kind: 'migrate', tool: 'unknown', label: 'migrate', dir }
  return null
}
