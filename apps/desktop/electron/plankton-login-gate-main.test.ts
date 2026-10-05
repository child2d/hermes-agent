/**
 * plankton-login-gate-main.test.ts — main.ts-level proof of the fail-closed
 * gate (the old shell's `ipc-login-gate.test.mjs` equivalence).
 *
 * WHY NOT SOURCE ASSERTIONS
 * -------------------------
 * The gate lives at ONE registration point (`installPlanktonIpcGate`) and one
 * spawn chokepoint (`spawnOwnedBackend`). A source-text assertion cannot prove
 * "this handler is actually wired" — a future `ipcMain.handle` registered
 * before the wrap, or a spawn site that bypasses `spawnOwnedBackend`, would
 * still match the text. So this test really loads the compiled main process
 * (esbuild bundle, electron stubbed) in a sandbox with NO session, then:
 *
 *   1. invokes EVERY registered invoke channel and asserts the business handler
 *      did not run (uniform `{ok:false, code:'not-authenticated'}`);
 *   2. resolves `app.whenReady()` so the real `createWindow()` startup path
 *      runs, and asserts the backend was never spawned and the enterprise home
 *      was never created (`state.db`, `config.yaml`, `desktop.log` absent).
 *
 * Sandbox home lives OUTSIDE the personal `~/.hermes` (enterprise isolation
 * rule); a stub `child_process.spawn` counts spawn attempts so a regression
 * cannot hide behind a quiet child.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url)) // apps/desktop/electron
const desktop = path.resolve(here, '..')
const bundleDir = path.join(desktop, 'build', 'plankton-gate-test')
const bundlePath = path.join(bundleDir, 'main.cjs')

/** Login-surface allowlist — must match PLANKTON_PUBLIC_CHANNELS. */
const PUBLIC = new Set([
  'plankton:sso-status',
  'plankton:sso-login',
  'plankton:sso-logout',
  'hermes:version',
  'hermes:feature-flags',
  'hermes:boot-progress:get'
])

/** Channels that would open a system browser / block; not invoked. */
const NOT_INVOKED = new Set(['plankton:sso-login'])

/** The channels the review named — asserted present in the registered set. */
const NAMED_CONTROLLED = [
  'hermes:api',
  'hermes:gateway:ws-url-for',
  'hermes:connections:list',
  'hermes:agents:roster',
  'hermes:plugin-profile-routes',
  'hermes:connections:test',
  'hermes:connection-config:test',
  'hermes:saveGatewayFile',
  'hermes:connection',
  'hermes:connection:for',
  'hermes:readFileText',
  'hermes:readFileDataUrl',
  'hermes:readFileDataUrlForAttach',
  'hermes:readPluginSource',
  'hermes:watchDirectory',
  'hermes:watchPreviewFile',
  'hermes:selectPaths',
  'hermes:readClipboard',
  'hermes:logs:recent'
]

