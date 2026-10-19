import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import electron from 'electron'

test('migrates an isolated legacy DB and persists scoped usage, errors and complete statistics', () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [fileURLToPath(new URL('./database.electron.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /ISOLATED_DATABASE_OK/)
})
