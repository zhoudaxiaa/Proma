/**
 * WelcomeEmptyState — 对话/会话空状态引导
 *
 * 在没有会话时展示：
 * 1. 个性化时段问候
 * 2. 平台感知的小 Tips
 */

import * as React from 'react'
import { useAtomValue, useAtom } from 'jotai'
import { Lightbulb, MessageSquare, Bot, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { userProfileAtom } from '@/atoms/user-profile'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { themeStyleAtom } from '@/atoms/theme'
import { getRandomTip, getPlatform, type Tip } from '@/lib/tips'

/** 根据小时返回时段问候 */
function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/** 模式配置 */
const MODE_CONFIG: Record<AppMode, { icon: React.ReactNode; label: string }> = {
  chat: { icon: <MessageSquare size={15} />, label: 'Chat' },
  agent: { icon: <Bot size={15} />, label: 'Agent' },
  scratch: { icon: <StickyNote size={15} />, label: 'Scratch Pad' },
}

export function WelcomeEmptyState(): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const [mode, setMode] = useAtom(appModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)

  // 稳定的随机 Tip（组件挂载时选一条）
  const [tip] = React.useState<Tip>(() => getRandomTip(getPlatform()))

  const hour = new Date().getHours()
  const greeting = getGreeting(hour)
  const displayName = userProfile.userName || '用户'

  // 森息晨光主题下选中按钮使用主色
  const selectedColor = themeStyle === 'forest-light' ? '#4a7858' : undefined

  /** 切换模式：仅切换模式，不创建新会话 */
  const handleModeSwitch = React.useCallback((targetMode: AppMode): void => {
    if (targetMode === mode) return
    setMode(targetMode)
  }, [mode, setMode])

  return (
    <div className="welcome-empty-state flex h-full flex-col items-center justify-center gap-6 px-4">
      {/* 问候语 */}
      <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
        {displayName}，{greeting}
      </h1>

      {/* 模式切换 */}
      <div className="flex items-center gap-2">
        {(Object.entries(MODE_CONFIG) as [AppMode, typeof MODE_CONFIG[AppMode]][]).map(([key, config]) => {
          const isSelected = mode === key
          const modeLabel = config.label
          return (
            <button
              key={key}
              onClick={() => handleModeSwitch(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] transition-colors',
                isSelected
                  ? 'bg-foreground text-background'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              )}
              style={isSelected && selectedColor ? { backgroundColor: selectedColor, color: '#fff' } : undefined}
            >
              {config.icon}
              {modeLabel}
            </button>
          )
        })}
      </div>

      {/* Tips */}
      <div className="flex items-center gap-2.5 rounded-full bg-muted/50 px-4 py-2 text-[13px] text-muted-foreground">
        <Lightbulb size={14} className="flex-shrink-0 text-amber-500/80" />
        <span>{tip.text}</span>
      </div>
    </div>
  )
}
