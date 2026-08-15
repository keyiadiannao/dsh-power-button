import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Runs BEFORE any test module is imported, so RUNTIME_DIR (captured at module
// load from DSH_HOME) points at an isolated temp dir — the tests never touch
// the real ~/.dsh.
const testHome = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
process.env.DSH_HOME = testHome
