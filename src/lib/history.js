// 截图历史：每次完成的截图（复制/保存/贴图）落盘到 userData/history，
// 索引 JSON 原子写入，缩略图在记录时用 nativeImage 预生成，上限 20 条自动淘汰最旧
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { nativeImage } = require('electron')

const MAX_ITEMS = 20
const THUMB_WIDTH = 220

class History {
  constructor(rootDir) {
    this.dir = path.join(rootDir, 'history')
    this.indexFile = path.join(rootDir, 'history.json')
    fs.mkdirSync(this.dir, { recursive: true })
    this.items = this.load()
    this.localMetaCache = new Map() // key: 路径|mtime|size → { w, h, thumb }（避免重复解码大图）
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (Array.isArray(raw)) return raw.filter((it) => it && it.id && it.file && fs.existsSync(it.file))
    } catch {
      /* 首次运行或文件损坏 */
    }
    return []
  }

  save() {
    const tmp = this.indexFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    fs.renameSync(tmp, this.indexFile)
  }

  record(dataUrl) {
    try {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '')
      if (!m) return null
      const buf = Buffer.from(m[1], 'base64')
      const img = nativeImage.createFromBuffer(buf)
      if (img.isEmpty()) return null
      const size = img.getSize()
      const id = crypto.randomUUID()
      const file = path.join(this.dir, `hist_${Date.now()}_${id.slice(0, 8)}.png`)
      fs.writeFileSync(file, buf)
      const item = {
        id,
        file,
        ts: Date.now(),
        w: size.width,
        h: size.height,
        bytes: buf.length,
        thumb: img.resize({ width: Math.min(THUMB_WIDTH, size.width) }).toDataURL(),
      }
      this.items.unshift(item)
      while (this.items.length > MAX_ITEMS) {
        const old = this.items.pop()
        try {
          fs.rmSync(old.file, { force: true })
        } catch {
          /* 忽略单个文件删除失败 */
        }
      }
      this.save()
      return { id, ts: item.ts }
    } catch {
      return null // 历史记录失败不影响截图主流程
    }
  }

  list() {
    const ok = this.items.filter((it) => fs.existsSync(it.file))
    if (ok.length !== this.items.length) {
      this.items = ok
      this.save()
    }
    return this.items
  }

  getImage(id) {
    const it = this.items.find((x) => x.id === id)
    if (!it || !fs.existsSync(it.file)) return null
    try {
      return nativeImage.createFromPath(it.file).toDataURL()
    } catch {
      return null
    }
  }

  // 扫描本地保存目录（如「图片\截图助手」）中的截图文件，按修改时间取最近 20 张合并进历史
  // 缩略图按 路径|mtime|size 缓存在内存，二次打开无需重复解码
  listLocal(dir) {
    const out = []
    try {
      if (!dir || !fs.existsSync(dir)) return out
      const names = fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.png'))
        .map((n) => {
          const p = path.join(dir, n)
          let st = null
          try {
            st = fs.statSync(p)
          } catch {
            return null
          }
          return st && st.isFile() ? { p, mtime: st.mtimeMs, bytes: st.size } : null
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_ITEMS)
      for (const f of names) {
        try {
          const key = `${f.p}|${f.mtime}|${f.bytes}`
          let entry = this.localMetaCache.get(key)
          if (!entry) {
            const img = nativeImage.createFromPath(f.p)
            if (img.isEmpty()) continue
            const size = img.getSize()
            entry = {
              w: size.width,
              h: size.height,
              thumb: img.resize({ width: Math.min(THUMB_WIDTH, size.width) }).toDataURL(),
            }
            this.localMetaCache.set(key, entry)
          }
          out.push({
            id: 'local:' + f.p,
            file: f.p,
            ts: f.mtime,
            w: entry.w,
            h: entry.h,
            bytes: f.bytes,
            thumb: entry.thumb,
            local: true,
          })
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
    } catch {
      /* 目录不可读时忽略本地扫描 */
    }
    return out
  }

  remove(id) {
    const it = this.items.find((x) => x.id === id)
    if (!it) return false
    try {
      fs.rmSync(it.file, { force: true })
    } catch {
      /* 忽略 */
    }
    this.items = this.items.filter((x) => x.id !== id)
    this.save()
    return true
  }

  clear() {
    for (const it of this.items) {
      try {
        fs.rmSync(it.file, { force: true })
      } catch {
        /* 忽略 */
      }
    }
    this.items = []
    this.save()
  }
}

module.exports = { History }
