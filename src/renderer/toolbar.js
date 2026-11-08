// 编辑工具条窗口：按钮点击 → IPC → 主进程 → 贴图编辑器
(() => {
  const api = window.shotAPI
  const COLORS = ['#e5484d', '#ef9f43', '#f5cf3a', '#27a875', '#3d8be9', '#9d7bea', '#1a2036', '#ffffff']
  let color = COLORS[0]
  let strokeW = 2
  let popOpen = false

  const colorDot = document.getElementById('colorDot')
  const widthDot = document.getElementById('widthDot')
  const tbPop = document.getElementById('tbPop')

  function syncDots() {
    colorDot.style.background = color
    const d = 2 + strokeW * 2
    widthDot.style.width = d + 'px'
    widthDot.style.height = d + 'px'
  }

  function act(action, arg) {
    api.toolbarAction(action, arg)
  }

  function togglePop() {
    popOpen ? closePop() : openPop()
  }

  function openPop() {
    popOpen = true
    tbPop.style.display = 'block'
    const br = document.getElementById('colorBtn').getBoundingClientRect()
    const pw = tbPop.offsetWidth
    let x = br.left + br.width / 2 - pw / 2
    x = Math.max(4, Math.min(innerWidth - pw - 4, x))
    let y = br.top - tbPop.offsetHeight - 6
    if (y < 4) y = br.bottom + 6
    tbPop.style.left = x + 'px'
    tbPop.style.top = y + 'px'
  }

  function closePop() {
    if (!popOpen) return
    popOpen = false
    tbPop.style.display = 'none'
  }

  // ---- 构建 ----
  const swBox = document.getElementById('popSwatches')
  for (const c of COLORS) {
    const b = document.createElement('button')
    b.className = 'sw' + (c === color ? ' active' : '')
    b.style.background = c
    b.dataset.c = c
    b.title = c
    b.addEventListener('click', () => {
      color = c
      swBox.querySelectorAll('.sw').forEach((x) => x.classList.toggle('active', x.dataset.c === c))
      syncDots()
    })
    swBox.appendChild(b)
  }
  document.querySelectorAll('#popWidths .pwd').forEach((b) => {
    b.addEventListener('click', () => {
      strokeW = Number(b.dataset.w)
      document.querySelectorAll('#popWidths .pwd').forEach((x) => x.classList.toggle('active', x === b))
      syncDots()
      closePop()
    })
  })
  document.querySelector(`#popWidths .pwd[data-w="${strokeW}"]`)?.classList.add('active')
  syncDots()

  // ---- 事件 ----
  document.querySelectorAll('#tb .tb[data-tool]').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.tool
      b.classList.toggle('active')
      act('setTool', b.classList.contains('active') ? t : null)
    })
  })
  document.getElementById('undoBtn').addEventListener('click', () => act('undo'))
  document.getElementById('redoBtn').addEventListener('click', () => act('redo'))
  document.getElementById('colorBtn').addEventListener('click', togglePop)
  document.getElementById('widthBtn').addEventListener('click', togglePop)
  document.getElementById('ocrBtn').addEventListener('click', () => act('ocr'))
  document.getElementById('saveBtn').addEventListener('click', () => act('save'))
  document.getElementById('copyBtn').addEventListener('click', () => act('copy'))
  document.getElementById('doneBtn').addEventListener('click', () => act('done'))

  // 点击弹层外关闭弹层
  document.addEventListener('mousedown', (e) => {
    if (popOpen && !e.target.closest?.('#tbPop') && !e.target.closest?.('#colorBtn') && !e.target.closest?.('#widthBtn')) {
      closePop()
    }
  })

  // OCR 面板事件
  document.getElementById('ocrCopyAll').addEventListener('click', () => {
    const lines = [...document.querySelectorAll('#ocrLines .ocr-line')].map((r) => r.textContent)
    api.clip.writeText(lines.join('\n'))
  })
  document.getElementById('ocrClose').addEventListener('click', hideOcrPanel)

  function hideOcrPanel() {
    document.getElementById('ocrPanel').style.display = 'none'
  }

  // 主进程 → 显示 OCR 结果
  api.on('toolbar:ocrResult', ({ lines, lang }) => {
    const box = document.getElementById('ocrLines')
    box.innerHTML = ''
    if (!lines || !lines.length) {
      const row = document.createElement('div')
      row.className = 'ocr-line'
      row.textContent = '未识别到文字'
      box.appendChild(row)
    } else {
      for (const line of lines) {
        const row = document.createElement('div')
        row.className = 'ocr-line'
        row.textContent = line
        row.title = '点击复制本行'
        row.addEventListener('click', () => api.clip.writeText(line))
        box.appendChild(row)
      }
    }
    document.getElementById('ocrTitle').textContent = `文字识别 · ${lines ? lines.length : 0} 行${lang ? ' · ' + lang : ''}`
    document.getElementById('ocrPanel').style.display = 'flex'
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePop()
      hideOcrPanel()
    }
  })
})()
