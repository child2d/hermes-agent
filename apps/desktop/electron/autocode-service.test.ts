import assert from 'node:assert/strict'
import { join } from 'node:path'

import { test } from 'vitest'

import {
  AUTOCODE_EMBED_URL,
  AUTOCODE_PORT,
  backendArgs,
  backendEnv,
  ensureAutocodeService,
  hasBuiltFrontend,
  resolveAgentPayload,
  resolveAutocodeHome,
  resolveBackendPythonWith
} from './autocode-service'
const HOME = 'D:/codeup/AutoCode'
const PY = 'D:/codeup/AutoCode/backend/.venv/Scripts/python.exe'

/** exists() over an explicit virtual filesystem: no disk in these tests. */
const existsIn = (paths: string[]) => (candidate: string): boolean =>
  paths.some(entry => candidate.replace(/\\/g, '/') === entry.replace(/\\/g, '/'))

test('resolveAutocodeHome prefers AUTOCODE_HOME, then the known checkout', () => {
  const env = { AUTOCODE_HOME: 'E:/work/ac' }
  const exists = existsIn([`E:/work/ac/backend/app/main.py`])
  assert.equal(resolveAutocodeHome({ env, exists }), 'E:/work/ac')
})

test('resolveAutocodeHome skips candidates without backend/app/main.py', () => {
  const exists = existsIn([`${HOME}/backend/app/main.py`])
  assert.equal(resolveAutocodeHome({ env: {}, exists }), HOME)
})

test('resolveAutocodeHome returns null when nothing matches', () => {
  assert.equal(resolveAutocodeHome({ env: {}, exists: () => false }), null)
})

test('resolveBackendPythonWith picks Windows then POSIX venv layout', () => {
  assert.equal(
    resolveBackendPythonWith(HOME, existsIn([PY])),
    'D:/codeup/AutoCode/backend/.venv/Scripts/python.exe'.replace(/\//g, '\\')
  )
  const posix = 'D:/codeup/AutoCode/backend/.venv/bin/python'
  assert.equal(
    resolveBackendPythonWith(HOME, existsIn([posix])),
    'D:/codeup/AutoCode/backend/.venv/bin/python'.replace(/\//g, '\\')
  )
  assert.equal(resolveBackendPythonWith(HOME, () => false), null)
})

test('resolveAgentPayload finds agent-payload beside resources', () => {
  const resourcesPath = 'C:/Program Files/WindowsApps/Pkg/app/resources'
  const payload = `${resourcesPath}/agent-payload`
  const exists = existsIn([`${payload}/bin/hermes-acp.exe`])
  assert.equal(resolveAgentPayload({ resourcesPath, exists }), payload.replace(/\//g, '\\'))
})

test('resolveAgentPayload returns null when the payload is absent', () => {
  assert.equal(resolveAgentPayload({ resourcesPath: 'C:/nowhere', exists: () => false }), null)
})

test('backendEnv drops PYTHONPATH and injects the two pointers', () => {
  const env = backendEnv({
    env: { PATH: 'C:/bin', PYTHONPATH: 'C:/engine/site-packages', undefinedish: undefined },
    hermesHome: 'C:/home',
    agentPayload: 'C:/payload',
    home: HOME
  })
  // Inheriting the engine's site-packages breaks the backend venv import.
  assert.equal('PYTHONPATH' in env, false)
  assert.equal(env.PATH, 'C:/bin')
  assert.equal(env.HERMES_HOME, 'C:/home')
  assert.equal(env.AUTOCODE_AGENT_PAYLOAD, 'C:/payload')
  assert.equal(env.AUTOCODE_TRUST_PLANKTON, '1')
  assert.equal('undefinedish' in env, false)
})

test('backendEnv keeps config and task data outside the replaceable code dir', () => {
  // The managed runtime dir is deleted and re-created on every update; if the
  // config or data/tasks lived there, one AutoCode update would wipe them.
  const env = backendEnv({
    env: {},
    home: 'C:/rt/runtime/abc',
    stateRoot: 'C:/rt'
  })
  assert.equal(env.AUTOCODE_CONFIG, join('C:/rt', 'config.yaml').replace(/\//g, '\\'))
  assert.equal(env.AUTOCODE_DATA_DIR, join('C:/rt', 'data').replace(/\//g, '\\'))
  assert.equal(env.AUTOCODE_CONFIG.includes('runtime'), false)
})

test('backendArgs serves the SPA from the same port as the API', () => {
  assert.deepEqual(backendArgs(), [
    '-m',
    'uvicorn',
    'app.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    String(AUTOCODE_PORT)
  ])
  assert.equal(AUTOCODE_PORT, 8787)
  assert.equal(AUTOCODE_EMBED_URL, 'http://127.0.0.1:8787/?embed=plankton')
})

test('ensureAutocodeService reports running without spawning when healthy', async () => {
  let spawns = 0
  const status = await ensureAutocodeService({
    exists: existsIn([`${HOME}/backend/app/main.py`, PY]),
    isHealthy: async () => true,
    spawnBackend: () => {
      spawns += 1

      return 1
    },
    env: {},
    resourcesPath: 'C:/res',
    log: () => {}
  })
  assert.equal(status.state, 'running')
  assert.equal(status.spawned, false)
  assert.equal(spawns, 0)
})

test('ensureAutocodeService spawns once and waits for health', async () => {
  let spawns = 0
  let up = false
  const status = await ensureAutocodeService({
    exists: existsIn([`${HOME}/backend/app/main.py`, PY]),
    isHealthy: async () => up,
    spawnBackend: (_home, python, env) => {
      spawns += 1
      assert.equal(python.endsWith('python.exe'), true)
      assert.equal(env.AUTOCODE_TRUST_PLANKTON, '1')
      // The health probe turns green only after the spawn, like a real boot.
      up = true

      return 4242
    },
    env: {},
    resourcesPath: 'C:/res',
    log: () => {},
    sleep: async () => {}
  })
  assert.equal(spawns, 1)
  assert.equal(status.state, 'running')
  assert.equal(status.spawned, true)
  assert.equal(status.pid, 4242)
})

test('ensureAutocodeService fails with the detail when the boot times out', async () => {
  const status = await ensureAutocodeService({
    exists: existsIn([`${HOME}/backend/app/main.py`, PY]),
    isHealthy: async () => false,
    spawnBackend: () => 7,
    env: {},
    resourcesPath: 'C:/res',
    log: () => {},
    sleep: async () => {},
    readyTimeoutMs: 0
  })
  assert.equal(status.state, 'failed')
  assert.equal(status.spawned, true)
  assert.match(status.detail, /没有就绪/)
})

test('ensureAutocodeService reports missing checkout instead of spawning', async () => {
  let spawns = 0
  const status = await ensureAutocodeService({
    exists: () => false,
    isHealthy: async () => false,
    spawnBackend: () => {
      spawns += 1

      return 1
    },
    env: {},
    resourcesPath: 'C:/res',
    log: () => {}
  })
  assert.equal(status.state, 'missing')
  assert.equal(spawns, 0)
  assert.match(status.detail, /AUTOCODE_HOME/)
})

test('hasBuiltFrontend gates the single-process mode', () => {
  assert.equal(hasBuiltFrontend(HOME, existsIn([`${HOME}/frontend/dist/index.html`])), true)
  assert.equal(hasBuiltFrontend(HOME, () => false), false)
})
