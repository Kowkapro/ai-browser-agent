import type { LLMProvider, TextContent, MessageContent } from '../llm/provider.js';
import type { ValidationResult } from './types.js';
import { extractPageState } from '../browser/extraction.js';
import { getActivePage, takeScreenshot } from '../browser/browser.js';
import { getValidatorPrompt } from './prompt.js';
import { logger } from '../utils/logger.js';

export async function runValidator(
  subtaskDescription: string,
  workerResult: string,
  llm: LLMProvider,
): Promise<ValidationResult> {
  const page = getActivePage();
  const pageState = await extractPageState(page);

  // Build message with page state + screenshot
  const userContent: MessageContent[] = [{
    type: 'text',
    text: getValidatorPrompt(subtaskDescription, workerResult, pageState.formatted),
  }];

  try {
    const screenshotBuf = await takeScreenshot();
    userContent.push({
      type: 'image',
      base64: screenshotBuf.toString('base64'),
      mediaType: 'image/png',
    });
  } catch { /* proceed without screenshot */ }

  const messages = [
    {
      role: 'system' as const,
      content: [{ type: 'text' as const, text: 'You are a validation agent. Analyze browser state and screenshots to verify task completion. Respond with JSON only.' }],
    },
    {
      role: 'user' as const,
      content: userContent,
    },
  ];

  // Single LLM call, no tools
  const response = await llm.chat(messages, []);
  const text = response.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  return parseValidationResult(text);
}

function parseValidationResult(text: string): ValidationResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        completed: Boolean(parsed.completed),
        confidence: parsed.confidence || 'medium',
        reasoning: parsed.reasoning || 'No reasoning provided.',
        suggestions: parsed.suggestions,
      };
    }
  } catch { /* fallback below */ }

  // Fallback: heuristic parsing
  const lower = text.toLowerCase();
  const completed = lower.includes('completed') && !lower.includes('not completed');
  return {
    completed,
    confidence: 'low',
    reasoning: text.slice(0, 300),
  };
}
