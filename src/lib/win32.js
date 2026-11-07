// Win32 窗口查询（koffi FFI）：框选前的窗口智能识别
// koffi 是本项目唯一的运行时依赖（预编译 N-API，Electron 无需 rebuild）
// 加载失败时所有查询返回 null，功能静默降级为手动框选
let api = null
let initTried = false

function ensure() {
  if (initTried) return api
  initTried = true
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')

    const HWND = koffi.pointer('HWND', koffi.opaque())
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })

    api = {
      GetTopWindow: user32.func('HWND __stdcall GetTopWindow(HWND hWnd)'),
      GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)'),
      GetAncestor: user32.func('HWND __stdcall GetAncestor(HWND hWnd, uint32_t gaFlags)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(HWND hWnd)'),
      GetWindowLongW: user32.func('int32_t __stdcall GetWindowLongW(HWND hWnd, int32_t nIndex)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
      DwmGetFrameBounds: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(HWND hWnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)'),
      DwmGetCloaked: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(HWND hWnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)'),
    }
  } catch {
    api = null
  }
  return api
}

const GA_ROOT = 2
const GW_HWNDNEXT = 2
const GWL_EXSTYLE = -20
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
const WS_EX_TRANSPARENT = 0x20 // 真正的点击穿透窗口，视为不存在
const WS_EX_TOOLWINDOW = 0x80 // 无标题工具窗（托盘助手等），不作为识别目标

// 按 Z 序遍历顶层窗口，返回包含物理坐标点 (px, py) 的第一个可用窗口的物理矩形
// exclude：BigInt 集合，为本应用顶层窗口的 HWND（避免识别到自己）
function windowAtPointPhys(px, py, exclude) {
  const a = ensure()
  if (!a) return null
  let hwnd = a.GetTopWindow(0)
  for (let i = 0; hwnd && i < 512; i++) {
    let next = 0
    try {
      next = a.GetWindow(hwnd, GW_HWNDNEXT)
      if (a.IsWindowVisible(hwnd) && !a.IsIconic(hwnd)) {
        const root = a.GetAncestor(hwnd, GA_ROOT)
        if (root && !exclude.has(root)) {
          const ex = a.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0
          if (!(ex & WS_EX_TRANSPARENT) && !(ex & WS_EX_TOOLWINDOW)) {
            const rect = { left: 0, top: 0, right: 0, bottom: 0 }
            let ok = false
            try {
              // DWM 边界不含 Win10 不可见的阴影/缩放边，比 GetWindowRect 更贴合视觉
              ok = a.DwmGetFrameBounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0
            } catch {
              ok = false
            }
            if (!ok) ok = a.GetWindowRect(hwnd, rect)
            if (
              ok &&
              rect.right > rect.left &&
              rect.bottom > rect.top &&
              px >= rect.left &&
              px < rect.right &&
              py >= rect.top &&
              py < rect.bottom
            ) {
              const cloak = [0]
              try {
                // UWP 挂起/隐藏窗口带 cloak 标记，视觉上不存在，跳过
                // 注意：koffi 原始类型出参必须用单元素数组盒
                if (a.DwmGetCloaked(hwnd, DWMWA_CLOAKED, cloak, 4) === 0 && cloak[0] !== 0) {
                  hwnd = next
                  continue
                }
              } catch {
                /* 查不到 cloak 视为未隐藏 */
              }
              return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                hwnd: root, // [TEST] 诊断用
              }
            }
          }
        }
      }
    } catch {
      /* 单窗口异常继续遍历 */
    }
    hwnd = next
  }
  return null
}

module.exports = { windowAtPointPhys }
