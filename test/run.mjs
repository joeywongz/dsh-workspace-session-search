/** Runs every test script under test/ and reports a combined result. */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = ['test/host.test.mjs', 'test/client.test.mjs']
let failed = false

for (const script of scripts) {
  const path = resolve(root, script)
  process.stdout.write(`\n=== ${script} ===\n`)
  if (!existsSync(path)) {
    process.stdout.write(`SKIP (missing) ${script}\n`)
    failed = true
    continue
  }
  try {
    execFileSync(process.execPath, [path], { cwd: root, stdio: 'inherit' })
  } catch {
    failed = true
  }
}

process.stdout.write(failed ? '\nTEST RUN FAILED\n' : '\nALL TESTS PASSED\n')
process.exit(failed ? 1 : 0)
