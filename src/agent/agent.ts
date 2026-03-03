import type { LLMProvider, MessageContent, ToolUseContent, TextContent } from '../llm/provider.js';
import { toolDefinitions } from '../browser/tools.js';
import { executeAction, type ToolResult } from '../browser/actions.js';
import { extractPageState } from '../browser/extraction.js';
import { getActivePage } from '../browser/browser.js';
import { ConversationHistory } from './history.js';
import { getSystemPrompt, getReflectionPrompt, getLoopWarning } from './prompt.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const REFLECTION_INTERVAL = 5;

export interface AgentResult {
  success: boolean;
  result: string;
  steps: number;
}

export async function runAgent(task: string, llm: LLMProvider): Promise<AgentResult> {
  const history = new ConversationHistory();

  // System message
  history.addMessage({
    role: 'system',
    content: [{ type: 'text', text: getSystemPrompt() }],
  });

  // Initial task + page state
  const page = getActivePage();
  const initialSnapshot = await extractPageState(page);

  history.addMessage({
    role: 'user',
    content: [{
      type: 'text',
      text: `Task: ${task}\n\nCurrent browser state:\n${initialSnapshot.formatted}`,
    }],
  });

  logger.agent(`Задача: ${task}`);
  logger.info(`Начальная страница: ${initialSnapshot.url}`);

  // === Main agent loop ===
  for (let step = 1; step <= config.maxIterations; step++) {
    logger.step(step, config.maxIterations);

    // Build messages with context management
    const messages = history.buildMessages();

    // Inject reflection / loop warning
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      const textContent = lastMsg.content.find((c): c is TextContent => c.type === 'text');
      if (textContent) {
        if (history.isLooping()) {
          textContent.text += getLoopWarning();
        } else if (history.getStepCount() > 0 && history.getStepCount() % REFLECTION_INTERVAL === 0) {
          textContent.text += getReflectionPrompt(history.getStepCount());
        }
      }
    }

    // Call LLM
    let response;
    try {
      response = await llm.chat(messages, toolDefinitions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`LLM error: ${msg}`);
      return { success: false, result: `LLM error: ${msg}`, steps: step };
    }

    // Process response content
    const toolCalls = response.content.filter((c): c is ToolUseContent => c.type === 'tool_use');
    const textParts = response.content.filter((c): c is TextContent => c.type === 'text');
    const assistantText = textParts.map(t => t.text).join('\n');

    // Log agent's thinking
    if (assistantText) {
      logger.agent(assistantText.length > 200 ? assistantText.slice(0, 200) + '...' : assistantText);
    }

    // Add assistant message to history
    history.addMessage({
      role: 'assistant',
      content: response.content,
    });

    // No tool calls = agent is done or wants to communicate
    if (toolCalls.length === 0) {
      return {
        success: true,
        result: assistantText || 'Task completed (no summary provided).',
        steps: step,
      };
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      logger.action(tc.name, JSON.stringify(tc.args));

      const result = await executeAction(tc.name, tc.args);

      // Handle "done" tool
      if (tc.name === 'done') {
        history.recordStep(tc.name, tc.args, result.data || '');
        addToolResult(history, tc, result);
        return {
          success: result.success,
          result: result.data || 'Task completed.',
          steps: step,
        };
      }

      // Record step summary
      history.recordStep(tc.name, tc.args, result.data || result.error || '');

      // Add tool result to history
      addToolResult(history, tc, result);

      // Log result
      if (result.success) {
        logger.result(result.data || 'OK');
      } else {
        logger.error(result.error || 'Unknown error');
        if (result.suggestion) logger.info(`Hint: ${result.suggestion}`);
      }
    }

    // After executing tools: get fresh page state and append as user message
    const snapshot = await extractPageState(getActivePage());
    history.addMessage({
      role: 'user',
      content: [{
        type: 'text',
        text: `Current browser state:\n${snapshot.formatted}`,
      }],
    });
  }

  // Max iterations reached
  logger.error(`Достигнут лимит шагов (${config.maxIterations}).`);
  return {
    success: false,
    result: `Stopped after ${config.maxIterations} steps. Task may be incomplete.`,
    steps: config.maxIterations,
  };
}

function addToolResult(
  history: ConversationHistory,
  tc: ToolUseContent,
  result: ToolResult,
): void {
  const content: MessageContent[] = [{
    type: 'tool_result',
    toolUseId: tc.id,
    content: result.success
      ? (result.data || 'OK')
      : `ERROR: ${result.error}${result.suggestion ? `\nSuggestion: ${result.suggestion}` : ''}`,
  }];

  // Attach screenshot if present (on error or screenshot tool)
  if (result.screenshot) {
    content.push({
      type: 'image',
      base64: result.screenshot.toString('base64'),
      mediaType: 'image/png',
    });
  }

  history.addMessage({ role: 'tool', content });
}
