// 历史记录窗口：缩略图列表 + 复制/贴图/另存/删除/清空
(async () => {
  const api = window.shotAPI
  const $ = (s) => document.querySelector(s)
  const listEl = $('#list')
  const emptyEl = $('#empty')
  const badge = $('#countBadge')

  const applyTheme = (effective) => {
    document.documentElement.dataset.theme = effective
  }

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const fmtSize = (bytes) => (bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB')

  async function copyItem(id) {
    const ok = await api.history.copy(id)
    if (ok) flash('已复制')
  }

  async function del(item) {
    if (item.local && !confirm('确定删除该本地截图文件？此操作不可恢复。')) return
    await api.history.remove(item.id)
    await load()
  }

  function flash(text) {
    const btn = $('#clearBtn')
    btn.textContent = text
    setTimeout(() => (btn.textContent = '清空'), 900)
  }

  function row(item) {
    const el = document.createElement('div')
    el.className = 'item'

    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = item.thumb
    img.title = '点击复制'
    img.addEventListener('click', () => copyItem(item.id))
    el.appendChild(img)

    const meta = document.createElement('div')
    meta.className = 'meta'
    const time = document.createElement('div')
    time.className = 'time'
    time.textContent = fmtTime(item.ts)
    if (item.local) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.textContent = '本地'
      time.appendChild(chip)
    }
    const sub = document.createElement('div')
    sub.className = 'sub'
    const name = item.local ? item.file.split(/[\\/]/).pop() + ' · ' : ''
    sub.textContent = `${name}${item.w} × ${item.h} · ${fmtSize(item.bytes)}`
    meta.append(time, sub)
    el.appendChild(meta)

    const ops = document.createElement('div')
    ops.className = 'ops'
    const actions = item.local
      ? [
          ['复制', () => copyItem(item.id), ''],
          ['贴图', () => api.history.pin(item.id), ''],
          ['打开位置', () => api.history.openLocation(item.id), ''],
          ['删除', () => del(item), 'del'],
        ]
      : [
          ['复制', () => copyItem(item.id), ''],
          ['贴图', () => api.history.pin(item.id), ''],
          ['另存', () => api.history.save(item.id), ''],
          ['删除', () => del(item), 'del'],
        ]
    for (const [label, fn, cls] of actions) {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.addEventListener('click', fn)
      ops.appendChild(b)
    }
    el.appendChild(ops)
    return el
  }

  async function load() {
    const items = await api.history.list()
    listEl.innerHTML = ''
    emptyEl.style.display = items.length ? 'none' : 'flex'
    $('#emptyText').innerHTML = items.length
      ? ''
      : '还没有截图记录<br /><span>完成一次截图（复制 / 保存 / 贴图）后会自动出现在这里</span>'
    badge.textContent = items.length ? `${items.length} / 20` : ''
    for (const it of items) listEl.appendChild(row(it))
  }

  $('#clearBtn').addEventListener('click', async () => {
    const items = await api.history.list()
    if (!items.length) return
    if (!confirm(`确定清空全部 ${items.length} 条应用内历史记录？\n本地保存的文件不受影响。`)) return
    await api.history.clear()
    await load()
  })
  $('#closeBtn').addEventListener('click', () => window.close())

  const state = await api.app.themeState()
  applyTheme(state.effective)
  api.on('theme:changed', ({ effective }) => applyTheme(effective))
  await load()
})()
