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
} = require('electron')
const path = require('path')
const { Store } = require('./lib/store')
const { CaptureController } = require('./lib/capture')

const ICON = path.join(__dirname, '..', 'assets', 'icon.png')
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png')

let store = null
let capture = null
let tray = null
let settingsWindow = null
let countdownWindow = null
let countdownTimer = null
let quitting = false
let hotkey = '' // 实际注册成功的全局快捷键

// ---- 主题 ----
const effectiveTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
function applyThemeSetting(source) {
  nativeTheme.themeSource = source // 'system' | 'light' | 'dark'
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('theme:changed', { source, effective: effectiveTheme() })
  }
}

// ---- 设置窗口 ----
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 660,
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
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'))
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
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
  tray.on('click', () => createSettingsWindow()) // 左键打开设置（与右键菜单「设置」一致）
  tray.on('double-click', () => createSettingsWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkey ? `截图 (${hotkey})` : '截图', click: () => startCapture() },
      { label: '3 秒后截图', click: () => startCountdown(3) },
      { label: '5 秒后截图', click: () => startCountdown(5) },
      { type: 'separator' },
      { label: '设置', click: () => createSettingsWindow() },
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

process.on('uncaughtException', (err) => console.log('[main] uncaughtException:', err && err.stack))
process.on('unhandledRejection', (err) => console.log('[main] unhandledRejection:', err && (err.stack || err)))

// ---- 应用生命周期 ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createSettingsWindow())

  app.whenReady().then(() => {
    app.setAppUserModelId('com.local.screenshot-assistant')
    store = new Store(app.getPath('userData'))

    capture = new CaptureController({
      getSettings: () => store.getSettings(),
      onSaved: (filePath) => {
        if (!Notification.isSupported()) return
        const n = new Notification({
          title: '截图已保存',
          body: filePath,
          icon: TRAY_ICON,
        })
        n.on('click', () => shell.showItemInFolder(filePath))
        n.show()
      },
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
    const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow, {
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
