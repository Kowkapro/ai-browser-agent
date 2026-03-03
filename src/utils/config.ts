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

export const config = {
  provider,
  apiKey: provider === 'openai'
    ? process.env.OPENAI_API_KEY!
    : process.env.ANTHROPIC_API_KEY!,
  model: process.env.LLM_MODEL || defaultModels[provider],
  maxIterations: parseInt(process.env.MAX_ITERATIONS || '50', 10),
  browserDataDir: path.resolve(process.cwd(), 'browser-data'),
} as const;
