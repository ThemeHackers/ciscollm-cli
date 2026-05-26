import chalk from 'chalk';
import ora from 'ora';

export const logger = {
    info: (msg: string) => console.log(chalk.blue('ℹ ') + msg),
    success: (msg: string) => console.log(chalk.green('✔ ') + chalk.bold(msg)),
    warn: (msg: string) => console.warn(chalk.yellow('⚠ ') + chalk.yellow(msg)),
    error: (msg: string) => console.error(chalk.red('✖ ') + chalk.red.bold(msg)),
    critical: (msg: string) => console.error(chalk.bgRed.white.bold(' CRITICAL ') + ' ' + chalk.red(msg)),
    heading: (msg: string) => console.log('\n' + chalk.cyan.bold.underline(msg) + '\n')
};

export function createSpinner(text: string): ora.Ora {
    return ora({
        text,
        color: 'cyan',
        spinner: 'dots'
    });
}
