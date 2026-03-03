import type { LLMProvider, TextContent } from '../llm/provider.js';
import type {
  CoordinatorResult, Subtask, TaskClassification,
  TaskDecomposition, ValidationResult,
} from './types.js';
import { runWorker } from './worker.js';
import { runValidator } from './validator.js';
import { extractPageState } from '../browser/extraction.js';
import { getActivePage, hideAgentOverlay } from '../browser/browser.js';
import {
  getCoordinatorSystemPrompt, getClassificationPrompt,
  getDecompositionPrompt, getReplanPrompt,
} from './prompt.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const MAX_SUBTASK_RETRIES = 2;

export async function runCoordinator(
  task: string,
  llm: LLMProvider,
): Promise<CoordinatorResult> {
  const page = getActivePage();
  const initialState = await extractPageState(page);

  logger.coordinator(`Задача: ${task}`);
  logger.info(`Начальная страница: ${initialState.url}`);

  // === Step 1: Classify the task ===
  logger.info('Классификация задачи...');
  const classification = await classifyTask(task, initialState.formatted, llm);
  logger.coordinator(`Тип: ${classification.complexity} (${classification.reasoning})`);

  // === Step 2: Decompose or create single subtask ===
  let subtasks: Subtask[];

  if (classification.complexity === 'simple') {
    subtasks = [{
      id: 1,
      description: task,
      status: 'pending',
      retryCount: 0,
    }];
    logger.info('Простая задача — выполняю напрямую.');
  } else {
    logger.info('Декомпозиция на подзадачи...');
    const decomposition = await decomposeTask(task, initialState.formatted, llm);
    subtasks = decomposition.subtasks;
    logger.coordinatorPlan(decomposition.overallStrategy, subtasks);
  }

  // === Step 3: Execute subtasks sequentially ===
  let totalSteps = 0;
  let completedCount = 0;

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];

    // Check total step budget
    if (totalSteps >= config.maxIterations) {
      logger.error(`Общий лимит шагов (${config.maxIterations}) исчерпан.`);
      subtask.status = 'failed';
      subtask.result = 'Global step budget exhausted.';
      break;
    }

    subtask.status = 'in_progress';
    logger.coordinatorSubtask(subtask.id, subtasks.length, subtask.description);

    let workerSuccess = false;

    for (let attempt = 0; attempt <= MAX_SUBTASK_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.info(`Повторная попытка подзадачи ${subtask.id} (${attempt + 1}/${MAX_SUBTASK_RETRIES + 1})`);
      }

      // Check budget before each attempt
      if (totalSteps >= config.maxIterations) {
        logger.error('Лимит шагов исчерпан — пропускаю retry.');
        break;
      }

      // Fresh page state before each Worker run
      const currentState = await extractPageState(getActivePage());

      // Build context: what previous workers accomplished
      const completedSummary = subtasks
        .filter(s => s.status === 'completed')
        .map(s => `- Subtask ${s.id}: ${s.description} → ${s.result}`)
        .join('\n');

      // Retry feedback from Validator
      const retryFeedback = attempt > 0 && subtask.validationResult
        ? `${subtask.validationResult.reasoning}${subtask.validationResult.suggestions ? `. Try: ${subtask.validationResult.suggestions}` : ''}`
        : undefined;

      // === Run Worker ===
      const workerReport = await runWorker(
        subtask.description,
        llm,
        currentState,
        completedSummary || undefined,
        retryFeedback,
      );

      totalSteps += workerReport.steps;

      if (!workerReport.success) {
        logger.info(`Worker завершился неуспешно: ${workerReport.result}`);
        subtask.result = workerReport.result;
        continue; // retry
      }

      // === Run Validator ===
      logger.validator(`Проверяю подзадачу ${subtask.id}...`);
      let validation: ValidationResult;
      try {
        validation = await runValidator(subtask.description, workerReport.result, llm);
      } catch (err) {
        // If validator fails, trust Worker's self-report
        logger.info('Ошибка валидатора — доверяю отчёту Worker.');
        validation = { completed: true, confidence: 'low', reasoning: 'Validator error, trusting worker report.' };
      }

      subtask.validationResult = validation;

      if (validation.completed) {
        subtask.status = 'completed';
        subtask.result = workerReport.result;
        completedCount++;
        workerSuccess = true;
        logger.validator(`Подзадача ${subtask.id} подтверждена (${validation.confidence}).`);
        break;
      } else {
        logger.validator(`Не подтверждена: ${validation.reasoning}`);
        subtask.retryCount++;
      }
    }

    if (!workerSuccess) {
      subtask.status = 'failed';

      // Try re-planning remaining subtasks
      const remaining = subtasks.filter(s => s.status === 'pending');
      if (remaining.length > 0 && totalSteps < config.maxIterations) {
        logger.info('Перепланирование оставшихся подзадач...');
        try {
          const pageState = await extractPageState(getActivePage());
          const newPlan = await replanTask(task, subtasks, subtask, remaining, pageState.formatted, llm);

          // Replace remaining subtasks with new plan
          const nextIndex = i + 1;
          subtasks.splice(nextIndex, subtasks.length - nextIndex, ...newPlan.subtasks);
          logger.coordinatorPlan(newPlan.overallStrategy, newPlan.subtasks);
        } catch {
          logger.info('Ошибка перепланирования — продолжаю с текущим планом.');
        }
      }
    }
  }

  // === Step 4: Build final report ===
  await hideAgentOverlay(getActivePage());

  const allCompleted = subtasks.every(s => s.status === 'completed');

  // Build user-friendly report: last completed subtask's result is the most useful summary
  const completedResults = subtasks
    .filter(s => s.status === 'completed' && s.result)
    .map(s => s.result!);
  const failedResults = subtasks
    .filter(s => s.status === 'failed')
    .map(s => s.description);

  let report = '';
  if (completedResults.length > 0) {
    // Use the last completed result as the main summary (it's usually the most comprehensive)
    report = completedResults[completedResults.length - 1];
  }
  if (failedResults.length > 0) {
    report += `\n\nНе выполнено: ${failedResults.join('; ')}`;
  }

  return {
    success: allCompleted,
    result: report || 'Задача завершена.',
    totalSteps,
    subtasksCompleted: completedCount,
    subtasksTotal: subtasks.length,
  };
}

