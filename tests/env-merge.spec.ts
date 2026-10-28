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
})
