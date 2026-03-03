import OpenAI from 'openai';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type {
  LLMProvider,
  LLMResponse,
  Message,
  MessageContent,
  ToolDefinition,
  ToolUseContent,
  TextContent,
} from './provider.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: config.apiKey });
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    const openaiMessages = this.convertMessages(messages);
    const openaiTools = this.convertTools(tools);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: config.model,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          max_tokens: 4096,
        });

        return this.parseResponse(response);
      } catch (error: unknown) {
        const isRetryable = this.isRetryableError(error);
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.error(`LLM API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }

    throw new Error('LLM API: max retries exceeded');
  }

  private convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = msg.content
          .filter((c): c is TextContent => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        result.push({ role: 'system', content: text });
        continue;
      }

      if (msg.role === 'user') {
        const parts: OpenAI.ChatCompletionContentPart[] = [];
        for (const c of msg.content) {
          if (c.type === 'text') {
            parts.push({ type: 'text', text: c.text });
          } else if (c.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${c.mediaType};base64,${c.base64}` },
            });
          }
        }
        result.push({ role: 'user', content: parts });
        continue;
      }

      if (msg.role === 'assistant') {
        const textParts = msg.content.filter((c): c is TextContent => c.type === 'text');
        const toolParts = msg.content.filter((c): c is ToolUseContent => c.type === 'tool_use');

        const content = textParts.map(c => c.text).join('\n') || undefined;
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = toolParts.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args),
          },
        }));

        result.push({
          role: 'assistant',
          content: content ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }

      if (msg.role === 'tool') {
        for (const c of msg.content) {
          if (c.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: c.toolUseId,
              content: c.content,
            });
          }
        }
        continue;
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
  }

  private parseResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    const message = choice.message;
    const content: MessageContent[] = [];

    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          logger.error(`Failed to parse tool args: ${tc.function.arguments}`);
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          args,
        });
      }
    }

    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
      stopReason = 'max_tokens';
    }

    return { content, stopReason };
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      return error.status === 429 || error.status === 500 || error.status === 503;
    }
    if (error instanceof Error && error.message.includes('ECONNRESET')) {
      return true;
    }
    return false;
  }
}
