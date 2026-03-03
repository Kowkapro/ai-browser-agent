import chalk from 'chalk';

function timestamp(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

export const logger = {
  action(tool: string, params: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.cyan(` [ACTION] `) +
      chalk.white(`${tool}`) +
      chalk.gray(` ${params}`)
    );
  },

  result(message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.green(` [RESULT] `) +
      chalk.white(message)
    );
  },

  error(message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.red(` [ERROR]  `) +
      chalk.white(message)
    );
  },

  info(message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.yellow(` [INFO]   `) +
      chalk.white(message)
    );
  },

  agent(message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.magenta(` [AGENT]  `) +
      chalk.white(message)
    );
  },

  user(message: string) {
    console.log(
      chalk.gray(`[${timestamp()}]`) +
      chalk.blue(` [USER]   `) +
      chalk.white(message)
    );
  },

  step(n: number, total: number) {
    console.log(
      chalk.gray(`\n--- Step ${n}/${total} ---`)
    );
  },
};
