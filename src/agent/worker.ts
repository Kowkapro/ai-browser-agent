import type { LLMProvider, MessageContent, ToolUseContent, TextContent } from '../llm/provider.js';
import type { WorkerReport } from './types.js';
import type { PageSnapshot } from '../browser/extraction.js';
import { toolDefinitions } from '../browser/tools.js';
import { executeAction, type ToolResult } from '../browser/actions.js';
import { extractPageState } from '../browser/extraction.js';
import { getActivePage, showAgentOverlay, hideAgentOverlay, takeScreenshot } from '../browser/browser.js';
import { ConversationHistory } from './history.js';
import { getWorkerSystemPrompt, getReflectionPrompt, getLoopWarning, getOutcomeAssessmentPrompt } from './prompt.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const REFLECTION_INTERVAL = 5;
const MAX_TEXT_ONLY_RETRIES = 5;

export async function runWorker(
  subtask: string,
  llm: LLMProvider,
  initialPageState: PageSnapshot,
  completedContext?: string,
  retryFeedback?: string,
): Promise<WorkerReport> {
  // Fresh history for each Worker invocation
  const history = new ConversationHistory();

  // System prompt
  history.addMessage({
    role: 'system',
    content: [{ type: 'text', text: getWorkerSystemPrompt() }],
  });

  // Build initial user message with subtask + context
  let initialMessage = `Your subtask: ${subtask}`;

  if (completedContext) {
    initialMessage += `\n\nAlready completed by previous workers:\n${completedContext}`;
  }

  if (retryFeedback) {
    initialMessage += `\n\nIMPORTANT — Previous attempt failed. Feedback:\n${retryFeedback}`;
  }

  initialMessage += `\n\nCurrent browser state:\n${initialPageState.formatted}`;

  history.addMessage({
    role: 'user',
    content: [{ type: 'text', text: initialMessage }],
  });

  logger.worker(`Подзадача: ${subtask}`);

  // Show overlay
  const page = getActivePage();
  await showAgentOverlay(page);

  // === Execution loop ===
  const maxSteps = config.workerMaxSteps;
  let step = 0;
  let textOnlyRetries = 0;

  let llmCalls = 0; // total LLM round-trips (including text-only)
  const MAX_LLM_CALLS = maxSteps * 2; // hard cap to prevent infinite text-only loops

  while (step < maxSteps && llmCalls < MAX_LLM_CALLS) {
    llmCalls++;

    // Build messages with context management
    const messages = history.buildMessages();

    // Inject reflection / loop warning
    if (history.isLooping()) {
      logger.info('Worker: обнаружено зацикливание.');
      messages.push({ role: 'user', content: [{ type: 'text', text: getLoopWarning() }] });
    } else if (history.getStepCount() > 0 && history.getStepCount() % REFLECTION_INTERVAL === 0) {
      logger.info(`Worker: рефлексия (после ${history.getStepCount()} шагов)...`);
      messages.push({ role: 'user', content: [{ type: 'text', text: getReflectionPrompt(history.getStepCount()) }] });
    }

    // Call LLM
    let response;
    try {
      response = await llm.chat(messages, toolDefinitions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Worker LLM error: ${msg}`);
      return {
        success: false,
        result: `LLM error: ${msg}`,
        steps: step,
        finalPageUrl: getActivePage().url(),
      };
    }

    // Process response
    const toolCalls = response.content.filter((c): c is ToolUseContent => c.type === 'tool_use');
    const textParts = response.content.filter((c): c is TextContent => c.type === 'text');
    const assistantText = textParts.map(t => t.text).join('\n');

    // Detect garbage output (repeated digits/chars with no meaningful content)
    const isGarbage = assistantText.length > 50 && /^[\d\s]{50,}/.test(assistantText);

    if (assistantText && !isGarbage) {
      logger.worker(assistantText.length > 200 ? assistantText.slice(0, 200) + '...' : assistantText);
    } else if (isGarbage) {
      logger.info('Worker: LLM вернул мусорный текст — игнорирую.');
    }

    history.addMessage({ role: 'assistant', content: response.content });

    // No tool calls — nudge LLM
    if (toolCalls.length === 0) {
      textOnlyRetries++;
      if (textOnlyRetries >= MAX_TEXT_ONLY_RETRIES) {
        logger.error(`Worker: LLM ответил текстом ${textOnlyRetries} раз подряд — завершаю.`);
        await hideAgentOverlay(getActivePage());
        return {
          success: false,
          result: 'Worker failed: LLM repeatedly did not use tools.',
          steps: step,
          finalPageUrl: getActivePage().url(),
        };
      }
      logger.info(`Worker: LLM ответил текстом без tool call (${textOnlyRetries}/${MAX_TEXT_ONLY_RETRIES}).`);
      history.addMessage({
        role: 'user',
        content: [{
          type: 'text',
          text: 'You must ALWAYS respond with a tool call. If you need the user to perform an action (login, CAPTCHA, etc.), use the wait_for_user tool. If the subtask is complete, use the done tool. Please respond with the appropriate tool call now.',
        }],
      });
      continue;
    }
    textOnlyRetries = 0;

    // Count step only when a tool is actually executed (not for text-only responses)
    step++;
    logger.workerStep(step, maxSteps);

    // Browser actions are sequential — only execute the first tool call.
    // If LLM sent multiple, add skip results for the rest to keep history valid.
    if (toolCalls.length > 1) {
      logger.info(`Worker: LLM вернул ${toolCalls.length} tool calls — выполняю только первый.`);
      for (const skipped of toolCalls.slice(1)) {
        addToolResult(history, skipped, {
          success: false,
          error: 'Only one tool call per step is supported. This call was skipped.',
          suggestion: 'Call tools one at a time — browser actions are sequential.',
        });
      }
    }

    // Execute the first tool call
    let lastResult: ToolResult | undefined;
    for (const tc of toolCalls.slice(0, 1)) {
      // Handle malformed arguments
      if (tc.args._parse_error) {
        const result: ToolResult = {
          success: false,
          error: `Malformed tool call: could not parse arguments "${tc.args._raw}".`,
          suggestion: 'Retry the tool call with valid JSON arguments.',
        };
        lastResult = result;
        history.recordStep(tc.name, tc.args, result.error!);
        addToolResult(history, tc, result);
        logger.error(result.error!);
        continue;
      }

      const result = await executeAction(tc.name, tc.args);
      lastResult = result;

      // Handle "done" tool — Worker reports completion
      if (tc.name === 'done') {
        await hideAgentOverlay(getActivePage());
        history.recordStep(tc.name, tc.args, result.data || '');
        addToolResult(history, tc, result);
        return {
          success: result.success,
          result: result.data || 'Subtask completed.',
          steps: step,
          finalPageUrl: getActivePage().url(),
        };
      }

      // Record step
      history.recordStep(tc.name, tc.args, result.data || result.error || '');
      addToolResult(history, tc, result);

      if (result.success) {
        logger.result(result.data || 'OK');
      } else {
        logger.error(result.error || 'Unknown error');
        if (result.suggestion) logger.info(`Hint: ${result.suggestion}`);
      }
    }

    // Re-inject overlay + get fresh page state
    const currentPage = getActivePage();
    await showAgentOverlay(currentPage);

    const snapshot = await extractPageState(currentPage);
    const lastTc = toolCalls[toolCalls.length - 1];
    const outcomeHint = getOutcomeAssessmentPrompt(
      lastTc.name, lastTc.args,
      lastResult?.data || lastResult?.error || 'unknown',
    );

    const pageContent: MessageContent[] = [{
      type: 'text',
      text: `${outcomeHint}\n\nCurrent browser state:\n${snapshot.formatted}`,
    }];

    // Only attach screenshot when it's actually useful (not on every step)
    const needsScreenshot = !lastResult?.success // error occurred
      || snapshot.elements.length === 0           // page may be blank
      || lastTc.name === 'screenshot';            // explicitly requested

    if (needsScreenshot) {
      try {
        const screenshotBuf = await takeScreenshot();
        pageContent.push({
          type: 'image',
          base64: screenshotBuf.toString('base64'),
          mediaType: 'image/png',
        });
      } catch { /* screenshot not critical */ }
    }

    history.addMessage({ role: 'user', content: pageContent });
  }

  // Max steps reached
  await hideAgentOverlay(getActivePage());
  logger.error(`Worker: достигнут лимит шагов (${maxSteps}).`);
  return {
    success: false,
    result: `Worker stopped after ${maxSteps} steps. Subtask may be incomplete.`,
    steps: maxSteps,
    finalPageUrl: getActivePage().url(),
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

  if (result.screenshot) {
    content.push({
      type: 'image',
      base64: result.screenshot.toString('base64'),
      mediaType: 'image/png',
    });
  }

  history.addMessage({ role: 'tool', content });
}
