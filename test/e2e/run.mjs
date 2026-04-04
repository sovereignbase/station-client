import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
/** update to current package */
const root = process.cwd()
const tasks = [
  ['Browsers', resolve(root, 'test', 'e2e', 'runsInBrowsers', 'run.mjs')],
]

for (const [label, script] of tasks) {
  console.log(`\n=== ${label} E2E ===`)
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    cwd: root,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('\nAll end-to-end runtime suites passed.')