const CHILD = String.raw`
const Module = require('module')
const noop = () => {}
const sandbox = process.env.GATE_SANDBOX
const MODE = process.env.GATE_MODE || 'handlers'
const handlers = new Map()
const pathMap = (name) => {
  const m = { home: 'home', appData: 'appData', userData: 'userData', temp: 'tmp', logs: 'logs',
    cache: 'cache', sessionData: 'sessionData', crashDumps: 'crashDumps', userCache: 'userCache',
    documents: 'documents', desktop: 'desktop', exe: 'exe', module: 'module' }
  return require('path').join(sandbox, m[name] || name)
}
const noopProxy = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) })
const fakeApp = {
  whenReady: () => (MODE === 'startup' ? Promise.resolve() : new Promise(() => {})),
  on: noop, once: noop, quit: noop, exit: noop, removeAllListeners: noop, removeListener: noop,
  getPath: (n) => pathMap(n), setPath: noop, setName: noop, getName: () => 'Plankton',
  setAppUserModelId: noop, getVersion: () => '0.0.0-test', getAppPath: () => process.env.GATE_APPDIR,
  isPackaged: false, requestSingleInstanceLock: () => true, releaseSingleInstanceLock: noop,
  commandLine: { appendSwitch: noop, getSwitchValue: () => '', hasSwitch: () => false, appendArgument: noop },
  dock: noopProxy({ show: noop, hide: noop, setBadge: noop, setMenu: noop }), addRecentDocument: noop,
  isReady: () => false, disableHardwareAcceleration: noop, relaunch: noop, focus: noop,
  getLocale: () => 'en-US', isDefaultProtocolClient: () => false,
  setAsDefaultProtocolClient: () => true, removeAsDefaultProtocolClient: () => true,
  setLoginItemSettings: noop, getLoginItemSettings: () => ({}), setActivationPolicy: noop,
  setAboutPanelOptions: noop, showAboutPanel: noop, hide: noop, show: noop, getGPUFeatureStatus: () => ({}),
  getAppMetrics: () => [], setSecureKeyboardEntryEnabled: noop,
}
class FakeWindow {
  constructor() { this.webContents = fakeWC(); this.id = 1; this.session = {} }
  loadFile() { return Promise.resolve() } loadURL() { return Promise.resolve() }
  on() {} once() {} off() {} show() {} hide() {} focus() {} blur() {} destroy() {} close() {}
  isDestroyed() { return false } isMinimized() { return false } isVisible() { return true }
  maximize() {} unmaximize() {} setTitle() {} getTitle() { return '' } setMenuBarVisibility() {}
  setFullScreen() {} isFullScreen() { return false } setBounds() {} getBounds() { return { x:0,y:0,width:1200,height:800 } }
  setBackgroundColor() {} setOpacity() {} setSkipTaskbar() {} setAlwaysOnTop() {} setIgnoreMouseEvents() {}
  setWindowOpenHandler() {} isMaximized() { return false } restore() {} isAlwaysOnTop() { return false }
  setProgressBar() {} setOverlayIcon() {} setDecorations() {} setVisibleOnAllWorkspaces() {} flashFrame() {}
  getNativeWindowHandle() { return Buffer.alloc(0) } setContentProtection() {} setMovable() {}
  setResizable() {} setMinimumSize() {} setMaximumSize() {} setAspectRatio() {} setPosition() {}
  setTitleBarOverlay() {} setAutoHideMenuBar() {} isSimpleFullScreen() { return false }
}
function fakeWC() {
  return {
    on: noop, once: noop, off: noop, send: noop, sendSync: () => ({}), invoke: () => Promise.resolve(),
    executeJavaScriptCode: noop, setWindowOpenHandler: noop, openDevTools: noop, closeDevTools: noop,
    isDevToolsOpened: () => false, id: 1, session: {}, getURL: () => '', setZoomFactor: noop,
    getZoomFactor: () => 1, setAudioMuted: noop, isAudioMuted: () => false, insertCSS: () => Promise.resolve(''),
    removeInsertedCSS: () => Promise.resolve(), capturePage: () => Promise.resolve({ toPNG: () => Buffer.alloc(0) }),
    setBackgroundThrottling: noop, setVisualZoomLevelLimits: () => Promise.resolve(), isLoading: () => false,
    reload: noop, focus: noop, print: () => Promise.resolve(), setDevToolsWebContents: noop, close: noop,
    sendInputEvent: noop, getProcessId: () => 1, isDestroyed: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: noop, goForward: noop },
  }
}
const ipcHandleMode = process.env.GATE_IPC_HANDLE || 'writable'
const rawHandle = (c, f) => { handlers.set(c, f) }
const ipcStub = {
  handle: rawHandle, on: noop, once: noop,
  removeHandler: c => handlers.delete(c), removeAllListeners: noop
}
if (ipcHandleMode === 'readonly-throw') {
  // A read-only 'handle' in strict mode: the assignment THROWS.
  Object.defineProperty(ipcStub, 'handle', {
    get: () => rawHandle,
    set: () => { throw new TypeError("Cannot assign to read only property 'handle'") },
    configurable: true
  })
} else if (ipcHandleMode === 'readonly-silent') {
  // A read-only 'handle' in sloppy mode: the assignment is accepted then IGNORED.
  Object.defineProperty(ipcStub, 'handle', { get: () => rawHandle, set: () => {}, configurable: true })
}
const proxy = new Proxy(
  {
    app: fakeApp, BrowserWindow: FakeWindow, BrowserView: class {},
    ipcMain: ipcStub,
    dialog: noopProxy({ showErrorBox: noop, showOpenDialog: () => Promise.resolve({ canceled: true }), showSaveDialog: () => Promise.resolve({ canceled: true }), showMessageBox: () => Promise.resolve({ response: 0 }) }),
    Menu: noopProxy({ setApplicationMenu: noop, buildFromTemplate: () => ({}), getApplicationMenu: () => null }),
    MenuItem: class {}, shell: noopProxy({ openExternal: () => Promise.resolve(), openPath: () => Promise.resolve(''), showItemInFolder: noop, trashItem: () => Promise.resolve() }),
    nativeTheme: noopProxy({ on: noop, shouldUseDarkColors: false, themeSource: 'system' }),
    screen: noopProxy({ on: noop, getPrimaryDisplay: () => ({ bounds: {x:0,y:0,width:1200,height:800}, workAreaSize: {width:1200,height:760}, scaleFactor: 2, id: 1 }), getAllDisplays: () => [], getCursorScreenPoint: () => ({x:0,y:0}) }),
    session: noopProxy({ fromPartition: () => noopProxy({ on: noop, cookies: noopProxy({ on: noop, get: () => Promise.resolve([]), set: () => Promise.resolve(), remove: () => Promise.resolve() }), setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, webRequest: noopProxy({ onBeforeSendHeaders: noop, onHeadersReceived: noop }), clearStorageData: () => Promise.resolve(), protocol: noopProxy({ handle: noop, isProtocolHandled: () => Promise.resolve(true) }), setCertificateVerifyProc: noop, setProxy: () => Promise.resolve(), setSpellCheckerEnabled: noop, spellCheckerEnabled: true }), defaultSession: noopProxy({ on: noop, cookies: noopProxy({ on: noop }), setPermissionRequestHandler: noop }), on: noop }),
    protocol: noopProxy({ handle: noop, registerSchemesAsPrivileged: noop, isProtocolHandled: () => true, unhandle: noop }),
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '', getSelectedStorageBackend: () => 'basic_text', setUsePlainTextEncryption: noop },
    clipboard: { readText: () => '', writeText: noop, readHTML: () => '', writeHTML: noop, readImage: () => ({ isEmpty: () => true }), writeImage: noop, availableFormats: () => [], clear: noop },
    powerMonitor: noopProxy({ on: noop, once: noop }),
    powerSaveBlocker: { start: () => 1, stop: noop, isStarted: () => false },
    globalShortcut: noopProxy({ register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false }),
    Tray: class { constructor() { this.setToolTip = noop; this.setContextMenu = noop; this.on = noop; this.setImage = noop; this.destroy = noop; this.popUpContextMenu = noop } },
    nativeImage: noopProxy({ createFromPath: () => ({ isEmpty: () => false, resize: () => ({ setTemplateImage: noop }), setTemplateImage: noop }), createEmpty: () => ({ isEmpty: () => true, resize: () => ({}) }) }),
    webContents: noopProxy({ getAllWebContents: () => [], fromId: () => null, getFocusedWebContents: () => null, on: noop }),
    net: noopProxy({}), Notification: class { constructor(){} show(){} on(){} static isSupported(){return true} },
    systemPreferences: noopProxy({ isDarkMode: () => true }), desktopCapturer: { getSources: () => Promise.resolve([]) },
    contextBridge: { exposeInMainWorld: noop }, crashReporter: noopProxy({ start: noop, addExtraParameter: noop }),
  },
  { get: (t, k) => (k in t ? t[k] : undefined) }
)
const realLoad = Module._load
let spawnCount = 0
const spawnedArgs = []
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return proxy
  if (request === 'child_process' || request === 'node:child_process') {
    const real = realLoad.apply(this, arguments)
    return new Proxy(real, { get: (t, k) => {
      if (k === 'spawn' || k === 'spawnSync') return (...a) => {
        spawnCount++; spawnedArgs.push(String(a[0]))
        if (k === 'spawnSync') return { status: 1, error: new Error('blocked-by-test'), pid: 0 }
        const e = new (require('events').EventEmitter)(); e.pid = 4242
        e.stdout = new (require('events').EventEmitter)(); e.stderr = new (require('events').EventEmitter)()
        e.stdin = null; e.kill = noop; e.unref = noop; e.ref = noop; return e
      }
      return t[k]
    } })
  }
  return realLoad.apply(this, arguments)
}
let fatal = null
try { require(process.env.GATE_BUNDLE) } catch (e) { fatal = String(e && e.stack || e) }
const out = { channels: [...handlers.keys()].sort(), spawnCount, spawnedArgs, fatal }
if (fatal || MODE === 'load') {
  console.log('__RESULT__' + JSON.stringify(out))
} else if (MODE === 'handlers') {
  const SKIP = new Set(JSON.parse(process.env.GATE_SKIP || '[]'))
  ;(async () => {
    const results = {}
    for (const [channel, handler] of handlers) {
      if (SKIP.has(channel)) continue
      try { results[channel] = await handler({ sender: { id: 1, send: noop, on: noop, once: noop } }) }
      catch (err) { results[channel] = { threw: String((err && err.message) || err) } }
    }
    out.results = results
    console.log('__RESULT__' + JSON.stringify(out))
  })().catch(e => { out.fatal2 = String(e && e.stack || e); console.log('__RESULT__' + JSON.stringify(out)) })
} else {
  setTimeout(() => console.log('__RESULT__' + JSON.stringify(out)), 2500)
}
`

