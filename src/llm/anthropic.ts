import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type {
  LLMProvider,
  LLMResponse,
  Message,
  MessageContent,
  ToolDefinition,
  TextContent,
} from './provider.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    const { system, anthropicMessages } = this.convertMessages(messages);
    const anthropicTools = this.convertTools(tools);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const params: Anthropic.MessageCreateParams = {
          model: config.model,
          max_tokens: 4096,
          messages: anthropicMessages,
        };

        if (system) {
          params.system = system;
        }

        if (anthropicTools.length > 0) {
          params.tools = anthropicTools;
        }

        const response = await this.client.messages.create(params);
        return this.parseResponse(response);
      } catch (error: unknown) {
        const isRetryable = this.isRetryableError(error);
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.error(`Anthropic API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }

    throw new Error('Anthropic API: max retries exceeded');
  }

  private convertMessages(messages: Message[]): {
    system: string;
    anthropicMessages: Anthropic.MessageParam[];
  } {
    let system = '';
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      // System messages → extracted as system parameter
      if (msg.role === 'system') {
        const texts = msg.content
          .filter((c): c is TextContent => c.type === 'text')
          .map(c => c.text);
        system = texts.join('\n');
        continue;
      }

      // User messages
      if (msg.role === 'user') {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const c of msg.content) {
          if (c.type === 'text') {
            content.push({ type: 'text', text: c.text });
          } else if (c.type === 'image') {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: c.mediaType,
                data: c.base64,
              },
            });
          }
        }
        anthropicMessages.push({ role: 'user', content });
        continue;
      }

      // Assistant messages
      if (msg.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const c of msg.content) {
          if (c.type === 'text') {
            content.push({ type: 'text', text: c.text });
          } else if (c.type === 'tool_use') {
            content.push({
              type: 'tool_use',
              id: c.id,
              name: c.name,
              input: c.args,
            });
          }
        }
        anthropicMessages.push({ role: 'assistant', content });
        continue;
      }

      // Tool results → become user messages in Anthropic API
      if (msg.role === 'tool') {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const c of msg.content) {
          if (c.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              tool_use_id: c.toolUseId,
              content: c.content,
            });
          } else if (c.type === 'image') {
            // Attach image to the last tool_result if present
            // Anthropic supports images inside tool_result content
            const lastBlock = content[content.length - 1];
            if (lastBlock && lastBlock.type === 'tool_result') {
              // Convert string content to array with text + image
              const existingContent = typeof lastBlock.content === 'string'
                ? lastBlock.content
                : '';
              (lastBlock as any).content = [
                { type: 'text', text: existingContent },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: c.mediaType,
                    data: c.base64,
                  },
                },
              ];
            }
          }
        }
        anthropicMessages.push({ role: 'user', content });
        continue;
      }
    }

    // Anthropic requires alternating user/assistant messages.
    // Merge consecutive same-role messages.
    const merged = this.mergeConsecutiveMessages(anthropicMessages);

    return { system, anthropicMessages: merged };
  }

  /**
   * Anthropic API requires strictly alternating user/assistant messages.
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length === 0) return [];

    const result: Anthropic.MessageParam[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = result[result.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        // Merge content arrays
        const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text' as const, text: prev.content }];
        const currContent = Array.isArray(curr.content) ? curr.content : [{ type: 'text' as const, text: curr.content }];
        prev.content = [...prevContent, ...currContent];
      } else {
        result.push(curr);
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    }));
  }

  private parseResponse(response: Anthropic.Message): LLMResponse {
    const content: MessageContent[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    if (response.stop_reason === 'tool_use') {
      stopReason = 'tool_use';
    } else if (response.stop_reason === 'max_tokens') {
      stopReason = 'max_tokens';
    }

    return { content, stopReason };
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      return error.status === 429 || error.status === 500 || error.status === 503 || error.status === 529;
    }
    if (error instanceof Error && error.message.includes('ECONNRESET')) {
      return true;
    }
    return false;
  }
}