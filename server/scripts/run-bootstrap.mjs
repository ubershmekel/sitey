#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const action = process.argv[2]
if (action !== 'init' && action !== 'reset') {
  console.error('Usage: npm run bootstrap:init | npm run bootstrap:reset')
  process.exit(1)
}

const jsCandidates = [
  'dist/services/bootstrap.js',
  'dist/bootstrap.js',
]

const jsEntry = jsCandidates.find((p) => existsSync(p))
if (jsEntry) {
  const result = spawnSync(process.execPath, ['--enable-source-maps', jsEntry, action], {
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

const tsEntry = 'src/services/bootstrap.ts'
if (existsSync(tsEntry)) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', tsEntry, action], {
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

console.error(
  'Could not find bootstrap entrypoint. Tried: dist/services/bootstrap.js, dist/bootstrap.js, src/services/bootstrap.ts',
)
process.exit(1)
