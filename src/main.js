// 截图助手 · 主进程：生命周期 / 托盘 / 全局快捷键 / 截图编排 / 倒计时 / 设置窗口 / IPC
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeTheme,
  globalShortcut,
  dialog,
  screen,
  shell,
  clipboard,
  nativeImage,
} = require('electron')
const path = require('path')
const fs = require('fs')
const { Store } = require('./lib/store')
const { CaptureController } = require('./lib/capture')
const ocr = require('./lib/ocr')
const { History } = require('./lib/history')
const { windowAtPointPhys } = require('./lib/win32')

const ICON = path.join(__dirname, '..', 'assets', 'icon.png')
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png')

// 应用内文件日志：GUI 子系统下 console.log 不可靠（无标准输出句柄），排查问题以 run.log 为准
const LOG_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), 'run.log')
  : path.join(__dirname, '..', '.run.log')
function log(...parts) {
  try {
    const d = new Date()
    const ts =
      String(d.getHours()).padStart(2, '0') +
      ':' + String(d.getMinutes()).padStart(2, '0') +
      ':' + String(d.getSeconds()).padStart(2, '0') +
      '.' + String(d.getMilliseconds()).padStart(3, '0')
    fs.appendFileSync(LOG_FILE, ts + ' ' + parts.join(' ') + '\n')
  } catch { /* 日志失败不影响功能 */ }
}

let store = null
let capture = null
let history = null
let tray = null
let mainWindow = null
let canvasWindow = null
let countdownWindow = null
let countdownTimer = null
let quitting = false
let hotkey = '' // 实际注册成功的全局快捷键

// ---- 主题 ----
const effectiveTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
function applyThemeSetting(source) {
  nativeTheme.themeSource = source // 'system' | 'light' | 'dark'
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme:changed', { source, effective: effectiveTheme() })
  }
}

// ---- 保存成功通知（截图保存 / 历史另存共用） ----
function notifySaved(filePath) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: '截图已保存', body: filePath, icon: TRAY_ICON })
  n.on('click', () => shell.showItemInFolder(filePath))
  n.show()
}

// ---- 画布原图查看器（独立无边框窗口：原生边缘调整大小 + 顶部拖动移动 + 画布缩放平移） ----
function openCanvasWindow(dataUrl, metaText) {
  if (!dataUrl) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const size = nativeImage.createFromDataURL(dataUrl).getSize()
  const wa = display.workArea
  const maxW = Math.round(wa.width * 0.85)
  const maxH = Math.round(wa.height * 0.85)
  const w = Math.max(320, Math.min(Math.round(size.width / display.scaleFactor), maxW))
  const h = Math.max(240, Math.min(Math.round(size.height / display.scaleFactor), maxH))
  if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
  canvasWindow = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w,
    height: h,
    minWidth: 320,
    minHeight: 240,
    frame: false,
    resizable: true, // 无边框窗口在 Windows 保留不可见缩放边：拖窗口边缘 = 调整画布大小
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#10141f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  canvasWindow.setAlwaysOnTop(true, 'screen-saver')
  canvasWindow.setContentProtection(true) // 查看器自身不进入截图
  canvasWindow.on('closed', () => {
    canvasWindow = null
  })
  canvasWindow.loadFile(path.join(__dirname, 'renderer', 'canvas.html')).then(() => {
    canvasWindow.webContents.send('cv:init', { dataUrl, metaText })
    canvasWindow.show()
    canvasWindow.focus()
  })
}

// ---- 主窗口（设置 / 历史记录 页签） ----
function createMainWindow(page = 'settings') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('main:page', { page })
    return
  }
  mainWindow = new BrowserWindow({
    width: 660,
    height: 700,
    frame: false,
    transparent: true, // 配合 CSS 圆角（Win10 无系统级圆角）
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    icon: ICON,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'main.html'))
  // 页签事件等渲染层脚本就绪后再发（ready-to-show 晚于 did-finish-load）
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.webContents.send('main:page', { page })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---- 倒计时（延时截图） ----
function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  if (countdownWindow && !countdownWindow.isDestroyed()) countdownWindow.close()
  countdownWindow = null
}

