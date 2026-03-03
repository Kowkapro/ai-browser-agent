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

function detectProvider(): LLMProviderType {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';

  console.error(
    '\n[ERROR] No API key found in .env.\n' +
    'Set at least one of:\n' +
    '  OPENAI_API_KEY=sk-...\n' +
    '  ANTHROPIC_API_KEY=sk-ant-...\n'
  );
  process.exit(1);
}

const provider = detectProvider();

const defaultModels: Record<LLMProviderType, string> = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-20250514',
};

// Validate that LLM_MODEL matches the detected provider
const model = process.env.LLM_MODEL || defaultModels[provider];
if (process.env.LLM_MODEL) {
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
const maxIterations = parseInt(process.env.MAX_ITERATIONS || '50', 10);
if (isNaN(maxIterations) || maxIterations < 1) {
  console.error(
    '\n[ERROR] MAX_ITERATIONS must be a positive integer.\n' +
    `Got: "${process.env.MAX_ITERATIONS}"\n`
  );
  process.exit(1);
}

export const config = {
  provider,
  apiKey: provider === 'openai'
    ? process.env.OPENAI_API_KEY!
    : process.env.ANTHROPIC_API_KEY!,
  model,
  maxIterations,
  browserDataDir: path.resolve(process.cwd(), 'browser-data'),
} as const;
