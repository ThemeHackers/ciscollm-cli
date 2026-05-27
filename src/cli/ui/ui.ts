import chalk from 'chalk';
import ora from 'ora';

export const logger = {
    info: (msg: string) => console.log(chalk.cyan('ℹ ') + msg),
    success: (msg: string) => console.log(chalk.green('✔ ') + chalk.bold.green(msg)),
    warn: (msg: string) => console.warn(chalk.yellow('⚠ ') + chalk.yellow(msg)),
    error: (msg: string) => console.error(chalk.red('✖ ') + chalk.red.bold(msg)),
    critical: (msg: string) => {
        console.error('\n' + chalk.bgRed.black.bold(' ⚡ CRITICAL ERROR ') + ' ' + chalk.red.bold(msg) + '\n');
    },
    heading: (msg: string) => {
        const line = '━'.repeat(msg.length + 6);
        console.log('\n' + chalk.magenta.bold(`  ┏${line}┓`));
        console.log(chalk.magenta.bold(`  ┃  ${chalk.white.bold(msg)}  ┃`));
        console.log(chalk.magenta.bold(`  ┗${line}┛`) + '\n');
    },
    reasoning: (msg: string) => {
        const border = chalk.blue('│');
        console.log('\n' + chalk.blue('┌─── 🤖 Agent Reasoning Thought Process ───────────────────────'));
        msg.trim().split('\n').forEach(line => {
            console.log(`${border}  ${chalk.gray.italic(line)}`);
        });
        console.log(chalk.blue('└─────────────────────────────────────────────────────────────') + '\n');
    }
};

export function createSpinner(text: string): ora.Ora {
    return ora({
        text,
        color: 'cyan',
        spinner: 'dots'
    });
}
