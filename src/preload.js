// 安全桥：向渲染层暴露最小 API 面（覆盖层 / 贴图 / 倒计时 / 设置 四类窗口共用）
const { contextBridge, ipcRenderer } = require('electron')

const EVENTS = ['capture:init', 'pin:init', 'countdown:tick', 'theme:changed', 'main:page']

const api = {
  platform: process.platform,
  overlay: {
    ready: () => ipcRenderer.invoke('overlay:ready'),
    captureReady: (displayId) => ipcRenderer.invoke('capture:ready', displayId),
    finish: (action, payload) => ipcRenderer.invoke('capture:finish', action, payload),
    cancel: () => ipcRenderer.invoke('capture:cancel'),
  },
  pin: {
    drag: (dx, dy) => ipcRenderer.invoke('pin:drag', dx, dy),
    zoom: (info) => ipcRenderer.invoke('pin:zoom', info),
    menu: () => ipcRenderer.invoke('pin:menu'),
    close: () => ipcRenderer.invoke('pin:close'),
  },
  countdown: {
    cancel: () => ipcRenderer.invoke('countdown:cancel'),
  },
  ocr: {
    run: (dataUrl) => ipcRenderer.invoke('ocr:run', dataUrl),
  },
  clip: {
    writeText: (text) => ipcRenderer.invoke('clip:writeText', text),
  },
  win: {
    atPoint: (x, y) => ipcRenderer.invoke('win:atPoint', x, y),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    copy: (id) => ipcRenderer.invoke('history:copy', id),
    pin: (id) => ipcRenderer.invoke('history:pin', id),
    save: (id) => ipcRenderer.invoke('history:save', id),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    openLocation: (id) => ipcRenderer.invoke('history:openLocation', id),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  app: {
    getAutostart: () => ipcRenderer.invoke('app:autostart:get'),
    setAutostart: (v) => ipcRenderer.invoke('app:autostart:set', v),
    chooseSaveDir: () => ipcRenderer.invoke('app:chooseSaveDir'),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    themeState: () => ipcRenderer.invoke('theme:state'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  on(channel, cb) {
    if (!EVENTS.includes(channel)) throw new Error('事件不在白名单: ' + channel)
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  },
}

contextBridge.exposeInMainWorld('shotAPI', api)
