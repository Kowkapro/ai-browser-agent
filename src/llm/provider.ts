import { config, type LLMProviderType } from '../utils/config.js';

// === Message types (provider-agnostic) ===

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  base64: string;
  mediaType: 'image/png' | 'image/jpeg';
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
}

export type MessageContent = TextContent | ImageContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent[];
}

// === Tool definition (JSON Schema based) ===

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

// === LLM Response ===

export interface LLMResponse {
  content: MessageContent[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

// === Abstract provider interface ===

export interface LLMProvider {
  chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}

// === Factory ===

export async function createProvider(): Promise<LLMProvider> {
  const type: LLMProviderType = config.provider;

  if (type === 'openai') {
    const { OpenAIProvider } = await import('./openai.js');
    return new OpenAIProvider();
  }

  if (type === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.js');
    return new AnthropicProvider();
  }

  throw new Error(`Unknown LLM provider: ${type}`);
}
