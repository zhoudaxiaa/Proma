import { describe, expect, test } from 'bun:test'
import { anthropicToOpenai, anthropicToResponses, openaiToAnthropic } from './transform'

describe('OpenAI-Claude 协议转换', () => {
  test('Given Anthropic Messages 请求 When 转成 OpenAI Chat Then 剥离开头计费头并保留工具调用顺序', () => {
    const result = anthropicToOpenai({
      model: 'gpt-5',
      system: 'x-anthropic-billing-header: cc_version=1; cch=abc;\n\nYou are helpful.',
      max_tokens: 100,
      stream: true,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '需要读文件' },
            { type: 'text', text: '我来看看。' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { z: 1, pages: '', a: 2 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: '文件内容' },
          ],
        },
      ],
      tools: [
        { name: 'Read', description: '读取文件', input_schema: { type: 'object', properties: { file_path: { type: 'string', format: 'uri' } } } },
        { type: 'BatchTool', name: 'BatchTool' },
      ],
      tool_choice: { type: 'tool', name: 'Read' },
    }, true)

    expect(result.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'assistant',
        content: '我来看看。',
        tool_calls: [{
          id: 'tool-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"a":2,"z":1}' },
        }],
        reasoning_content: '需要读文件',
      },
      { role: 'tool', tool_call_id: 'tool-1', content: '文件内容' },
    ])
    expect(result.max_tokens).toBe(100)
    expect(result.reasoning_effort).toBeUndefined()
    expect(result.tools).toEqual([{
      type: 'function',
      function: {
        name: 'Read',
        description: '读取文件',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    }])
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } })
  })

  test('Given Anthropic tool blocks When 转成 Responses API Then tool_use 与 tool_result 提升为顶层 input item', () => {
    const result = anthropicToResponses({
      model: 'gpt-5',
      system: [{ text: '系统提示 A' }, { text: '系统提示 B' }],
      max_tokens: 50,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '先说明' },
            { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: { ok: true } }],
        },
      ],
    })

    expect(result.instructions).toBe('系统提示 A\n系统提示 B')
    expect(result.max_output_tokens).toBe(50)
    expect(result.input).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: '先说明' }] },
      { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
      { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
    ])
  })

  test('Given OpenAI Chat 响应 When 转回 Anthropic Then reasoning 与 tool_calls 转为 content blocks', () => {
    const result = openaiToAnthropic({
      id: 'chatcmpl-1',
      model: 'gpt-5',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: '分析中',
          content: '需要调用工具',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'Read', arguments: '{"pages":"","file_path":"a.md"}' },
          }],
        },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })

    expect(result.stop_reason).toBe('tool_use')
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 })
    expect(result.content).toEqual([
      { type: 'thinking', thinking: '分析中' },
      { type: 'text', text: '需要调用工具' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.md' } },
    ])
  })
})
