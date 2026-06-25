/**
 * MiniChatApp — Mini Chat 窗口根组件
 *
 * 当 URL 含 ?window=mini-chat 时渲染此组件（替代主 App）。
 * 轻量浮窗，支持消息历史展示、流式回复、模型/思考/工具选择、附件上传、截图。
 * 对话独立于主窗口，可一键"展开"到主窗口。
 *
 * 消息展示复用主窗口的 ChatMessages 组件（含 ChatToolActivityIndicator、
 * 推理折叠、流式平滑、滚动控制等完整功能）。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { CornerDownLeft, Square, Brain, Paperclip, Scissors, Expand, MessageSquarePlus, X, History } from 'lucide-react'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { ToolSelectorPopover } from '@/components/chat/ToolSelectorPopover'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'
import { ChatMessages } from '@/components/chat/ChatMessages'
import type { InlineEditSubmitPayload } from '@/components/chat/ChatMessageItem'
import { ConversationProvider } from '@/contexts/session-context'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { fileToBase64 } from '@/lib/file-utils'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'
import { toast } from 'sonner'
import type {
  ChatMessage,
  ConversationMeta,
  StreamChunkEvent,
  StreamReasoningEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamToolActivityEvent,
  ChatToolActivity,
} from '@proma/shared'

/** 待上传附件（仅在 Mini Chat 窗口内使用） */
interface MiniAttachment {
  id: string
  filename: string
  mediaType: string
  base64?: string
  sourcePath?: string
  size: number
  previewUrl?: string
}

/** 模型选择信息（用于展示） */
interface ModelInfo {
  channelId: string
  modelId: string
}