function startCountdown(sec) {
  if (capture.isActive()) return
  stopCountdown()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width: w, height: h } = display.workArea
  countdownWindow = new BrowserWindow({
    width: 190,
    height: 190,
    x: Math.round(x + (w - 190) / 2),
    y: Math.round(y + (h - 190) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false, // 不抢焦点，方便先摆好要截的画面
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  countdownWindow.setAlwaysOnTop(true, 'screen-saver')
  countdownWindow.setContentProtection(true) // 倒计时窗不进入截图
  countdownWindow.loadFile(path.join(__dirname, 'renderer', 'countdown.html'))
  countdownWindow.once('ready-to-show', () => {
    countdownWindow.showInactive()
    countdownWindow.webContents.send('countdown:tick', { n: sec, total: sec })
  })
  countdownWindow.on('closed', () => {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    countdownWindow = null
  })
  let n = sec
  countdownTimer = setInterval(() => {
    if (!countdownWindow || countdownWindow.isDestroyed()) return
    n -= 1
    if (n <= 0) {
      stopCountdown()
      startCapture()
    } else {
      countdownWindow.webContents.send('countdown:tick', { n, total: sec })
    }
  }, 1000)
}

// ---- 截图入口 ----
function startCapture() {
  stopCountdown()
  capture.start()
}

// ---- 托盘 ----
function createTray() {
  tray = new Tray(TRAY_ICON)
  tray.setToolTip(hotkey ? `截图助手 — ${hotkey} 截图` : '截图助手')
  tray.on('click', () => createMainWindow()) // 左键打开主窗口（设置页）
  tray.on('double-click', () => createMainWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkey ? `截图 (${hotkey})` : '截图', click: () => startCapture() },
      { label: '3 秒后截图', click: () => startCountdown(3) },
      { label: '5 秒后截图', click: () => startCountdown(5) },
      { type: 'separator' },
      { label: '历史记录', click: () => createMainWindow('history') },
      { label: '设置', click: () => createMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])
  )
}

// ---- 全局快捷键 ----
function registerHotkeys() {
  for (const key of ['F1', 'CommandOrControl+Alt+A']) {
    try {
      if (globalShortcut.register(key, () => startCapture())) {
        hotkey = key
        return
      }
    } catch {
      /* 尝试下一个 */
    }
  }
  hotkey = ''
  if (Notification.isSupported()) {
    new Notification({
      title: '截图助手',
      body: '全局快捷键注册失败，仍可通过托盘图标截图',
      icon: TRAY_ICON,
    }).show()
  }
}

process.on('uncaughtException', (err) => log('[main] uncaughtException:', err && err.stack))
process.on('unhandledRejection', (err) => log('[main] unhandledRejection:', err && (err.stack || err)))
app.on('child-process-gone', (_e, details) => log('[main] child-process-gone:', JSON.stringify(details)))

// ---- 应用生命周期 ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createMainWindow())

  app.whenReady().then(() => {
    app.setAppUserModelId('com.local.screenshot-assistant')
    store = new Store(app.getPath('userData'))
    history = new History(app.getPath('userData'))

    capture = new CaptureController({
      getSettings: () => store.getSettings(),
      log,
      onSaved: notifySaved,
      onRecord: (dataUrl) => history.record(dataUrl),
    })

    applyThemeSetting(store.getSettings().theme)
    registerHotkeys()
    createTray()
    registerIpc()

    screen.on('display-removed', () => capture.cancel())
    nativeTheme.on('updated', () => applyThemeSetting(store.getSettings().theme))
  })

  app.on('window-all-closed', () => {
    /* 常驻托盘，不退出 */
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())
}

