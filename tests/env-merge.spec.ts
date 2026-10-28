import { describe, expect, it } from 'vitest'
import { mergeEnvironment, parseEnvRegExport, type EnvRegistryValue } from '../src/index.ts'

/** Encode text the way `reg export` writes a REG_EXPAND_SZ payload. */
const hex2 = (text: string): string =>
  `hex(2):${Array.from(Buffer.from(text, 'utf16le')).map(b => b.toString(16).padStart(2, '0')).join(',')}`

const value = (name: string, text: string, expand = false): EnvRegistryValue =>
  ({ name, value: text, expand })

describe('parseEnvRegExport', () => {
  it('reads REG_SZ values, unescaping the .reg quoting', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_CURRENT_USER\\Environment]',
      '"MY_TOOL_HOME"="D:\\\\MyTool"',
      '"QUOTED"="a\\"b"',
    ].join('\r\n')
    expect(parseEnvRegExport(text)).toEqual([
      { name: 'MY_TOOL_HOME', value: 'D:\\MyTool', expand: false },
      { name: 'QUOTED', value: 'a"b', expand: false },
    ])
  })

  it('reads a REG_EXPAND_SZ payload as UTF-16LE and marks it expandable', () => {
    const text = `[HKEY_CURRENT_USER\\Environment]\r\n"Path"=${hex2('C:\\测试目录;%USERPROFILE%\\bin')}\r\n`
    const parsed = parseEnvRegExport(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.value).toBe('C:\\测试目录;%USERPROFILE%\\bin')
    expect(parsed[0]?.expand).toBe(true)
  })

  it('ignores keys it does not understand instead of inventing values', () => {
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_CURRENT_USER\\Environment]',
      '"BINARY"=hex:01,02,03',
      '@="default"',
    ].join('\r\n')
    expect(parseEnvRegExport(text)).toEqual([])
  })

  it('joins backslash continuation lines, so a long value is not truncated', () => {
    // reg export wraps a hex payload: the line ends with a single backslash and
    // the next line continues it. A real PATH is long enough to always wrap.
    const long = `C:\\${'a'.repeat(80)};D:\\Second`
    const bytes = Array.from(Buffer.from(long, 'utf16le')).map(b => b.toString(16).padStart(2, '0'))
    const wrapped: string[] = []
    for (let i = 0; i < bytes.length; i += 20) {
      const prefix = i === 0 ? '"Path"=hex(2):' : '  '
      // The real format puts the comma BEFORE the continuation backslash.
      const tail = i + 20 < bytes.length ? '\\' : ''
      wrapped.push(prefix + bytes.slice(i, i + 20).join(',') + (tail === '' ? '' : ',' + tail))
    }
    const parsed = parseEnvRegExport(['[HKEY_CURRENT_USER\\Environment]', ...wrapped].join('\r\n'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.value).toBe(long)
  })
})