function makeSandbox(): { root: string; home: string; hermesHome: string } {
  // Deliberately OUTSIDE the personal Hermes root (~/.hermes): the enterprise
  // isolation rule treats a HERMES_HOME under the personal root as personal
  // state. `~/.plankton` is the product's own root.
  const base = path.join(os.homedir(), '.plankton', 'hermes-desktop-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'gate-'))
  const home = path.join(root, 'home')
  const hermesHome = path.join(root, 'engine-home')
  for (const d of ['home', 'appData', 'userData', 'tmp', 'logs', 'cache', 'sessionData']) {
    fs.mkdirSync(path.join(root, d), { recursive: true })
  }
  // engine-home is intentionally NOT created.
  return { root, home, hermesHome }
}

function runChild(mode: string, extraEnv: Record<string, string> = {}): any {
  const sandbox = makeSandbox()
  const childFile = path.join(sandbox.root, 'probe.cjs')
  fs.writeFileSync(childFile, CHILD)
  try {
    const out = execFileSync(process.execPath, [childFile], {
      encoding: 'utf-8',
      cwd: desktop,
      env: {
        ...process.env,
        ...extraEnv,
        GATE_MODE: mode,
        GATE_SANDBOX: sandbox.root,
        GATE_APPDIR: desktop,
        GATE_BUNDLE: bundlePath,
        GATE_SKIP: JSON.stringify([...NOT_INVOKED]),
        HOME: sandbox.home,
        HERMES_HOME: sandbox.hermesHome,
        HERMES_DESKTOP_VARIANT: 'plankton',
        NODE_ENV: 'production'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000
    })
    const marker = out.split('__RESULT__')[1]
    if (!marker) {
      throw new Error(`child produced no result marker: ${out.slice(0, 500)}`)
    }
    const parsed = JSON.parse(marker)
    parsed.__sandbox = sandbox
    return parsed
  } catch (error) {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
    throw error
  }
}

/** Files that prove the enterprise engine home was read/written. */
function homeArtifacts(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/state\.db|config\.yaml|desktop\.log/.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found
}

describe('plankton main-process login gate (real main.ts, logged out)', () => {
  beforeAll(async () => {
    const { build } = await import('esbuild')
    const { createRequire } = await import('node:module')
    // Resolve the plankton identity the same way the dev bundle does: the .cjs
    // reads HERMES_DESKTOP_VARIANT at require time. Bake it into the bundle so
    // main.ts never falls back to createRequire(import.meta.url) (undefined in
    // the CJS test bundle).
    const gateRequire = createRequire(path.join(desktop, 'product-identity.cjs'))
    const identityPath = path.join(desktop, 'product-identity.cjs')
    delete gateRequire.cache[identityPath]
    const priorVariant = process.env.HERMES_DESKTOP_VARIANT
    process.env.HERMES_DESKTOP_VARIANT = 'plankton'
    let identity: any
    try {
      identity = gateRequire(identityPath)
    } finally {
      if (priorVariant === undefined) {
        delete process.env.HERMES_DESKTOP_VARIANT
      } else {
        process.env.HERMES_DESKTOP_VARIANT = priorVariant
      }
      delete gateRequire.cache[identityPath]
    }
    expect(identity.enterprise, 'test identity must be the plankton variant').toBe(true)

    fs.mkdirSync(bundleDir, { recursive: true })
    await build({
      absWorkingDir: desktop,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron', 'node-pty', 'get-windows'],
      define: {
        'import.meta.url': '__gateImportMetaUrl',
        __HERMES_PRODUCT_IDENTITY__: JSON.stringify(identity)
      },
      banner: { js: "const __gateImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
      entryPoints: [path.join(here, 'main.ts')],
      outfile: bundlePath,
      logLevel: 'error'
    })
  }, 180_000)

  afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true })
  })

  it('registers the named controlled channels (the gate has something to cover)', () => {
    const result = runChild('handlers')
    try {
      expect(result.fatal, result.fatal).toBeNull()
      for (const channel of NAMED_CONTROLLED) {
        expect(result.channels, `${channel} not registered`).toContain(channel)
      }
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })

  it('logged out: EVERY non-public invoke channel is refused before its business handler runs', () => {
    const result = runChild('handlers')
    try {
      expect(result.fatal, result.fatal).toBeNull()
      const results: Record<string, any> = result.results
      expect(Object.keys(results).length).toBeGreaterThan(100)

      const leaked: string[] = []
      const threw: string[] = []

      for (const channel of result.channels) {
        if (PUBLIC.has(channel) || NOT_INVOKED.has(channel)) {
          continue
        }
        const value = results[channel]
        if (value && value.ok === false && value.code === 'not-authenticated') {
          continue
        }
        if (value && value.threw) {
          threw.push(`${channel}: ${value.threw}`)
        } else {
          leaked.push(`${channel}: ${JSON.stringify(value)}`)
        }
      }

      // A business handler executing with no args would throw or return its own
      // shape — the uniform denial payload can only come from the gate.
      expect(threw, `business handler ran for:\n${threw.join('\n')}`).toEqual([])
      expect(leaked, `channel NOT gated while logged out:\n${leaked.join('\n')}`).toEqual([])
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })

  it('logged out: the login surface still works (else login is impossible)', () => {
    const result = runChild('handlers')
    try {
      expect(result.fatal, result.fatal).toBeNull()
      const results = result.results
      expect(results['plankton:sso-status'].ok).toBe(true)
      expect(results['plankton:sso-status'].loggedIn).toBe(false)
      expect(results['plankton:sso-logout'].ok).toBe(true)
      expect(results['hermes:version'].appVersion).toBeTruthy()
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })

  it('logged out: no backend spawn and no enterprise home write on the startup path', () => {
    const loaded = runChild('handlers')
    const started = runChild('startup')
    for (const result of [loaded, started]) {
      try {
        expect(result.fatal, result.fatal).toBeNull()
        expect(result.spawnCount, `backend spawned: ${JSON.stringify(result.spawnedArgs)}`).toBe(0)
        // The engine home must never be created while logged out.
        expect(fs.existsSync(result.__sandbox.hermesHome), 'engine home was created').toBe(false)
        expect(homeArtifacts(result.__sandbox.root)).toEqual([])
      } finally {
        fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
      }
    }
  }, 120_000)

  // The gate is installed by ASSIGNING OVER `ipcMain.handle`. These two prove
  // the startup self-check is load-bearing: a stub `handle` that cannot be
  // wrapped (read-only) must ABORT the launch — not boot with an ungated IPC
  // surface. Remove the self-check and the "silently ignored" case loads clean
  // (fatal=null) with every invoke channel reachable while logged out.
  it('self-check aborts startup when a read-only ipcMain.handle write THROWS (fail-closed)', () => {
    const result = runChild('load', { GATE_IPC_HANDLE: 'readonly-throw' })
    try {
      expect(result.fatal, 'a failing handle assignment must abort, not boot').toBeTruthy()
      // The self-check message (not a bare TypeError) proves the abort path ran.
      expect(result.fatal).toMatch(/ipc gate self-check failure/i)
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })

  it('self-check aborts startup when a read-only ipcMain.handle write is SILENTLY ignored (fail-closed)', () => {
    const result = runChild('load', { GATE_IPC_HANDLE: 'readonly-silent' })
    try {
      expect(result.fatal, 'a silently-ignored wrap must abort, not boot ungated').toBeTruthy()
      expect(result.fatal).toMatch(/ipc gate self-check failure/i)
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })

  it('self-check passes on a healthy writable handle and leaves no probe channel behind', () => {
    const result = runChild('load')
    try {
      expect(result.fatal, result.fatal).toBeNull()
      expect(result.channels, 'the self-check probe channel was not cleaned up').not.toContain(
        'plankton:gate-selfcheck'
      )
    } finally {
      fs.rmSync(result.__sandbox.root, { recursive: true, force: true })
    }
  })
})