// === Classification: 1 LLM call ===
async function classifyTask(
  task: string,
  pageState: string,
  llm: LLMProvider,
): Promise<TaskClassification> {
  const messages = [
    { role: 'system' as const, content: [{ type: 'text' as const, text: getCoordinatorSystemPrompt() }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: getClassificationPrompt(task, pageState) }] },
  ];

  const response = await llm.chat(messages, []);
  const text = extractText(response.content);

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        complexity: parsed.complexity === 'complex' ? 'complex' : 'simple',
        reasoning: parsed.reasoning || '',
      };
    }
  } catch { /* fallback */ }

  // Fallback: assume simple
  return { complexity: 'simple', reasoning: 'Classification parse failed — defaulting to simple.' };
}

// === Decomposition: 1 LLM call ===
async function decomposeTask(
  task: string,
  pageState: string,
  llm: LLMProvider,
): Promise<TaskDecomposition> {
  const messages = [
    { role: 'system' as const, content: [{ type: 'text' as const, text: getCoordinatorSystemPrompt() }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: getDecompositionPrompt(task, pageState) }] },
  ];

  const response = await llm.chat(messages, []);
  const text = extractText(response.content);

  return parseDecomposition(text);
}

// === Re-planning: 1 LLM call ===
async function replanTask(
  originalTask: string,
  allSubtasks: Subtask[],
  failedSubtask: Subtask,
  remaining: Subtask[],
  pageState: string,
  llm: LLMProvider,
): Promise<TaskDecomposition> {
  const completedDesc = allSubtasks
    .filter(s => s.status === 'completed')
    .map(s => `  ${s.id}. ${s.description} → ${s.result}`)
    .join('\n');

  const failedDesc = `${failedSubtask.description}`;
  const failedReason = failedSubtask.validationResult?.reasoning || failedSubtask.result || 'Unknown failure';

  const remainingDesc = remaining
    .map(s => `  ${s.id}. ${s.description}`)
    .join('\n');

  const messages = [
    { role: 'system' as const, content: [{ type: 'text' as const, text: getCoordinatorSystemPrompt() }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: getReplanPrompt(originalTask, completedDesc, failedDesc, failedReason, remainingDesc, pageState) }] },
  ];

  const response = await llm.chat(messages, []);
  const text = extractText(response.content);

  return parseDecomposition(text);
}

// === Helpers ===

function extractText(content: import('../llm/provider.js').MessageContent[]): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function parseDecomposition(text: string): TaskDecomposition {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const subtasks: Subtask[] = (parsed.subtasks || [])
        .slice(0, 8) // cap at 8
        .map((s: { id?: number; description?: string }, idx: number) => ({
          id: s.id || idx + 1,
          description: s.description || `Subtask ${idx + 1}`,
          status: 'pending' as const,
          retryCount: 0,
        }));

      return {
        subtasks,
        overallStrategy: parsed.overallStrategy || 'Execute subtasks sequentially.',
      };
    }
  } catch { /* fallback */ }

  // Fallback: treat as single subtask
  return {
    subtasks: [{ id: 1, description: 'Execute the task', status: 'pending', retryCount: 0 }],
    overallStrategy: 'Decomposition parse failed — executing as single task.',
  };
}
