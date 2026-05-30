import type { AgentEffort, ProviderType, ThinkingConfig } from '@proma/shared'

export type ClaudeProxyApiFormat = 'openai_chat' | 'openai_responses'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue
}

interface AnthropicRequestBody {
  model?: unknown
  system?: unknown
  messages?: unknown
  max_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
  stream?: unknown
  thinking?: unknown
  output_config?: unknown
  tools?: unknown
  tool_choice?: unknown
}

interface AnthropicContentBlock {
  type?: unknown
  text?: unknown
  cache_control?: unknown
  source?: unknown
  media_type?: unknown
  data?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  thinking?: unknown
}

interface OpenAIMessage {
  role: string
  content?: unknown
  cache_control?: unknown
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface AnthropicResponseMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: unknown[]
  model: string
  stop_reason: string
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface SseEmit {
  (eventName: string, data: Record<string, unknown>): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isRecord(value)) return Object.values(value).every((item) => item === undefined || isJsonValue(item))
  return false
}

function toJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) return value
  return null
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(',')}}`
}

function stripBillingHeader(text: string): string {
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n){1,2}/, '')
}

function readSystemText(system: unknown): { text: string; cacheControl?: unknown } | null {
  if (typeof system === 'string') {
    const text = stripBillingHeader(system).trim()
    return text ? { text } : null
  }

  if (!Array.isArray(system)) return null

  const parts: string[] = []
  let cacheControl: unknown
  let hasCacheControl = false
  let cacheConflict = false

  for (const item of system) {
    if (!isRecord(item)) continue
    const text = asString(item.text)
    if (!text) continue
    parts.push(stripBillingHeader(text).trim())

    if ('cache_control' in item) {
      const next = item.cache_control
      const serializedCurrent = hasCacheControl ? JSON.stringify(cacheControl) : undefined
      const serializedNext = JSON.stringify(next)
      if (hasCacheControl && serializedCurrent !== serializedNext) cacheConflict = true
      cacheControl = next
      hasCacheControl = true
    } else if (hasCacheControl) {
      cacheConflict = true
    }
  }

  const text = parts.filter(Boolean).join('\n')
  if (!text) return null
  return hasCacheControl && !cacheConflict ? { text, cacheControl } : { text }
}

function buildDataImageUrl(block: AnthropicContentBlock): string | null {
  const source = isRecord(block.source) ? block.source : block
  const mediaType = asString(source.media_type) ?? 'image/png'
  const data = asString(source.data)
  return data ? `data:${mediaType};base64,${data}` : null
}

function stringOrJson(value: unknown): string {
  if (typeof value === 'string') return value
  return canonicalJsonStringify(value)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const item of content) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        textParts.push(item.text)
      } else {
        textParts.push(stringOrJson(item))
      }
    }
    return textParts.join('\n')
  }
  return stringOrJson(content)
}

export function sanitizeAnthropicToolUseInput(toolName: string, input: unknown): unknown {
  if (toolName !== 'Read' || !isRecord(input) || input.pages !== '') return input
  const cleaned: Record<string, unknown> = { ...input }
  delete cleaned.pages
  return cleaned
}

function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!isRecord(schema)) return schema

  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'format' && value === 'uri') continue
    cleaned[key] = cleanSchema(value)
  }
  return cleaned
}

function supportsReasoningEffort(model: string): boolean {
  return /^o\d/i.test(model) || /^gpt-[5-9]/i.test(model)
}

function mapReasoningEffort(body: AnthropicRequestBody, model: string): string | undefined {
  if (!supportsReasoningEffort(model)) return undefined

  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined
  const explicitEffort = asString(outputConfig?.effort) as AgentEffort | undefined
  if (explicitEffort) {
    if (explicitEffort === 'max') return 'xhigh'
    return explicitEffort
  }

  const thinking = isRecord(body.thinking) ? body.thinking as ThinkingConfig : undefined
  if (!thinking || thinking.type === 'disabled') return undefined
  if (thinking.type === 'adaptive') return 'xhigh'
  if (thinking.type === 'enabled') {
    const budget = thinking.budgetTokens
    if (budget < 4000) return 'low'
    if (budget < 16000) return 'medium'
    return 'high'
  }
  return undefined
}

function modelUsesMaxCompletionTokens(model: string): boolean {
  return /^o\d/i.test(model)
}

function convertToolsForChat(tools: unknown): unknown[] | undefined {
  const converted = asRecordArray(tools)
    .filter((tool) => tool.type !== 'BatchTool')
    .map((tool) => ({
      type: 'function',
      function: {
        name: asString(tool.name) ?? '',
        description: asString(tool.description) ?? '',
        parameters: cleanSchema(tool.input_schema ?? {}),
      },
    }))
    .filter((tool) => tool.function.name)
  return converted.length > 0 ? converted : undefined
}

function convertToolsForResponses(tools: unknown): unknown[] | undefined {
  const converted = asRecordArray(tools)
    .filter((tool) => tool.type !== 'BatchTool')
    .map((tool) => ({
      type: 'function',
      name: asString(tool.name) ?? '',
      description: asString(tool.description) ?? '',
      parameters: cleanSchema(tool.input_schema ?? {}),
    }))
    .filter((tool) => tool.name)
  return converted.length > 0 ? converted : undefined
}

function convertToolChoiceForChat(toolChoice: unknown): unknown {
  if (toolChoice === 'auto') return 'auto'
  if (toolChoice === 'any') return 'required'
  if (toolChoice === 'none') return 'none'
  if (!isRecord(toolChoice)) return undefined
  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return undefined
}

function convertToolChoiceForResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'auto') return 'auto'
  if (toolChoice === 'any') return 'required'
  if (toolChoice === 'none') return 'none'
  if (!isRecord(toolChoice)) return undefined
  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', name: toolChoice.name }
  }
  return undefined
}

function normalizeSystemMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const systems = messages.filter((message) => message.role === 'system')
  const others = messages.filter((message) => message.role !== 'system')
  if (systems.length === 0) return others

  const text = systems.map((message) => contentToText(message.content)).filter(Boolean).join('\n')
  if (!text) return others
  return [{ role: 'system', content: text }, ...others]
}

function buildOpenAIChatContent(parts: unknown[]): unknown {
  if (parts.length === 0) return null

  const hasImage = parts.some((part) => isRecord(part) && part.type === 'image_url')
  if (!hasImage) {
    return parts
      .map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
  }

  return parts.map((part) => {
    if (isRecord(part) && part.type === 'text') {
      return { type: 'text', text: asString(part.text) ?? '' }
    }
    return part
  })
}

export function anthropicToOpenai(rawBody: Record<string, unknown>, preserveReasoningContent = false): Record<string, unknown> {
  const body = rawBody as AnthropicRequestBody
  const model = asString(body.model) ?? ''
  const messages: OpenAIMessage[] = []
  const system = readSystemText(body.system)
  if (system) {
    messages.push({
      role: 'system',
      content: system.text,
    })
  }

  for (const message of asRecordArray(body.messages)) {
    const role = asString(message.role) ?? 'user'
    if (role === 'system') {
      messages.push({ role: 'system', content: contentToText(message.content) })
      continue
    }

    if (typeof message.content === 'string' || message.content == null) {
      messages.push({
        role,
        content: message.content ?? (role === 'assistant' ? null : ''),
      })
      continue
    }

    const contentParts: unknown[] = []
    const toolCalls: OpenAIToolCall[] = []
    const thinkingParts: string[] = []

    const flushCurrentMessage = (): void => {
      if (contentParts.length === 0 && toolCalls.length === 0) return
      const content = buildOpenAIChatContent(contentParts)

      messages.push({
        role,
        content,
        ...(toolCalls.length > 0 ? { tool_calls: [...toolCalls] } : {}),
        ...(preserveReasoningContent && role === 'assistant' && toolCalls.length > 0
          ? { reasoning_content: thinkingParts.join('\n') || 'tool call' }
          : {}),
      })
      contentParts.length = 0
      toolCalls.length = 0
    }

    for (const block of asRecordArray(message.content)) {
      const contentBlock = block as AnthropicContentBlock
      switch (contentBlock.type) {
        case 'text': {
          const text = asString(contentBlock.text)
          if (text != null) {
            contentParts.push({
              type: 'text',
              text,
            })
          }
          break
        }
        case 'image': {
          const url = buildDataImageUrl(contentBlock)
          if (url) contentParts.push({ type: 'image_url', image_url: { url } })
          break
        }
        case 'tool_use': {
          const name = asString(contentBlock.name) ?? ''
          const id = asString(contentBlock.id) ?? `tool_${toolCalls.length}`
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments: canonicalJsonStringify(sanitizeAnthropicToolUseInput(name, contentBlock.input ?? {})),
            },
          })
          break
        }
        case 'tool_result': {
          flushCurrentMessage()
          messages.push({
            role: 'tool',
            tool_call_id: asString(contentBlock.tool_use_id) ?? '',
            content: stringOrJson(contentBlock.content ?? ''),
          })
          break
        }
        case 'thinking': {
          const text = asString(contentBlock.thinking) ?? asString(contentBlock.text)
          if (text) thinkingParts.push(text)
          break
        }
      }
    }
    flushCurrentMessage()
  }

  const result: Record<string, unknown> = {
    model,
    messages: normalizeSystemMessages(messages),
    stream: body.stream === true,
  }

  if (typeof body.max_tokens === 'number') {
    result[modelUsesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens'] = body.max_tokens
  }
  if (typeof body.temperature === 'number') result.temperature = body.temperature
  if (typeof body.top_p === 'number') result.top_p = body.top_p
  if (body.stop_sequences) result.stop = body.stop_sequences

  const reasoningEffort = mapReasoningEffort(body, model)
  if (reasoningEffort) result.reasoning_effort = reasoningEffort

  const tools = convertToolsForChat(body.tools)
  if (tools) result.tools = tools

  const toolChoice = convertToolChoiceForChat(body.tool_choice)
  if (toolChoice) result.tool_choice = toolChoice

  return result
}

export function anthropicToResponses(rawBody: Record<string, unknown>): Record<string, unknown> {
  const body = rawBody as AnthropicRequestBody
  const model = asString(body.model) ?? ''
  const input: unknown[] = []
  const system = readSystemText(body.system)

  for (const message of asRecordArray(body.messages)) {
    const role = asString(message.role) ?? 'user'

    if (typeof message.content === 'string' || message.content == null) {
      input.push({
        role,
        content: [{
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content ?? '',
        }],
      })
      continue
    }

    const parts: unknown[] = []
    const flushParts = (): void => {
      if (parts.length === 0) return
      input.push({ role, content: [...parts] })
      parts.length = 0
    }

    for (const block of asRecordArray(message.content)) {
      const contentBlock = block as AnthropicContentBlock
      switch (contentBlock.type) {
        case 'text':
          parts.push({
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: asString(contentBlock.text) ?? '',
          })
          break
        case 'image': {
          const url = buildDataImageUrl(contentBlock)
          if (url) parts.push({ type: 'input_image', image_url: url })
          break
        }
        case 'tool_use': {
          flushParts()
          const name = asString(contentBlock.name) ?? ''
          input.push({
            type: 'function_call',
            call_id: asString(contentBlock.id) ?? '',
            name,
            arguments: canonicalJsonStringify(sanitizeAnthropicToolUseInput(name, contentBlock.input ?? {})),
          })
          break
        }
        case 'tool_result':
          flushParts()
          input.push({
            type: 'function_call_output',
            call_id: asString(contentBlock.tool_use_id) ?? '',
            output: stringOrJson(contentBlock.content ?? ''),
          })
          break
      }
    }
    flushParts()
  }

  const result: Record<string, unknown> = {
    model,
    input,
    instructions: system?.text ?? '',
    stream: body.stream === true,
  }

  if (typeof body.max_tokens === 'number') result.max_output_tokens = body.max_tokens
  if (typeof body.temperature === 'number') result.temperature = body.temperature
  if (typeof body.top_p === 'number') result.top_p = body.top_p

  const reasoningEffort = mapReasoningEffort(body, model)
  if (reasoningEffort) result.reasoning = { effort: reasoningEffort }

  const tools = convertToolsForResponses(body.tools)
  if (tools) result.tools = tools

  const toolChoice = convertToolChoiceForResponses(body.tool_choice)
  if (toolChoice) result.tool_choice = toolChoice

  return result
}

function parseArguments(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

function mapFinishReason(reason: unknown): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  return 'end_turn'
}

function mapUsage(usage: unknown): AnthropicResponseMessage['usage'] {
  const usageRecord = isRecord(usage) ? usage : {}
  const promptDetails = isRecord(usageRecord.prompt_tokens_details) ? usageRecord.prompt_tokens_details : {}
  const inputDetails = isRecord(usageRecord.input_tokens_details) ? usageRecord.input_tokens_details : {}
  const result: AnthropicResponseMessage['usage'] = {
    input_tokens: asNumber(usageRecord.input_tokens) ?? asNumber(usageRecord.prompt_tokens) ?? 0,
    output_tokens: asNumber(usageRecord.output_tokens) ?? asNumber(usageRecord.completion_tokens) ?? 0,
  }

  const cacheRead =
    asNumber(inputDetails.cached_tokens) ??
    asNumber(promptDetails.cached_tokens) ??
    asNumber(usageRecord.cache_read_input_tokens)
  if (cacheRead != null) result.cache_read_input_tokens = cacheRead

  const cacheCreated = asNumber(usageRecord.cache_creation_input_tokens)
  if (cacheCreated != null) result.cache_creation_input_tokens = cacheCreated

  return result
}

export function openaiToAnthropic(body: Record<string, unknown>): AnthropicResponseMessage {
  const choice = asRecordArray(body.choices)[0] ?? {}
  const message = isRecord(choice.message) ? choice.message : {}
  const content: unknown[] = []

  const reasoning = asString(message.reasoning_content)
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning })

  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue
      const text = asString(part.text) ?? asString(part.output_text) ?? asString(part.refusal)
      if (text) content.push({ type: 'text', text })
    }
  }

  const refusal = asString(message.refusal)
  if (refusal) content.push({ type: 'text', text: refusal })

  const toolCalls = asRecordArray(message.tool_calls)
  for (const toolCall of toolCalls) {
    const fn = isRecord(toolCall.function) ? toolCall.function : {}
    const name = asString(fn.name) ?? ''
    content.push({
      type: 'tool_use',
      id: asString(toolCall.id) ?? '',
      name,
      input: sanitizeAnthropicToolUseInput(name, parseArguments(fn.arguments)),
    })
  }

  if (toolCalls.length === 0 && isRecord(message.function_call)) {
    const fn = message.function_call
    const name = asString(fn.name) ?? ''
    content.push({
      type: 'tool_use',
      id: 'function_call',
      name,
      input: sanitizeAnthropicToolUseInput(name, parseArguments(fn.arguments)),
    })
  }

  const hasToolUse = content.some((part) => isRecord(part) && part.type === 'tool_use')
  const stopReason = hasToolUse ? 'tool_use' : mapFinishReason(choice.finish_reason)

  return {
    id: asString(body.id) ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: asString(body.model) ?? '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(body.usage),
  }
}

export function responsesToAnthropic(body: Record<string, unknown>): AnthropicResponseMessage {
  const content: unknown[] = []
  for (const item of asRecordArray(body.output)) {
    if (item.type === 'message') {
      for (const part of asRecordArray(item.content)) {
        const text = asString(part.text) ?? asString(part.output_text) ?? asString(part.refusal)
        if (text) content.push({ type: 'text', text })
      }
    } else if (item.type === 'function_call') {
      const name = asString(item.name) ?? ''
      content.push({
        type: 'tool_use',
        id: asString(item.call_id) ?? asString(item.id) ?? '',
        name,
        input: sanitizeAnthropicToolUseInput(name, parseArguments(item.arguments)),
      })
    } else if (item.type === 'reasoning') {
      const summaries = asRecordArray(item.summary)
        .filter((summary) => summary.type === 'summary_text')
        .map((summary) => asString(summary.text))
        .filter((text): text is string => Boolean(text))
      if (summaries.length > 0) content.push({ type: 'thinking', thinking: summaries.join('\n') })
    }
  }

  const hasToolUse = content.some((part) => isRecord(part) && part.type === 'tool_use')
  const incompleteReason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : undefined
  const stopReason = body.status === 'completed' && hasToolUse
    ? 'tool_use'
    : body.status === 'incomplete' && (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens' || incompleteReason == null)
      ? 'max_tokens'
      : 'end_turn'

  return {
    id: asString(body.id) ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: asString(body.model) ?? '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(body.usage),
  }
}

function encodeAnthropicUsage(usage: unknown): Record<string, number> {
  const mapped = mapUsage(usage)
  const result: Record<string, number> = {
    input_tokens: mapped.input_tokens,
    output_tokens: mapped.output_tokens,
  }
  if (mapped.cache_read_input_tokens != null) result.cache_read_input_tokens = mapped.cache_read_input_tokens
  if (mapped.cache_creation_input_tokens != null) result.cache_creation_input_tokens = mapped.cache_creation_input_tokens
  return result
}

async function forEachSseBlock(stream: ReadableStream<Uint8Array>, onBlock: (eventName: string | undefined, dataLines: string[]) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let delimiterIndex = buffer.search(/\r?\n\r?\n/)
      while (delimiterIndex >= 0) {
        const block = buffer.slice(0, delimiterIndex)
        buffer = buffer.slice(buffer[delimiterIndex] === '\r' ? delimiterIndex + 4 : delimiterIndex + 2)
        let eventName: string | undefined
        const dataLines: string[] = []
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        onBlock(eventName, dataLines)
        delimiterIndex = buffer.search(/\r?\n\r?\n/)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function transformOpenAIChatSseToAnthropic(
  stream: ReadableStream<Uint8Array>,
  fallbackModel: string,
  emit: SseEmit,
): Promise<void> {
  let messageStarted = false
  let messageId = `msg_${Date.now()}`
  let model = fallbackModel
  let nextIndex = 0
  let openNonTool: { type: 'text' | 'thinking'; index: number } | null = null
  const openToolIndexes = new Set<number>()
  const toolBlocks = new Map<number, { anthropicIndex: number; id: string; name: string; pendingArgs: string }>()
  let pendingStopReason = 'end_turn'
  let pendingUsage: Record<string, number> = { input_tokens: 0, output_tokens: 0 }

  const ensureMessageStart = (chunk?: Record<string, unknown>): void => {
    if (messageStarted) return
    messageId = asString(chunk?.id) ?? messageId
    model = asString(chunk?.model) ?? model
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    messageStarted = true
  }

  const closeNonTool = (): void => {
    if (!openNonTool) return
    emit('content_block_stop', { type: 'content_block_stop', index: openNonTool.index })
    openNonTool = null
  }

  const appendNonTool = (type: 'text' | 'thinking', text: string): void => {
    if (!text) return
    if (!openNonTool || openNonTool.type !== type) {
      closeNonTool()
      const index = nextIndex++
      openNonTool = { type, index }
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      })
    }
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: openNonTool.index,
      delta: type === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text },
    })
  }

  const closeToolBlocks = (): void => {
    for (const index of openToolIndexes) {
      emit('content_block_stop', { type: 'content_block_stop', index })
    }
    openToolIndexes.clear()
  }

  await forEachSseBlock(stream, (_eventName, dataLines) => {
    const data = dataLines.join('\n')
    if (!data) return
    if (data === '[DONE]') {
      ensureMessageStart()
      closeNonTool()
      closeToolBlocks()
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: pendingStopReason, stop_sequence: null },
        usage: pendingUsage,
      })
      emit('message_stop', { type: 'message_stop' })
      return
    }

    let chunk: Record<string, unknown>
    try {
      const parsed = JSON.parse(data) as unknown
      if (!isRecord(parsed)) return
      chunk = parsed
    } catch {
      return
    }

    ensureMessageStart(chunk)
    if (chunk.usage) pendingUsage = encodeAnthropicUsage(chunk.usage)

    const choice = asRecordArray(chunk.choices)[0]
    if (!choice) return
    if (choice.finish_reason) pendingStopReason = mapFinishReason(choice.finish_reason)
    const delta = isRecord(choice.delta) ? choice.delta : {}

    appendNonTool('thinking', asString(delta.reasoning_content) ?? asString(delta.reasoning) ?? '')
    appendNonTool('text', asString(delta.content) ?? '')

    for (const toolCall of asRecordArray(delta.tool_calls)) {
      closeNonTool()
      const openaiIndex = asNumber(toolCall.index) ?? 0
      const fn = isRecord(toolCall.function) ? toolCall.function : {}
      const existing = toolBlocks.get(openaiIndex)
      const id = asString(toolCall.id) ?? existing?.id ?? `call_${openaiIndex}`
      const name = asString(fn.name) ?? existing?.name ?? ''
      const argsDelta = asString(fn.arguments) ?? ''
      const block = existing ?? { anthropicIndex: nextIndex++, id, name, pendingArgs: '' }
      block.pendingArgs += argsDelta
      block.id = id
      block.name = name || block.name
      toolBlocks.set(openaiIndex, block)

      if (!openToolIndexes.has(block.anthropicIndex) && block.name) {
        emit('content_block_start', {
          type: 'content_block_start',
          index: block.anthropicIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })
        openToolIndexes.add(block.anthropicIndex)
      }

      if (argsDelta && openToolIndexes.has(block.anthropicIndex)) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: block.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: argsDelta },
        })
      }
    }
  })
}

export async function transformResponsesSseToAnthropic(
  stream: ReadableStream<Uint8Array>,
  fallbackModel: string,
  emit: SseEmit,
): Promise<void> {
  let messageStarted = false
  let messageId = `msg_${Date.now()}`
  let model = fallbackModel
  let nextIndex = 0
  const indexByKey = new Map<string, number>()
  const openIndexes = new Set<number>()
  let hasToolUse = false

  const ensureMessageStart = (response?: Record<string, unknown>): void => {
    if (messageStarted) return
    messageId = asString(response?.id) ?? messageId
    model = asString(response?.model) ?? model
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    messageStarted = true
  }

  const getIndex = (key: string): number => {
    const existing = indexByKey.get(key)
    if (existing != null) return existing
    const next = nextIndex++
    indexByKey.set(key, next)
    return next
  }

  await forEachSseBlock(stream, (eventName, dataLines) => {
    const data = dataLines.join('\n')
    if (!data || data === '[DONE]') return

    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(data) as unknown
      if (!isRecord(parsed)) return
      payload = parsed
    } catch {
      return
    }

    const response = isRecord(payload.response) ? payload.response : undefined
    ensureMessageStart(response)

    if (eventName === 'response.output_item.added' && isRecord(payload.item) && payload.item.type === 'function_call') {
      const item = payload.item
      const itemId = asString(item.id) ?? asString(item.call_id) ?? `tool_${nextIndex}`
      const index = getIndex(itemId)
      hasToolUse = true
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: asString(item.call_id) ?? itemId,
          name: asString(item.name) ?? '',
          input: {},
        },
      })
      openIndexes.add(index)
      return
    }

    if (eventName === 'response.content_part.added') {
      const itemId = asString(payload.item_id) ?? 'text'
      const contentIndex = asNumber(payload.content_index) ?? 0
      const index = getIndex(`${itemId}:${contentIndex}`)
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      openIndexes.add(index)
      return
    }

    if (eventName === 'response.reasoning_summary_part.added') {
      const itemId = asString(payload.item_id) ?? 'thinking'
      const index = getIndex(`${itemId}:thinking`)
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
      openIndexes.add(index)
      return
    }

    if (eventName === 'response.output_text.delta') {
      const itemId = asString(payload.item_id) ?? 'text'
      const contentIndex = asNumber(payload.content_index) ?? 0
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: getIndex(`${itemId}:${contentIndex}`),
        delta: { type: 'text_delta', text: asString(payload.delta) ?? '' },
      })
      return
    }

    if (eventName === 'response.reasoning_summary_text.delta') {
      const itemId = asString(payload.item_id) ?? 'thinking'
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: getIndex(`${itemId}:thinking`),
        delta: { type: 'thinking_delta', thinking: asString(payload.delta) ?? '' },
      })
      return
    }

    if (eventName === 'response.function_call_arguments.delta') {
      const itemId = asString(payload.item_id) ?? asString(payload.output_index) ?? 'tool'
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: getIndex(itemId),
        delta: { type: 'input_json_delta', partial_json: asString(payload.delta) ?? '' },
      })
      return
    }

    if (eventName === 'response.content_part.done' || eventName === 'response.reasoning_summary_part.done' || eventName === 'response.output_item.done') {
      const itemId = asString(payload.item_id) ?? 'text'
      const contentIndex = asNumber(payload.content_index)
      const key = eventName === 'response.reasoning_summary_part.done'
        ? `${itemId}:thinking`
        : contentIndex != null ? `${itemId}:${contentIndex}` : itemId
      const index = indexByKey.get(key)
      if (index != null && openIndexes.has(index)) {
        emit('content_block_stop', { type: 'content_block_stop', index })
        openIndexes.delete(index)
      }
      return
    }

    if (eventName === 'response.completed') {
      for (const index of openIndexes) {
        emit('content_block_stop', { type: 'content_block_stop', index })
      }
      openIndexes.clear()
      const responseRecord = response ?? {}
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: encodeAnthropicUsage(responseRecord.usage),
      })
      emit('message_stop', { type: 'message_stop' })
    }
  })
}

export function getClaudeApiFormat(provider: ProviderType): ClaudeProxyApiFormat | 'anthropic' {
  switch (provider) {
    case 'openai':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'custom':
      return 'openai_chat'
    default:
      return 'anthropic'
  }
}
