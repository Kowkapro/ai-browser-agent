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
    console.log(chalk.green(`  Шагов: ${steps}`));
    console.log(chalk.white(`  ${summary}`));
    console.log('');
  },

  statusFailed(summary: string, steps: number) {
    console.log('');
    console.log(chalk.bgRed.white.bold('  ╔══════════════════════════════════════╗  '));
    console.log(chalk.bgRed.white.bold('  ║       ЗАДАЧА НЕ ВЫПОЛНЕНА           ║  '));
    console.log(chalk.bgRed.white.bold('  ╚══════════════════════════════════════╝  '));
    console.log(chalk.red(`  Шагов: ${steps}`));
    console.log(chalk.white(`  ${summary}`));
    console.log('');
  },
};
