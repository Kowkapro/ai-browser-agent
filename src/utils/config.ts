import dotenv from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env');

if (!existsSync(envPath)) {
  console.error(
    '\n[ERROR] .env file not found.\n' +
    'Copy .env.example to .env and add your API key:\n\n' +
    '  cp .env.example .env\n'
  );
  process.exit(1);
}

dotenv.config({ path: envPath });

export type LLMProviderType = 'openai' | 'anthropic';

// Detect provider from environment variables.
// Priority: LLM_API_KEY (universal) > OPENAI_API_KEY > ANTHROPIC_API_KEY
function detectProvider(): { type: LLMProviderType; apiKey: string } {
  // Universal key — uses OpenAI-compatible endpoint (works with polza.ai, OpenRouter, etc.)
  if (process.env.LLM_API_KEY) {
    return { type: 'openai', apiKey: process.env.LLM_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { type: 'openai', apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  }

  console.error(
    '\n[ERROR] No API key found in .env.\n' +
    'Set at least one of:\n' +
    '  LLM_API_KEY=...         (universal, for polza.ai / OpenRouter / etc.)\n' +
    '  OPENAI_API_KEY=sk-...\n' +
    '  ANTHROPIC_API_KEY=sk-ant-...\n'
  );
  process.exit(1);
}

const { type: provider, apiKey } = detectProvider();

const defaultModels: Record<LLMProviderType, string> = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-20250514',
};

const model = process.env.LLM_MODEL || defaultModels[provider];

// Only validate model/provider match when using direct provider keys (not universal LLM_API_KEY)
if (process.env.LLM_MODEL && !process.env.LLM_API_KEY) {
  const isClaudeModel = model.startsWith('claude');
  if (isClaudeModel && provider === 'openai') {
    console.error(
      `\n[ERROR] Model "${model}" is a Claude model, but the detected provider is OpenAI.\n` +
      'Either set ANTHROPIC_API_KEY in .env, or change LLM_MODEL to an OpenAI model.\n'
    );
    process.exit(1);
  }
  if (!isClaudeModel && provider === 'anthropic') {
    console.error(
      `\n[ERROR] Model "${model}" is not a Claude model, but the detected provider is Anthropic.\n` +
      'Either set OPENAI_API_KEY in .env, or change LLM_MODEL to a Claude model.\n'
    );
    process.exit(1);
  }
}

// Validate MAX_ITERATIONS
const maxIterations = parseInt(process.env.MAX_ITERATIONS || '100', 10);
if (isNaN(maxIterations) || maxIterations < 1) {
  console.error(
    '\n[ERROR] MAX_ITERATIONS must be a positive integer.\n' +
    `Got: "${process.env.MAX_ITERATIONS}"\n`
  );
  process.exit(1);
}

// Worker step budget (per subtask)
const workerMaxSteps = parseInt(process.env.WORKER_MAX_STEPS || '30', 10);

// Custom base URL for OpenAI-compatible proxies (polza.ai, OpenRouter, etc.)
const baseUrl = process.env.LLM_BASE_URL || undefined;

export const config = {
  provider,
  apiKey,
  baseUrl,
  model,
  maxIterations,
  workerMaxSteps,
  browserDataDir: path.resolve(process.cwd(), 'browser-data'),
} as const;