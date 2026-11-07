// 设置存储：单文档 JSON（临时文件 + rename 原子落盘），主进程独占写入
const fs = require('fs')
const path = require('path')

const DEFAULT_SETTINGS = {
  saveMode: 'ask', // 'ask' 每次询问 | 'auto' 自动保存
  saveDir: '', // 自动保存目录；空 = 图片\截图助手
  pinOpacity: 100, // 贴图默认不透明度 50~100
  theme: 'system', // 'system' | 'light' | 'dark'
  pinHintShown: false, // 首次贴图操作提示只弹一次
}

class Store {
  constructor(dir) {
    this.dir = dir
    this.data = { settings: { ...DEFAULT_SETTINGS } }
    this.onChange = null // (collection) => void
    this.loadAll()
  }

  file(col) {
    return path.join(this.dir, col + '.json')
  }

  loadAll() {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      const raw = fs.readFileSync(this.file('settings'), 'utf8')
      const parsed = JSON.parse(raw)
      this.data.settings = { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      /* 首次运行或文件损坏，保留默认值 */
    }
  }

  save(col) {
    const tmp = this.file(col) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data[col], null, 2), 'utf8')
    fs.renameSync(tmp, this.file(col))
  }

  getSettings() {
    return this.data.settings
  }

  setSettings(patch) {
    Object.assign(this.data.settings, patch)
    this.save('settings')
    this.emit('settings')
    return this.data.settings
  }

  emit(col) {
    if (this.onChange) this.onChange(col)
  }
}

module.exports = { Store, DEFAULT_SETTINGS }
