/**
 * Self-contained tsdown preset for this package's dshClient browser bundle.
 * Ported from the DSH checkout's `packages/client/tsdown.client.ts` (the
 * official standard for dshClient plugin bundles), kept dependency-free so
 * this repo builds standalone. It must not import anything from the DSH
 * monorepo.
 *
 * Emits the closure-factory artifact the loader expects: the bundle calls
 * `window.__ModuleLoader__.load({id, factory})` and resolves externals
 * through the injected require (the loader module table — cordis DI
 * entities, no globals, no import map).
 */
import type { UserConfig } from 'tsdown'

/** Externals resolved from the loader module table (mirror of the checkout's PLATFORM_MODULES). */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline. */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Build the tsdown configs: a no-op node-half lib plus the browser client
 * bundle. `clean` stays off because the two configs share the output dir.
 */
export function clientBundle(id: string): UserConfig[] {
  return [
    {
      name: id,
      entry: ['src/index.ts'],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: true,
      clean: false,
    },
    clientConfig(id),
  ]
}

function clientConfig(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: true,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(source)) return null
          if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
            + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
          )
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
