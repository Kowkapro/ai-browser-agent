import chalk from 'chalk';

function timestamp(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

export const logger = {
  action(tool: string, params: string) {
    console.log(
      chalk.gray(`  ${timestamp()}`) +
      chalk.cyan(` > ${tool}`) +
      chalk.gray(` ${params}`)
    );
  },

  result(message: string) {
    console.log(
      chalk.gray(`  ${timestamp()}`) +
      chalk.green(` OK `) +
      chalk.white(message)
    );
  },

  error(message: string) {
    console.log(
      chalk.gray(`  ${timestamp()}`) +
      chalk.red(` ОШИБКА `) +
      chalk.white(message)
    );
  },

  info(message: string) {
    console.log(
      chalk.gray(`  ${timestamp()}`) +
      chalk.yellow(` ${message}`)
    );
  },

  agent(message: string) {
    console.log(chalk.magenta(`  Агент: `) + chalk.white(message));
  },

  plan(planText: string) {
    console.log('');
    console.log(chalk.bgBlue.white.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgBlue.white.bold('  ║              ПЛАН                    ║  '));
    console.log(chalk.bgBlue.white.bold('  ╚══════════════════════════════════════╝  '));
    for (const line of planText.split('\n')) {
      console.log(chalk.blue(`  ${line}`));
    }
    console.log('');
  },

  step(n: number, total: number) {
    console.log(chalk.gray(`\n  ─── Шаг ${n}/${total} ───`));
  },

  // === Status banners ===

  statusWorking() {
    console.log('');
    console.log(chalk.bgCyan.black.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgCyan.black.bold('  ║     АГЕНТ РАБОТАЕТ — НЕ ТРОГАЙТЕ    ║  '));
    console.log(chalk.bgCyan.black.bold('  ╚══════════════════════════════════════╝  '));
    console.log('');
  },

  statusWaitingUser(reason: string) {
    console.log('');
    console.log(chalk.bgYellow.black.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgYellow.black.bold('  ║   ТРЕБУЕТСЯ ВАШЕ ДЕЙСТВИЕ           ║  '));
    console.log(chalk.bgYellow.black.bold('  ╚══════════════════════════════════════╝  '));
    console.log(chalk.yellow(`  → ${reason}`));
    console.log(chalk.yellow('  → Нажмите Enter в терминале когда будете готовы.'));
    console.log('');
  },

  statusDone(summary: string, steps: number) {
    console.log('');
    console.log(chalk.bgGreen.black.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgGreen.black.bold('  ║         ЗАДАЧА ВЫПОЛНЕНА             ║  '));
    console.log(chalk.bgGreen.black.bold('  ╚══════════════════════════════════════╝  '));
    console.log(chalk.gray(`  Шагов: ${steps}`));
    // Print each line of the summary separately for readability
    for (const line of summary.split('\n')) {
      if (line.trim()) console.log(chalk.white(`  ${line}`));
    }
    console.log('');
  },

  statusFailed(summary: string, steps: number) {
    console.log('');
    console.log(chalk.bgRed.white.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgRed.white.bold('  ║       ЗАДАЧА НЕ ВЫПОЛНЕНА           ║  '));
    console.log(chalk.bgRed.white.bold('  ╚══════════════════════════════════════╝  '));
    console.log(chalk.gray(`  Шагов: ${steps}`));
    for (const line of summary.split('\n')) {
      if (line.trim()) console.log(chalk.white(`  ${line}`));
    }
    console.log('');
  },

  // === Multi-agent system ===

  coordinator(message: string) {
    console.log(chalk.blue(`  Координатор: `) + chalk.white(message));
  },

  coordinatorPlan(strategy: string, subtasks: { id: number; description: string }[]) {
    console.log('');
    console.log(chalk.bgBlue.white.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgBlue.white.bold('  ║         ПЛАН КООРДИНАТОРА           ║  '));
    console.log(chalk.bgBlue.white.bold('  ╚══════════════════════════════════════╝  '));
    console.log(chalk.blue(`  Стратегия: ${strategy}`));
    for (const s of subtasks) {
      console.log(chalk.blue(`  ${s.id}. ${s.description}`));
    }
    console.log('');
  },

  coordinatorSubtask(id: number, total: number, description: string) {
    console.log('');
    console.log(chalk.bgMagenta.white.bold(`  ═══ Подзадача ${id}/${total} ═══  `));
    console.log(chalk.magenta(`  ${description}`));
    console.log('');
  },

  worker(message: string) {
    console.log(chalk.cyan(`  Worker: `) + chalk.white(message));
  },

  workerStep(n: number, total: number) {
    console.log(chalk.gray(`\n  ─── Worker шаг ${n}/${total} ───`));
  },

  validator(message: string) {
    console.log(chalk.yellow(`  Валидатор: `) + chalk.white(message));
  },
};
