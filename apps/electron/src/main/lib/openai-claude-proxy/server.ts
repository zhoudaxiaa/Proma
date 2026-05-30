import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ProviderType } from '@proma/shared'
import { normalizeBaseUrl } from '@proma/core'
import { getFetchFn } from '../proxy-fetch'
import {
  anthropicToOpenai,
  anthropicToResponses,
  openaiToAnthropic,
  responsesToAnthropic,
  transformOpenAIChatSseToAnthropic,
  transformResponsesSseToAnthropic,
  type ClaudeProxyApiFormat,
} from './transform'

interface ClaudeOpenAiProxyOptions {
  provider: ProviderType
  apiKey: string
  upstreamBaseUrl: string
  apiFormat: ClaudeProxyApiFormat
  proxyUrl?: string
}

export interface ClaudeOpenAiProxyHandle {
  /** 传给 Claude Agent SDK 的 Anthropic Base URL，SDK 会自行拼接 /v1/messages */
  baseUrl: string
  close: () => Promise<void>
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function buildUpstreamHeaders(options: ClaudeOpenAiProxyOptions): Record<string, string> {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${options.apiKey}`,
  }
}

function emitAnthropicSse(res: ServerResponse, eventName: string, data: Record<string, unknown>): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function handleMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ClaudeOpenAiProxyOptions,
): Promise<void> {
  const body = await readJsonBody(req)
  const upstreamBaseUrl = normalizeBaseUrl(options.upstreamBaseUrl)
  const isResponses = options.apiFormat === 'openai_responses'
  const upstreamBody = isResponses ? anthropicToResponses(body) : anthropicToOpenai(body, false)
  const upstreamUrl = isResponses ? `${upstreamBaseUrl}/responses` : `${upstreamBaseUrl}/chat/completions`
  const fetchFn = getFetchFn(options.proxyUrl)

  const upstreamResponse = await fetchFn(upstreamUrl, {
    method: 'POST',
    headers: buildUpstreamHeaders(options),
    body: JSON.stringify(upstreamBody),
  })

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '')
    console.error(`[OpenAI-Claude 代理] 上游请求失败 (${upstreamResponse.status}): ${text.slice(0, 500)}`)
    writeJson(res, upstreamResponse.status, {
      type: 'error',
      error: {
        type: 'api_error',
        message: text || `OpenAI 兼容上游返回 ${upstreamResponse.status}`,
      },
    })
    return
  }

  if (upstreamBody.stream === true) {
    if (!upstreamResponse.body) {
      writeJson(res, 502, {
        type: 'error',
        error: { type: 'api_error', message: 'OpenAI 兼容上游没有返回流式响应体' },
      })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    })

    const model = typeof upstreamBody.model === 'string' ? upstreamBody.model : ''
    if (isResponses) {
      await transformResponsesSseToAnthropic(upstreamResponse.body, model, (eventName, data) => {
        emitAnthropicSse(res, eventName, data)
      })
    } else {
      await transformOpenAIChatSseToAnthropic(upstreamResponse.body, model, (eventName, data) => {
        emitAnthropicSse(res, eventName, data)
      })
    }
    res.end()
    return
  }

  const responseJson = await upstreamResponse.json() as unknown
  if (typeof responseJson !== 'object' || responseJson === null || Array.isArray(responseJson)) {
    writeJson(res, 502, {
      type: 'error',
      error: { type: 'api_error', message: 'OpenAI 兼容上游返回了非对象 JSON' },
    })
    return
  }

  const anthropicBody = isResponses
    ? responsesToAnthropic(responseJson as Record<string, unknown>)
    : openaiToAnthropic(responseJson as Record<string, unknown>)
  writeJson(res, 200, anthropicBody)
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ClaudeOpenAiProxyOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    writeText(res, 405, 'Method Not Allowed')
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/v1/messages' && url.pathname !== '/messages') {
    writeText(res, 404, 'Not Found')
    return
  }

  await handleMessagesRequest(req, res, options)
}

export async function startClaudeOpenAiProxy(options: ClaudeOpenAiProxyOptions): Promise<ClaudeOpenAiProxyHandle> {
  const server = createServer((req, res) => {
    routeRequest(req, res, options).catch((error) => {
      const message = error instanceof Error ? error.message : '未知错误'
      console.error('[OpenAI-Claude 代理] 请求处理失败:', error)
      if (!res.headersSent) {
        writeJson(res, 500, {
          type: 'error',
          error: { type: 'api_error', message },
        })
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  console.log(`[OpenAI-Claude 代理] 已启动: ${baseUrl} → ${options.upstreamBaseUrl} (${options.apiFormat})`)

  return {
    baseUrl,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close((error) => {
      if (error) console.warn('[OpenAI-Claude 代理] 关闭时发生错误:', error)
      resolve()
    })
  })
}
