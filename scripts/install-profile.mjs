/**
 * Install this plugin into a DSH profile by editing the profile's package.json:
 *  - adds `dsh-workspace-session-search` as a `link:` dependency,
 *  - appends it to `dsh.profile.bundles`.
 *
 * It does NOT run `pnpm install` or restart the host; both are printed as the
 * required next steps. Re-running is idempotent.
 *
 * Usage: node scripts/install-profile.mjs [profileDir]
 *        (default: ~/.dsh/profiles/desktop)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), '.dsh', 'profiles', 'desktop')
const packagePath = join(profileDir, 'package.json')
const NAME = 'dsh-workspace-session-search'
const LINK = 'link:' + pluginRoot

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

const dependencyChanged = pkg.dependencies[NAME] !== LINK
const bundleChanged = !pkg.dsh.profile.bundles.includes(NAME)
pkg.dependencies[NAME] = LINK
if (bundleChanged) pkg.dsh.profile.bundles.push(NAME)

writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

process.stdout.write(
  [
    `profile:   ${profileDir}`,
    `dependency: ${dependencyChanged ? 'added/updated' : 'already linked'} → ${LINK}`,
    `bundle:     ${bundleChanged ? 'appended' : 'already listed'} (${pkg.dsh.profile.bundles.length} bundles)`,
    '',
    'next steps:',
    `  cd ${profileDir} && pnpm install`,
    '  fully quit and reopen DeepSeek Harness (client plugin metadata is cached until restart)',
  ].join('\n') + '\n',
)
