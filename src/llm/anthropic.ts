import type {
  LLMProvider,
  LLMResponse,
  Message,
  ToolDefinition,
} from './provider.js';

export class AnthropicProvider implements LLMProvider {
  async chat(_messages: Message[], _tools: ToolDefinition[]): Promise<LLMResponse> {
    throw new Error('Anthropic provider is not yet implemented. Use OpenAI instead.');
  }
}
