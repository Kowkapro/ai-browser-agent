import * as readline from 'readline';
import { config } from './utils/config.js';
import { logger } from './utils/logger.js';
import { launchBrowser, closeBrowser } from './browser/browser.js';
import { createProvider } from './llm/provider.js';
import { runCoordinator } from './agent/coordinator.js';

async function main() {
  console.log('\n========================================');
  console.log('  AI Browser Agent');
  console.log('========================================');
  console.log(`  Provider: ${config.provider} (${config.model})`);
  console.log(`  Max steps: ${config.maxIterations}`);
  console.log('========================================\n');

  // Init LLM provider
  const llm = await createProvider();
  logger.info(`LLM провайдер инициализирован: ${config.provider}`);

  // Launch browser
  await launchBrowser();

  // Setup readline for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let closed = false;

  const prompt = () => {
    if (closed) return;
    rl.question('\n> Введите задачу (или "exit" для выхода): ', async (input) => {
      const task = input.trim();

      if (!task || task.toLowerCase() === 'exit') {
        logger.info('Завершение работы...');
        await cleanup(rl);
        return;
      }

      try {
        const result = await runCoordinator(task, llm);
        if (result.success) {
          logger.statusDone(result.result, result.totalSteps);
        } else {
          logger.statusFailed(result.result, result.totalSteps);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Ошибка агента: ${msg}`);
      }

      // Prompt for next task or cleanup if stdin closed
      if (closed) {
        await cleanup(rl);
      } else {
        prompt();
      }
    });
  };

  // Handle stdin close (piped input) — just set flag, don't kill browser mid-task
  rl.on('close', () => {
    closed = true;
  });

  prompt();

  // Graceful shutdown on Ctrl+C (guard against double-press)
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) {
      process.exit(1); // force exit on second Ctrl+C
    }
    shuttingDown = true;
    console.log('\n');
    logger.info('Ctrl+C — завершение...');
    await cleanup(rl);
  });
}

async function cleanup(rl: readline.Interface) {
  rl.close();
  await closeBrowser();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