// ---- IPC ----
function registerIpc() {
  // 覆盖层
  ipcMain.handle('overlay:ready', (e) => {
    // 预热完成（仅用于池建立确认，抓屏加载用 did-finish-load 兜底）
    return true
  })
  ipcMain.handle('capture:ready', (_e, displayId) => capture.onCaptureReady(displayId))
  ipcMain.handle('capture:finish', (_e, action, payload) => capture.finish(action, payload))
  ipcMain.handle('capture:cancel', () => capture.cancel())

  // 贴图
  ipcMain.handle('pin:drag', (e, dx, dy) => capture.pinDrag(e, dx, dy))
  ipcMain.handle('pin:zoom', (e, info) => capture.pinZoom(e, info))
  ipcMain.handle('pin:menu', (e) => capture.pinMenu(e))
  ipcMain.handle('pin:close', (e) => {
    const meta = capture.pinByEvent(e)
    if (meta) meta.win.close()
  })

  // 倒计时
  ipcMain.handle('countdown:cancel', () => stopCountdown())

  // 窗口智能识别：物理坐标查询 → 转 DIP 矩形返回
  ipcMain.handle('win:atPoint', (_e, dipX, dipY) => {
    try {
      const dip = { x: Number(dipX) || 0, y: Number(dipY) || 0 }
      const phys = screen.dipToScreenPoint(dip)
      const exclude = new Set()
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) exclude.add(w.getNativeWindowHandle().readBigUInt64LE(0))
      }
      const r = windowAtPointPhys(phys.x, phys.y, exclude)
      if (!r) return null
      const tl = screen.screenToDipPoint({ x: r.left, y: r.top })
      const br = screen.screenToDipPoint({ x: r.right, y: r.bottom })
      return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
    } catch {
      return null
    }
  })

  // OCR 与剪贴板文本
  ipcMain.handle('ocr:run', (_e, dataUrl) => ocr.runOcr(dataUrl))
  ipcMain.handle('clip:writeText', (_e, text) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // 历史记录
  // 应用内历史 + 本地保存目录中的截图文件，按时间合并
  const localSaveDir = () => store.getSettings().saveDir || path.join(app.getPath('pictures'), '截图助手')
  const historyImageData = (id) => {
    if (typeof id === 'string' && id.startsWith('local:')) {
      const file = id.slice(6)
      try {
        if (!fs.existsSync(file)) return null
        return nativeImage.createFromPath(file).toDataURL()
      } catch {
        return null
      }
    }
    return history.getImage(id)
  }
  ipcMain.handle('history:list', () =>
    [...history.list(), ...history.listLocal(localSaveDir())].sort((a, b) => b.ts - a.ts)
  )
  ipcMain.handle('history:copy', (_e, id) => {
    const dataUrl = historyImageData(id)
    if (!dataUrl) return false
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
    return true
  })
  ipcMain.handle('history:pin', (_e, id) => {
    const dataUrl = historyImageData(id)
    if (!dataUrl) return false
    const size = nativeImage.createFromDataURL(dataUrl).getSize()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    let w = Math.round(size.width / display.scaleFactor)
    let h = Math.round(size.height / display.scaleFactor)
    const wa = display.workArea
    const maxW = Math.round(wa.width * 0.8)
    const maxH = Math.round(wa.height * 0.8)
    if (w > maxW || h > maxH) {
      const k = Math.min(maxW / w, maxH / h)
      w = Math.round(w * k)
      h = Math.round(h * k)
    }
    capture.createPin(
      dataUrl,
      { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h },
      store.getSettings().pinOpacity
    )
    return true
  })
  ipcMain.handle('history:save', async (_e, id) => {
    const dataUrl = historyImageData(id)
    if (!dataUrl) return false
    const filePath = await capture.saveImage(dataUrl)
    if (filePath) notifySaved(filePath)
    return !!filePath
  })
  ipcMain.handle('history:image', (_e, id) => historyImageData(id))
  // 画布原图查看器（独立可缩放窗口）
  ipcMain.handle('canvasViewer:open', (_e, id) => {
    const dataUrl = historyImageData(id)
    if (!dataUrl) return false
    const dir = store.getSettings().saveDir || path.join(app.getPath('pictures'), '截图助手')
    const item = [...history.list(), ...history.listLocal(dir)]
      .sort((a, b) => b.ts - a.ts)
      .find((x) => x.id === id)
    const pad2 = (n) => String(n).padStart(2, '0')
    const d = new Date(item.ts)
    const metaText = item
      ? `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${item.w} × ${item.h} 原图${item.local ? ' · 本地文件' : ''}`
      : ''
    openCanvasWindow(dataUrl, metaText)
    return true
  })
  ipcMain.handle('canvasViewer:close', () => {
    if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
  })
  ipcMain.handle('history:remove', (_e, id) => {
    // 本地文件条目：真删磁盘文件（渲染层已确认）
    if (typeof id === 'string' && id.startsWith('local:')) {
      try {
        fs.rmSync(id.slice(6), { force: true })
        return true
      } catch {
        return false
      }
    }
    return history.remove(id)
  })
  ipcMain.handle('history:openLocation', (_e, id) => {
    const file =
      typeof id === 'string' && id.startsWith('local:')
        ? id.slice(6)
        : history.list().find((x) => x.id === id)?.file
    if (file && fs.existsSync(file)) shell.showItemInFolder(file)
    return true
  })
  ipcMain.handle('history:clear', () => history.clear())

  // 设置
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch)
    if (patch.theme !== undefined) {
      applyThemeSetting(patch.theme === 'dark' ? 'dark' : patch.theme === 'light' ? 'light' : 'system')
    }
    return s
  })

  // 应用
  ipcMain.handle('app:autostart:get', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:autostart:set', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:chooseSaveDir', async () => {
    const s = store.getSettings()
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存目录',
      defaultPath: s.saveDir || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths.length) return null
    store.setSettings({ saveDir: filePaths[0] })
    return filePaths[0]
  })
  ipcMain.handle('app:openDataFolder', () => shell.openPath(store.dir))
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('theme:state', () => ({ source: store.getSettings().theme, effective: effectiveTheme() }))
}
