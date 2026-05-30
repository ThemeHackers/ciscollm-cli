import chalk from 'chalk';
import ora from 'ora';

const stripAnsi = (str: string) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

function applyHorizontalGradient(line: string): string {
    const colors = [
        '#00f2fe', 
        '#4facfe', 
        '#7f00ff', 
        '#e100ff', 
        '#ff007f'  
    ];
    let result = '';
    const len = line.length;
    for (let i = 0; i < len; i++) {
        const ratio = i / len;
        const colorIndex = Math.min(Math.floor(ratio * colors.length), colors.length - 1);
        result += chalk.hex(colors[colorIndex])(line[i]);
    }
    return result;
}

export function getTerminalWidth(): number {
    const cols = process.stdout.columns || 80;
    return Math.min(100, Math.max(60, cols));
}

export function wrapText(text: string, maxWidth: number): string[] {
    const lines = text.split(/\r?\n/);
    const result: string[] = [];

    for (const line of lines) {
        if (line.length <= maxWidth) {
            result.push(line);
            continue;
        }

        const words = line.split(' ');
        let currentLine = '';

        for (const word of words) {
            let processedWord = word;
            while (processedWord.length > maxWidth) {
                if (currentLine) {
                    result.push(currentLine);
                    currentLine = '';
                }
                result.push(processedWord.slice(0, maxWidth));
                processedWord = processedWord.slice(maxWidth);
            }

            if (currentLine.length === 0) {
                currentLine = processedWord;
            } else if (currentLine.length + 1 + processedWord.length <= maxWidth) {
                currentLine += ' ' + processedWord;
            } else {
                result.push(currentLine);
                currentLine = processedWord;
            }
        }
        if (currentLine) {
            result.push(currentLine);
        }
    }

    return result;
}

export class StreamWordWrapper {
    private currentLineLength = 0;
    private wordBuffer = '';
    private border = chalk.blue('│');

    constructor(private maxTextWidth: number) {}

    public write(chunk: string): void {
        for (let i = 0; i < chunk.length; i++) {
            const char = chunk[i];
            if (char === '\n') {
                this.flushWord();
                process.stdout.write('\n' + this.border + '  ');
                this.currentLineLength = 0;
            } else if (char === ' ' || char === '\t') {
                this.flushWord();
                if (this.currentLineLength + 1 > this.maxTextWidth) {
                    process.stdout.write('\n' + this.border + '  ');
                    this.currentLineLength = 0;
                } else {
                    process.stdout.write(char);
                    this.currentLineLength += 1;
                }
            } else {
                this.wordBuffer += char;
            }
        }
    }

    public flush(): void {
        this.flushWord();
    }

    private flushWord(): void {
        if (this.wordBuffer.length === 0) return;

        if (this.currentLineLength + this.wordBuffer.length > this.maxTextWidth) {
            if (this.currentLineLength > 0) {
                process.stdout.write('\n' + this.border + '  ');
                this.currentLineLength = 0;
            }
            
            let word = this.wordBuffer;
            while (word.length > this.maxTextWidth) {
                const part = word.slice(0, this.maxTextWidth);
                process.stdout.write(chalk.gray.italic(part));
                process.stdout.write('\n' + this.border + '  ');
                word = word.slice(this.maxTextWidth);
            }
            process.stdout.write(chalk.gray.italic(word));
            this.currentLineLength = word.length;
        } else {
            process.stdout.write(chalk.gray.italic(this.wordBuffer));
            this.currentLineLength += this.wordBuffer.length;
        }
        this.wordBuffer = '';
    }
}

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
        const width = getTerminalWidth();
        const border = chalk.blue('│');
        const title = '┌─── 🤖 Agent Reasoning Thought Process ';
        const topBorder = chalk.blue(title + '─'.repeat(Math.max(0, width - title.length)));
        const bottomBorder = chalk.blue('└' + '─'.repeat(Math.max(0, width - 1)));

        console.log('\n' + topBorder);
        const wrappedLines = wrapText(msg.trim(), width - 4);
        wrappedLines.forEach(line => {
            console.log(`${border}  ${chalk.gray.italic(line)}`);
        });
        console.log(bottomBorder + '\n');
    },
    banner: () => {
        const logoLines = [
            " >  ██████  ██  ███████  ██████  ██████  ██      ██      ███    ███ ",
            "   ██       ██ ██       ██      ██    ██ ██      ██      ████  ████ ",
            "   ██       ██ ███████  ██      ██    ██ ██      ██      ██ ████ ██ ",
            "   ██       ██      ██  ██      ██    ██ ██      ██      ██  ██  ██ ",
            "    ██████  ██ ███████   ██████  ██████  ███████ ███████ ██      ██ "
        ];

        console.log('');
        for (const line of logoLines) {
            console.log(applyHorizontalGradient(line));
        }
        console.log('');
        
        console.log(chalk.white('Tips for getting started:'));
        console.log(chalk.gray('1. Define configuration goals clearly.'));
        console.log(chalk.gray('2. Ensure hardware serial or network connections are active.'));
        console.log(chalk.gray('3. Dangerous commands will require human authorization.'));
        console.log('');
    },
    modelStatus: (model: string) => {
        console.log('\n' + chalk.gray.italic(`  Responding with ${model}`));
    },
    diamond: (msg: string) => {
        console.log(chalk.bold.magenta('✦ ') + chalk.white(msg));
    },
    toolBox: (title: string, content: string, success: boolean = true) => {
        const width = getTerminalWidth();
        const border = chalk.gray('│');
        const top = chalk.gray('┌' + '─'.repeat(width - 2) + '┐');
        const bottom = chalk.gray('└' + '─'.repeat(width - 2) + '┘');
        
        console.log(top);
        const icon = success ? chalk.green('✓') : chalk.red('✖');
        const maxWidth = width - 6;
        const wrappedTitleLines = wrapText(title, maxWidth);
        
        const firstTitle = wrappedTitleLines[0] || '';
        const titleText = `  ${icon} ${chalk.white.bold(firstTitle)}`;
        const cleanTitle = stripAnsi(titleText);
        const paddedTitle = titleText + ' '.repeat(Math.max(0, width - 2 - cleanTitle.length));
        console.log(`${border}${paddedTitle}${border}`);
        
        for (let i = 1; i < wrappedTitleLines.length; i++) {
            const extraTitleLine = `    ${chalk.white.bold(wrappedTitleLines[i])}`;
            const cleanExtra = stripAnsi(extraTitleLine);
            const paddedExtra = extraTitleLine + ' '.repeat(Math.max(0, width - 2 - cleanExtra.length));
            console.log(`${border}${paddedExtra}${border}`);
        }
        
        console.log(`${border}${' '.repeat(width - 2)}${border}`);

        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const wrappedLines = wrapText(line, maxWidth);
            for (const wrappedLine of wrappedLines) {
                const cleanLine = stripAnsi(wrappedLine);
                const paddedLine = `  ${wrappedLine}` + ' '.repeat(Math.max(0, width - 2 - 2 - cleanLine.length));
                console.log(`${border}${paddedLine}${border}`);
            }
        }
        console.log(bottom);
    }
};

export function createSpinner(text: string): ora.Ora {
    return ora({
        text,
        color: 'cyan',
        spinner: 'dots'
    });
}
