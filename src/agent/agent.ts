import type { LLMProvider, MessageContent, ToolUseContent, TextContent } from '../llm/provider.js';
import { toolDefinitions } from '../browser/tools.js';
import { executeAction, type ToolResult } from '../browser/actions.js';
import { extractPageState } from '../browser/extraction.js';
import { getActivePage, showAgentOverlay, hideAgentOverlay, takeScreenshot } from '../browser/browser.js';
import { ConversationHistory } from './history.js';
import { getSystemPrompt, getPlanningPrompt, getReflectionPrompt, getLoopWarning, getOutcomeAssessmentPrompt } from './prompt.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const REFLECTION_INTERVAL = 5;
const MAX_TEXT_ONLY_RETRIES = 3;

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

  // === Planning phase: ask LLM to create a plan before acting ===
  logger.info('Составляю план выполнения...');

  const planMessages = history.buildMessages();
  planMessages.push({
    role: 'user',
    content: [{ type: 'text', text: getPlanningPrompt(task) }],
  });

  let plan = '';
  try {
    // Call LLM WITHOUT tools so it can only return text
    const planResponse = await llm.chat(planMessages, []);
    const planTextParts = planResponse.content.filter((c): c is TextContent => c.type === 'text');
    plan = planTextParts.map(t => t.text).join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Ошибка при планировании: ${msg}`);
    // Continue without plan — not fatal
  }

  if (plan) {
    logger.plan(plan);
    // Add plan to history so the agent follows it during execution
    history.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `My plan:\n${plan}` }],
    });
    history.addMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Good plan. Now execute it step by step. Start with the first action. Remember to use tool calls for every action.' }],
    });
  }

  // Show overlay — agent is working
  await showAgentOverlay(page);
  logger.statusWorking();

  // === Main agent loop ===
  let step = 0;
  let textOnlyRetries = 0;
  while (step < config.maxIterations) {
    step++;
    logger.step(step, config.maxIterations);

    // Build messages with context management
    const messages = history.buildMessages();

    // Inject reflection / loop warning as a NEW message (never mutate history objects)
    if (history.isLooping()) {
      logger.info('Обнаружено зацикливание — инжектирую предупреждение.');
      messages.push({ role: 'user', content: [{ type: 'text', text: getLoopWarning() }] });
    } else if (history.getStepCount() > 0 && history.getStepCount() % REFLECTION_INTERVAL === 0) {
      logger.info(`Рефлексия (после ${history.getStepCount()} шагов)...`);
      messages.push({ role: 'user', content: [{ type: 'text', text: getReflectionPrompt(history.getStepCount()) }] });
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

    // No tool calls — nudge the LLM to use a tool instead of just outputting text
    if (toolCalls.length === 0) {
      textOnlyRetries++;
      if (textOnlyRetries >= MAX_TEXT_ONLY_RETRIES) {
        logger.error(`LLM ответил текстом ${textOnlyRetries} раз подряд — завершаю.`);
        await hideAgentOverlay(getActivePage());
        return { success: false, result: 'LLM repeatedly failed to use tools. Task aborted.', steps: step };
      }
      logger.info(`LLM ответил текстом без tool call (попытка ${textOnlyRetries}/${MAX_TEXT_ONLY_RETRIES}) — напоминаю.`);
      history.addMessage({
        role: 'user',
        content: [{
          type: 'text',
          text: 'You must ALWAYS respond with a tool call. If you need the user to perform an action (login, CAPTCHA, etc.), use the wait_for_user tool. If the task is complete, use the done tool. Please respond with the appropriate tool call now.',
        }],
      });
      continue;
    }
    textOnlyRetries = 0; // reset on successful tool call

    // Execute each tool call
    let lastResult: ToolResult | undefined;
    for (const tc of toolCalls) {
      const result = await executeAction(tc.name, tc.args);
      lastResult = result;

      // Handle "done" tool
      if (tc.name === 'done') {
        await hideAgentOverlay(getActivePage());
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

    // After executing tools: re-inject overlay (it disappears on navigation)
    const currentPage = getActivePage();
    await showAgentOverlay(currentPage);

    // Get fresh page state and append as user message
    const snapshot = await extractPageState(currentPage);

    // Build outcome assessment for the last action (use actual tool result, not URL)
    const lastTc = toolCalls[toolCalls.length - 1];
    const outcomeHint = getOutcomeAssessmentPrompt(
      lastTc.name, lastTc.args,
      lastResult?.data || lastResult?.error || 'unknown',
    );

    // Take a screenshot for visual context (helps agent verify outcomes)
    const pageContent: MessageContent[] = [{
      type: 'text',
      text: `${outcomeHint}\n\nCurrent browser state:\n${snapshot.formatted}`,
    }];

    try {
      const screenshotBuf = await takeScreenshot();
      pageContent.push({
        type: 'image',
        base64: screenshotBuf.toString('base64'),
        mediaType: 'image/png',
      });
    } catch { /* screenshot not critical */ }

    history.addMessage({ role: 'user', content: pageContent });
  }

  // Max iterations reached
  await hideAgentOverlay(getActivePage());
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
