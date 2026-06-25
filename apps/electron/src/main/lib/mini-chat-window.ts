/**
 * Mini Chat 窗口管理
 *
 * 预创建隐藏窗口，通过全局快捷键（Control+Space）唤起。
 * 无边框 + 透明 + 置顶，可覆盖全屏应用之上。
 * 仅通过快捷键 toggle 显示/隐藏（不移除 blur 自动隐藏）。
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { app } from 'electron'

/** Mini Chat 窗口单例 */
let miniChatWindow: BrowserWindow | null = null

/** 窗口宽高 */
const WINDOW_WIDTH = 650
const WINDOW_HEIGHT = 520

/**
 * 预创建 Mini Chat 窗口（隐藏状态）
 *
 * 在 app.whenReady() 中调用，避免首次唤起时的创建延迟。
 */
export function createMiniChatWindow(): void {
  if (miniChatWindow && !miniChatWindow.isDestroyed()) return

  miniChatWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 480,
    minHeight: 400,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    // 关键：允许窗口在不激活的情况下接收点击，防止 macOS 切换 Space
    acceptFirstMouse: true,
    // panel 类型不会让应用激活到前台，可在不切换 Space 的情况下显示
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 全屏悬浮：覆盖全屏应用之上 + 所有桌面空间可见
  // 使用 screen-saver 层级（高于 floating），可覆盖 macOS 全屏应用
  miniChatWindow.setAlwaysOnTop(true, 'screen-saver')
  miniChatWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })

  // 加载渲染进程（附带 query 参数区分窗口类型）
  const isDev = !app.isPackaged
  if (isDev) {
    miniChatWindow.loadURL('http://localhost:5173?window=mini-chat')
  } else {
    miniChatWindow.loadFile(join(__dirname, 'renderer', 'index.html'), {
      query: { window: 'mini-chat' },
    })
  }

  // 窗口关闭时置空引用
  miniChatWindow.on('closed', () => {
    miniChatWindow = null
  })

  console.log('[Mini Chat 窗口] 预创建完成')
}

/**
 * 切换 Mini Chat 窗口显示/隐藏
 *
 * 窗口居中于鼠标所在显示器的上方位置。
 */
export function toggleMiniChatWindow(): void {
  if (!miniChatWindow || miniChatWindow.isDestroyed()) {
    createMiniChatWindow()
    miniChatWindow?.once('ready-to-show', () => {
      positionAndShow()
    })
    return
  }

  if (miniChatWindow.isVisible()) {
    miniChatWindow.hide()
  } else {
    positionAndShow()
  }
}

/** 定位到鼠标所在显示器并显示 */
function positionAndShow(): void {
  if (!miniChatWindow || miniChatWindow.isDestroyed()) return

  // 获取鼠标所在的显示器
  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const { x, y, width, height } = display.workArea

  // 保留用户调整后的尺寸（首次显示时使用默认值）
  const currentBounds = miniChatWindow.getBounds()
  const winWidth = currentBounds.width || WINDOW_WIDTH
  const winHeight = currentBounds.height || WINDOW_HEIGHT

  // 居中水平，垂直方向位于屏幕上方 25%
  const posX = Math.round(x + (width - winWidth) / 2)
  const posY = Math.round(y + height * 0.25)

  miniChatWindow.setBounds({
    x: posX,
    y: posY,
    width: winWidth,
    height: winHeight,
  })

  // 关键：用 showInactive 不激活应用本身，避免 macOS 切换 Space
  // 然后用 moveTop 把窗口提到最上层
  miniChatWindow.showInactive()
  miniChatWindow.moveTop()

  // 短暂延迟后再聚焦窗口（此时 Space 已经稳定）
  setTimeout(() => {
    if (miniChatWindow && !miniChatWindow.isDestroyed() && miniChatWindow.isVisible()) {
      miniChatWindow.focus()
      // 通知渲染进程聚焦输入框
      miniChatWindow.webContents.send('mini-chat:focus')
    }
  }, 50)
}

/**
 * 隐藏 Mini Chat 窗口
 */
export function hideMiniChatWindow(): void {
  if (miniChatWindow && !miniChatWindow.isDestroyed() && miniChatWindow.isVisible()) {
    miniChatWindow.hide()
  }
}

/**
 * 获取 Mini Chat 窗口实例（用于 IPC 注册）
 */
export function getMiniChatWindow(): BrowserWindow | null {
  return miniChatWindow
}

/**
 * 判断 Mini Chat 窗口是否可见
 */
export function isMiniChatWindowVisible(): boolean {
  return miniChatWindow !== null && !miniChatWindow.isDestroyed() && miniChatWindow.isVisible()
}

/**
 * 销毁 Mini Chat 窗口（应用退出时调用）
 */
export function destroyMiniChatWindow(): void {
  if (miniChatWindow && !miniChatWindow.isDestroyed()) {
    miniChatWindow.destroy()
    miniChatWindow = null
  }
}