export function MiniChatApp(): React.ReactElement {
  // ===== 对话状态 =====
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [streamingModel, setStreamingModel] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number>(Date.now())
  const [toolActivities, setToolActivities] = useState<ChatToolActivity[]>([])
  const [messagesLoaded, setMessagesLoaded] = useState(false)
  const [inlineEditingMessageId, setInlineEditingMessageId] = useState<string | null>(null)

  // ===== 历史对话导航 =====
  const [allConversations, setAllConversations] = useState<ConversationMeta[]>([])
  const [historyPopoverOpen, setHistoryPopoverOpen] = useState(false)

  // ===== 输入状态 =====
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<MiniAttachment[]>([])
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 设置透明背景
  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
  }, [])

  // 加载默认模型信息
  const loadModelInfo = useCallback(async () => {
    try {
      const raw = localStorage.getItem('proma-selected-model')
      if (raw) {
        const selected = JSON.parse(raw) as { channelId: string; modelId: string }
        setModelInfo(selected)
      }
    } catch {
      setModelInfo(null)
    }
  }, [])

  // 加载所有历史对话列表
  const loadAllConversations = useCallback(async () => {
    try {
      const list = await window.electronAPI.listConversations()
      setAllConversations(list)
    } catch (err) {
      console.error('[MiniChat] 加载历史对话列表失败:', err)
    }
  }, [])

  // 切换到指定历史对话
  const switchToConversation = useCallback(async (targetId: string) => {
    if (targetId === conversationId) {
      setHistoryPopoverOpen(false)
      return
    }
    try {
      setHistoryPopoverOpen(false)
      setConversationId(targetId)
      setMessages([])
      setMessagesLoaded(false)
      setStreamingContent('')
      setStreamingReasoning('')
      setIsStreaming(false)
    } catch (err) {
      console.error('[MiniChat] 切换对话失败:', err)
    }
  }, [conversationId])

  // 创建或加载对话
  const initConversation = useCallback(async () => {
    try {
      const id = await window.electronAPI.newMiniChatConversation()
      setConversationId(id)
      setMessages([])
      setMessagesLoaded(true)
    } catch (err) {
      console.error('[MiniChat] 创建对话失败:', err)
    }
  }, [])

  // 加载消息
  const loadMessages = useCallback(async (convId: string) => {
    try {
      const result = await window.electronAPI.getRecentMessages(convId, 50)
      setMessages(result.messages)
      setMessagesLoaded(true)
    } catch (err) {
      console.error('[MiniChat] 加载消息失败:', err)
    }
  }, [])

  // 聚焦输入框
  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [])

  // 监听主进程的聚焦通知
  useEffect(() => {
    const cleanup = window.electronAPI.onMiniChatFocus(() => {
      focusInput()
      loadModelInfo()
    })
    return cleanup
  }, [focusInput, loadModelInfo])

  // 初始化对话 + 加载历史对话列表
  useEffect(() => {
    initConversation()
    loadAllConversations()
  }, [initConversation, loadAllConversations])

  // 自动调整 textarea 高度
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

  // 全局键盘事件：Escape 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.electronAPI.hideMiniChat()
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // conversationId 变化时重新加载消息（切换历史对话后触发）
  useEffect(() => {
    if (!conversationId || messagesLoaded) return
    loadMessages(conversationId)
  }, [conversationId, messagesLoaded, loadMessages])

  // 设置流式 IPC 监听
  useEffect(() => {
    if (!conversationId) return

    const cleanupChunk = window.electronAPI.onStreamChunk(
      (event: StreamChunkEvent) => {
        if (event.conversationId !== conversationId) return
        setIsStreaming(true)
        setStreamingContent((prev) => prev + event.delta)
      }
    )

    const cleanupReasoning = window.electronAPI.onStreamReasoning?.(
      (event: StreamReasoningEvent) => {
        if (event.conversationId !== conversationId) return
        setStreamingReasoning((prev) => prev + event.delta)
      }
    )

    const cleanupToolActivity = window.electronAPI.onStreamToolActivity(
      (event: StreamToolActivityEvent) => {
        if (event.conversationId !== conversationId) return
        setToolActivities((prev) => [...prev, event.activity])
      }
    )

    const cleanupComplete = window.electronAPI.onStreamComplete(
      (event: StreamCompleteEvent) => {
        if (event.conversationId !== conversationId) return
        setIsStreaming(false)
        setStreamingContent('')
        setStreamingReasoning('')
        setToolActivities([])
        // 重新加载消息
        loadMessages(conversationId)
      }
    )

    const cleanupError = window.electronAPI.onStreamError(
      (event: StreamErrorEvent) => {
        if (event.conversationId !== conversationId) return
        setIsStreaming(false)
        toast.error(`回复错误: ${event.error}`)
      }
    )

    return () => {
      cleanupChunk()
      cleanupReasoning?.()
      cleanupToolActivity?.()
      cleanupComplete()
      cleanupError()
    }
  }, [conversationId, loadMessages])

  // 添加文件为附件
  const addFiles = useCallback(async (files: File[]) => {
    const newAttachments: MiniAttachment[] = []

    for (const file of files) {
      try {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          toast.error(`文件过大: ${file.name}`)
          continue
        }
        const base64 = await fileToBase64(file)
        const previewUrl = file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined
        newAttachments.push({
          id: crypto.randomUUID(),
          filename: file.name,
          mediaType: file.type || 'application/octet-stream',
          base64,
          size: file.size,
          previewUrl,
        })
      } catch (err) {
        console.error('[MiniChat] 添加附件失败:', err)
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments])
    }
  }, [])

  // 移除附件
  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id)
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  // 粘贴事件
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // 打开文件选择对话框
  const handleOpenFileDialog = useCallback(async () => {
    try {
      const result = await window.electronAPI.openFileDialog()
      if (result.files.length === 0) return

      for (const fileInfo of result.files) {
        if (fileInfo.size > MAX_ATTACHMENT_SIZE) {
          toast.error(`文件过大: ${fileInfo.filename}`)
          continue
        }
        const previewUrl = fileInfo.mediaType.startsWith('image/')
          ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
          : undefined

        setAttachments((prev) => [...prev, {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: fileInfo.filename,
          mediaType: fileInfo.mediaType,
          base64: fileInfo.data,
          size: fileInfo.size,
          previewUrl,
        }])
      }
    } catch (err) {
      console.error('[MiniChat] 文件选择对话框失败:', err)
    }
  }, [])

  // 系统截图
  const handleScreenshot = useCallback(async () => {
    try {
      const result = await window.electronAPI.systemScreenshot()
      if (result.success && result.base64) {
        const base64 = result.base64
        const previewUrl = `data:image/png;base64,${base64}`
        const name = `截图_${Date.now()}.png`
        const id = `screenshot-${Date.now()}`
        // 估算实际字节数（base64 长度 * 3/4）
        const size = Math.floor((base64.length * 3) / 4)
        setAttachments((prev) => [...prev, {
          id,
          filename: name,
          mediaType: 'image/png',
          base64,
          size,
          previewUrl,
        }])
      } else {
        toast.error(result.error || '截图失败')
      }
    } catch (err) {
      console.error('[MiniChat] 截图失败:', err)
      toast.error('截图失败')
    }
  }, [])

  // 发送消息
  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || isStreaming || !conversationId) return
    if (!modelInfo) {
      toast.error('请先选择模型')
      return
    }

    const currentConvId = conversationId
    setText('')

    // 添加用户消息到本地显示
    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      attachments: attachments.length > 0
        ? attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            mediaType: a.mediaType,
            localPath: a.sourcePath || '',
            size: a.size,
          }))
        : undefined,
    }
    setMessages((prev) => [...prev, userMsg])
    setAttachments([])

    setIsStreaming(true)
    setStreamingContent('')
    setStreamingReasoning('')
    setToolActivities([])
    setStreamingModel(modelInfo.modelId)
    setStartedAt(Date.now())

    try {
      // 不 await，让流式监听器处理后续（onStreamComplete 会 reload 消息）
      window.electronAPI.submitMiniChat({
        text: trimmed,
        conversationId: currentConvId,
        channelId: modelInfo.channelId,
        modelId: modelInfo.modelId,
        thinkingEnabled,
        files: attachments.map(({ filename, mediaType, base64, sourcePath, size }) => ({
          filename, mediaType, base64, sourcePath, size,
        })),
      }).catch((err) => {
        console.error('[MiniChat] 发送失败:', err)
        setIsStreaming(false)
        toast.error('发送失败')
      })
    } catch (err) {
      console.error('[MiniChat] 发送失败:', err)
      setIsStreaming(false)
      toast.error('发送失败')
    }
  }, [text, attachments, isStreaming, conversationId, modelInfo, thinkingEnabled])

  // 新对话
  const handleNewConversation = useCallback(async () => {
    try {
      setMessages([])
      setStreamingContent('')
      setStreamingReasoning('')
      setIsStreaming(false)
      setMessagesLoaded(false)
      setAttachments([])
      await initConversation()
      focusInput()
    } catch (err) {
      console.error('[MiniChat] 新对话失败:', err)
    }
  }, [initConversation, focusInput])

  // 展开到主窗口
  const handleExpand = useCallback(async () => {
    if (!conversationId) return
    try {
      await window.electronAPI.expandMiniChat({
        conversationId,
        title: 'Mini Chat',
      })
      await window.electronAPI.hideMiniChat()
    } catch (err) {
      console.error('[MiniChat] 展开失败:', err)
    }
  }, [conversationId])

  // Enter 发送，Shift+Enter 换行
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])
  

  // ===== 消息操作回调（与 ChatView 对齐） =====

  /** 删除消息 */
  const handleDeleteMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!conversationId) return
    try {
      const updatedMessages = await window.electronAPI.deleteMessage(conversationId, messageId)
      setMessages(updatedMessages)
      if (inlineEditingMessageId === messageId) {
        setInlineEditingMessageId(null)
      }
    } catch (err) {
      console.error('[MiniChat] 删除消息失败:', err)
    }
  }, [conversationId, inlineEditingMessageId])

  /** 重新发送：从该用户消息分叉后重发 */
  const handleResendMessage = useCallback(async (message: { id: string; content: string }): Promise<void> => {
    if (isStreaming || !conversationId || !modelInfo) return
    try {
      const updatedMessages = await window.electronAPI.truncateMessagesFrom(conversationId, message.id, true)
      setMessages(updatedMessages)

      setIsStreaming(true)
      setStreamingContent('')
      setStreamingReasoning('')
      setToolActivities([])
      setStreamingModel(modelInfo.modelId)
      setStartedAt(Date.now())

      // 不 await submitMiniChat，让流式监听器处理后续
      window.electronAPI.submitMiniChat({
        text: message.content,
        conversationId,
        channelId: modelInfo.channelId,
        modelId: modelInfo.modelId,
        thinkingEnabled,
        files: [],
      }).catch((err) => {
        console.error('[MiniChat] 重新发送失败:', err)
        setIsStreaming(false)
      })
    } catch (err) {
      console.error('[MiniChat] 重新发送截断失败:', err)
    }
  }, [isStreaming, conversationId, modelInfo, thinkingEnabled])

  /** 开始原地编辑 */
  const handleStartInlineEdit = useCallback((message: { id: string }): void => {
    if (isStreaming) return
    setInlineEditingMessageId(message.id)
  }, [isStreaming])

  /** 取消原地编辑 */
  const handleCancelInlineEdit = useCallback((): void => {
    setInlineEditingMessageId(null)
  }, [])

  /** 提交原地编辑并重发 */
  const handleSubmitInlineEdit = useCallback(async (
    message: { id: string; content: string },
    payload: InlineEditSubmitPayload,
  ): Promise<void> => {
    if (isStreaming || !conversationId || !modelInfo) return
    const trimmed = payload.content.trim()
    if (!trimmed && payload.keepExistingAttachments.length === 0 && payload.newAttachments.length === 0) return

    try {
      // 截断该消息及后续
      await window.electronAPI.truncateMessagesFrom(conversationId, message.id, true)
      setInlineEditingMessageId(null)

      // 构造附件
      const files: { filename: string; mediaType: string; base64?: string; size: number }[] = []
      for (const newAttachment of payload.newAttachments) {
        files.push({
          filename: newAttachment.filename,
          mediaType: newAttachment.mediaType,
          base64: newAttachment.data,
          size: 0,
        })
      }

      setIsStreaming(true)
      setStreamingContent('')
      setStreamingReasoning('')
      setToolActivities([])
      setStreamingModel(modelInfo.modelId)
      setStartedAt(Date.now())

      // 不 await submitMiniChat，让流式监听器处理后续
      window.electronAPI.submitMiniChat({
        text: trimmed,
        conversationId,
        channelId: modelInfo.channelId,
        modelId: modelInfo.modelId,
        thinkingEnabled,
        files,
      }).catch((err) => {
        console.error('[MiniChat] 原地编辑重发失败:', err)
        setIsStreaming(false)
      })
    } catch (err) {
      console.error('[MiniChat] 原地编辑截断失败:', err)
      setInlineEditingMessageId(null)
    }
  }, [isStreaming, conversationId, modelInfo, thinkingEnabled])

  // 在流式完成时清理编辑状态
  // 在 onStreamComplete 监听中已处理

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !isStreaming && modelInfo !== null

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col">
        {/* 不透明卡片容器 — 窗口透明，但内容需有实色背景 */}
        <div className="flex flex-col h-full mx-2 my-2 rounded-2xl border border-border bg-background overflow-hidden">

          {/* ===== 顶部栏（可拖动区域） ===== */}
          <div className="flex items-center justify-between px-4 py-3 shrink-0 border-b border-border/50 titlebar-drag-region">
            <div className="flex items-center gap-1 titlebar-no-drag">
              {/* 关闭按钮 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => window.electronAPI.hideMiniChat()}
                    className="p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded-md hover:bg-muted/50 titlebar-no-drag"
                  >
                    <X className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>关闭（Esc）</p>
                </TooltipContent>
              </Tooltip>

              {/* 历史对话切换 */}
              <Popover open={historyPopoverOpen} onOpenChange={setHistoryPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded-md hover:bg-muted/50 titlebar-no-drag"
                  >
                    <History className="size-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="start" className="w-64 p-1.5">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/30 mb-1">
                    <span className="text-xs font-medium text-muted-foreground">历史对话</span>
                    <span className="text-[10px] text-muted-foreground/50">{allConversations.length}</span>
                  </div>
                  <ScrollArea className="max-h-[300px]">
                    {allConversations.length === 0 ? (
                      <p className="text-xs text-muted-foreground/50 text-center py-4">暂无历史对话</p>
                    ) : (
                      <div className="space-y-0.5">
                        {allConversations.map((conv) => (
                          <button
                            key={conv.id}
                            type="button"
                            onClick={() => switchToConversation(conv.id)}
                            className={cn(
                              'w-full text-left px-2 py-2 rounded-md text-xs transition-colors',
                              conv.id === conversationId
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                            )}
                          >
                            <div className="truncate">{conv.title}</div>
                            <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                              {new Date(conv.updatedAt).toLocaleDateString('zh-CN', {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex items-center gap-1 titlebar-no-drag">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleExpand}
                    className="p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded-md hover:bg-muted/50 titlebar-no-drag"
                  >
                    <Expand className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>在主窗口打开</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleNewConversation}
                    className="p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors rounded-md hover:bg-muted/50 titlebar-no-drag"
                  >
                    <MessageSquarePlus className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>新对话</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* ===== 对话内容区域（复用 ChatMessages） ===== */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {conversationId && (
              <ConversationProvider conversationId={conversationId}>
                <ChatMessages
                  conversationId={conversationId}
                  messages={messages}
                  messagesLoaded={messagesLoaded}
                  streaming={isStreaming}
                  streamingContent={isStreaming ? streamingContent : ''}
                  streamingReasoning={isStreaming ? streamingReasoning : ''}
                  streamingModel={isStreaming ? streamingModel : null}
                  startedAt={startedAt}
                  toolActivities={toolActivities}
                  contextDividers={[]}
                  hasMore={false}
                  onDeleteMessage={handleDeleteMessage}
                  onResendMessage={handleResendMessage}
                  onStartInlineEdit={handleStartInlineEdit}
                  onSubmitInlineEdit={handleSubmitInlineEdit}
                  onCancelInlineEdit={handleCancelInlineEdit}
                  inlineEditingMessageId={inlineEditingMessageId}
                />
              </ConversationProvider>
            )}
          </div>

          {/* ===== 底部输入区域 ===== */}
          <div className="shrink-0 px-3 pb-3 pt-1">
            {/* 附件预览 */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {attachments.map((att) => (
                  <AttachmentPreviewItem
                    key={att.id}
                    filename={att.filename}
                    mediaType={att.mediaType}
                    previewUrl={att.previewUrl}
                    onRemove={() => removeAttachment(att.id)}
                  />
                ))}
              </div>
            )}

            {/* 输入框卡片 */}
            <div
              className={cn(
                'rounded-[17px] border-[0.5px] border-border bg-muted/30 backdrop-blur-sm transition-all duration-200',
                'focus-within:border-foreground/20'
              )}
            >
              {/* 文本输入 */}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="想说点什么"
                rows={1}
                className="w-full bg-transparent resize-none outline-none px-3.5 pt-3.5 pb-1.5 text-sm placeholder:text-muted-foreground/40"
                style={{ maxHeight: 120 }}
              />

              {/* Footer 工具栏 */}
              <div className="flex items-center justify-between px-2 pb-2">
                {/* 左侧操作区 */}
                <div className="flex items-center gap-0.5">
                  {/* 模型选择 */}
                  <ModelSelector
                    externalSelectedModel={modelInfo}
                    onModelSelect={(option) => {
                      setModelInfo({ channelId: option.channelId, modelId: option.modelId })
                      localStorage.setItem('proma-selected-model', JSON.stringify({
                        channelId: option.channelId,
                        modelId: option.modelId,
                      }))
                    }}
                  />

                  {/* 思考模式 */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'p-1.5 rounded-full transition-colors',
                          thinkingEnabled ? 'text-green-500' : 'text-foreground/60 hover:text-foreground'
                        )}
                        onClick={() => setThinkingEnabled(!thinkingEnabled)}
                      >
                        <Brain className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>{thinkingEnabled ? '关闭思考模式' : '开启思考模式'}</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* 工具选择 */}
                  <ToolSelectorPopover />
                </div>

                {/* 右侧操作区 */}
                <div className="flex items-center gap-0.5">
                  {/* 截图按钮 */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleScreenshot}
                        className="p-1.5 rounded-full text-foreground/60 hover:text-foreground transition-colors"
                      >
                        <Scissors className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>截图</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* 附件按钮 */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleOpenFileDialog}
                        className="p-1.5 rounded-full text-foreground/60 hover:text-foreground transition-colors"
                      >
                        <Paperclip className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>添加附件</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* 发送/停止按钮 */}
                  {isStreaming ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => {
                            if (conversationId) {
                              window.electronAPI.stopGeneration(conversationId).catch(() => {})
                            }
                          }}
                          className="p-1.5 rounded-full text-destructive hover:text-destructive/80 transition-colors"
                        >
                          <Square className="size-4" fill="currentColor" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>停止</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={!canSend}
                          className={cn(
                            'p-1.5 rounded-full transition-colors',
                            canSend
                              ? 'text-primary hover:bg-primary/10'
                              : 'text-foreground/30 cursor-not-allowed'
                          )}
                        >
                          <CornerDownLeft className="size-[18px]" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>发送</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* 隐藏的文件选择输入 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) addFiles(files)
            e.target.value = ''
          }}
        />
      </div>
    </TooltipProvider>
  )
}