describe('mergeEnvironment', () => {
  const inherited = { PATH: 'C:\\old;C:\\inherited-only', KEEP: 'from-launcher', STALE: 'old' }

  it('lets a user value shadow a machine value of the same name', () => {
    // Windows composes the block machine first, then user, so the user entry is
    // the one a freshly started process sees.
    const merged = mergeEnvironment(
      [value('MY_TOOL_HOME', 'C:\\SystemTool')],
      [value('MY_TOOL_HOME', 'D:\\MyTool')],
      inherited,
    )
    expect(merged.env.MY_TOOL_HOME).toBe('D:\\MyTool')
  })

  it('does not let a machine value overwrite a user value by being read later', () => {
    const merged = mergeEnvironment(
      [value('X', 'machine')],
      [value('X', 'user')],
      {},
    )
    expect(merged.env.X).toBe('user')
  })

  it('composes PATH as machine then user, then only the inherited extras', () => {
    const merged = mergeEnvironment(
      [value('Path', 'C:\\Windows;C:\\machine-tool', true)],
      [value('Path', 'D:\\NewTools\\bin;C:\\Windows', true)],
      inherited,
    )
    expect(merged.env.PATH).toBe(
      'C:\\Windows;C:\\machine-tool;D:\\NewTools\\bin;C:\\old;C:\\inherited-only',
    )
  })

  it('keeps a user PATH entry that the launcher never saw', () => {
    // The reported defect: a path added with setx after DSH started must reach
    // the successor even though no process in the chain inherited it.
    const merged = mergeEnvironment([], [value('Path', 'D:\\NewTools\\bin', true)], inherited)
    expect(merged.env.PATH?.split(';')).toContain('D:\\NewTools\\bin')
  })

  it('expands only values the registry stored as REG_EXPAND_SZ', () => {
    const merged = mergeEnvironment(
      [value('EXPANDED', 'home=%HOME%', true), value('LITERAL', 'token=abc%HOME%xyz', false)],
      [value('HOME', 'C:\\Users\\me')],
      inherited,
    )
    expect(merged.env.EXPANDED).toBe('home=C:\\Users\\me')
    // A REG_SZ value keeps its percent signs: Windows does not expand it.
    expect(merged.env.LITERAL).toBe('token=abc%HOME%xyz')
  })

  it('never re-expands an inherited value', () => {
    const merged = mergeEnvironment(
      [value('HOME', 'C:\\Users\\me')],
      [],
      { ...inherited, ALREADY: 'literal%HOME%text' },
    )
    expect(merged.env.ALREADY).toBe('literal%HOME%text')
  })

  it('fills names the registry does not define from the inherited block', () => {
    const merged = mergeEnvironment([value('ONLY_MACHINE', 'm')], [], inherited)
    expect(merged.env.KEEP).toBe('from-launcher')
    expect(merged.env.ONLY_MACHINE).toBe('m')
  })

  it('reports where the block came from', () => {
    expect(mergeEnvironment([], [], inherited).source).toBe('inherited')
    expect(mergeEnvironment([value('A', '1')], [], inherited).source).toBe('registry')
    expect(mergeEnvironment([value('A', '1')], [value('B', '2')], inherited).env.B).toBe('2')
  })

  it('treats names case-insensitively so the child cannot see two spellings', () => {
    const merged = mergeEnvironment([value('Path', 'C:\\m', true)], [value('PATH', 'C:\\u', true)], {})
    const spellings = Object.keys(merged.env).filter(key => key.toLowerCase() === 'path')
    expect(spellings).toHaveLength(1)
  })

  it('expands %NAME% inside a REG_EXPAND_SZ PATH, which CreateProcess will not do', () => {
    // A caller-supplied block is used verbatim, so a literal %SystemRoot% would
    // reach the successor as text and never resolve.
    const merged = mergeEnvironment(
      [value('SystemRoot', 'C:\\Windows'), value('Path', '%SystemRoot%\\System32', true)],
      [value('USERPROFILE', 'C:\\Users\\me'), value('Path', '%USERPROFILE%\\AppData', true)],
      {},
    )
    expect(merged.env.PATH).toBe('C:\\Windows\\System32;C:\\Users\\me\\AppData')
  })

  it('expands only the PATH half that was REG_EXPAND_SZ', () => {
    // A mixed PATH: machine entries reference %SystemRoot% and must be expanded;
    // the user entries are REG_SZ and keep their percent signs, as Windows leaves
    // them. Expanding the joined string would resolve both halves.
    const merged = mergeEnvironment(
      [value('SystemRoot', 'C:\\Windows'), value('Path', '%SystemRoot%\\System32', true)],
      [value('Path', '%CUSTOM%\\literal', false)],
      {},
    )
    expect(merged.env.PATH).toBe('C:\\Windows\\System32;%CUSTOM%\\literal')
  })

  it('expands a value according to the type that WON, not the shadowed one', () => {
    // Machine stores X as REG_EXPAND_SZ and the user redefines it as REG_SZ. The
    // winning value is the user's, so its percent signs are literal — a flag
    // accumulated from the machine entry would expand them anyway.
    const merged = mergeEnvironment(
      [value('X', '%HOME%', true)],
      [value('X', 'literal-%HOME%', false), value('HOME', 'D:\\home')],
      {},
    )
    expect(merged.env.X).toBe('literal-%HOME%')
  })

  it('dedupes PATH after expanding, so an equivalent entry is not duplicated', () => {
    // The registry says %SystemRoot%\System32; the launcher already had the
    // expanded form. Comparing raw text would keep both and grow PATH each run.
    const merged = mergeEnvironment(
      [value('SystemRoot', 'C:\\Windows'), value('Path', '%SystemRoot%\\System32', true)],
      [],
      { PATH: 'C:\\Windows\\System32' },
    )
    expect(merged.env.PATH).toBe('C:\\Windows\\System32')
  })

  it('leaves percent signs in a REG_SZ PATH untouched', () => {
    const merged = mergeEnvironment(
      [value('SystemRoot', 'C:\\Windows'), value('Path', '%SystemRoot%\\x', false)],
      [],
      {},
    )
    expect(merged.env.PATH).toBe('%SystemRoot%\\x')
  })
})
