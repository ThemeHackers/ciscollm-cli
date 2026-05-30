import { Client, ClientChannel } from 'ssh2';
import { BaseSession } from './BaseSession';
import { EventEmitter } from 'events';
import { PROMPT_REGEX, MORE_REGEX } from '../../shared/constants';
import chalk from 'chalk';

export class SshSession extends BaseSession {
    private client: Client | null = null;
    private channel: ClientChannel | null = null;
    private buffer: string = '';
    private eventEmitter = new EventEmitter();

    constructor(
        private config: {
            host: string;
            port?: number;
            username: string;
            password?: string;
            privateKey?: string;
        }
    ) {
        super();
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client = new Client();
            
            this.client.on('ready', () => {
                console.log(chalk.cyan(`❯ SSH connection ready to host ${this.config.host}. Launching interactive shell...`));
                this.client!.shell((err, stream) => {
                    if (err) {
                        return reject(new Error(`Failed to open SSH shell channel: ${err.message}`));
                    }
                    
                    this.channel = stream;
                    this.channel.on('data', (data: Buffer) => this.handleData(data));
                    
                    this.channel.on('close', () => {
                        console.log(chalk.gray(`❯ SSH channel closed.`));
                    });

                    const onStreamUpdate = async () => {
                        const match = PROMPT_REGEX.exec(this.buffer);
                        if (match) {
                            this.eventEmitter.removeListener('stream_updated', onStreamUpdate);
                            clearTimeout(connectTimeout);
                            this.updateStateFromPrompt(match[1]);
                            console.log(chalk.cyan(`❯ Disabling pagination with standard commands...`));
                            const paginationCommands = [
                                'terminal length 0',
                                'screen-length 0 temporary',
                                'set cli screen-length 0'
                            ];
                            for (const cmd of paginationCommands) {
                                await this.execute(cmd).catch(() => {});
                            }
                            resolve();
                        }
                    };

                    const connectTimeout = setTimeout(() => {
                        this.eventEmitter.removeListener('stream_updated', onStreamUpdate);
                        reject(new Error(`SSH prompt detection timed out after 15000ms. Received: ${this.buffer}`));
                    }, 15000);

                    this.eventEmitter.on('stream_updated', onStreamUpdate);
                    onStreamUpdate();
                });
            });

            this.client.on('error', (err) => {
                reject(new Error(`SSH Connection Error: ${err.message}`));
            });

            this.client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
                if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
                    finish([this.config.password || '']);
                } else {
                    finish([]);
                }
            });

            this.client.connect({
                host: this.config.host,
                port: this.config.port || 22,
                username: this.config.username,
                password: this.config.password,
                privateKey: this.config.privateKey,
                readyTimeout: 15000,
                tryKeyboard: true
            });
        });
    }

    private cleanBuffer(): void {
        const globalMoreRegex = new RegExp(MORE_REGEX.source, 'gi');
        if (globalMoreRegex.test(this.buffer)) {
            if (this.channel) {
                this.channel.write(' ');
            }
            this.buffer = this.buffer.replace(globalMoreRegex, '');
        }
        this.buffer = this.buffer.replace(/[\x08\b]+/g, '');
    }

    private extractSyslogs(): void {
        const lines = this.buffer.split(/\r?\n/);
        if (lines.length <= 1) return;

        const completedLines = lines.slice(0, -1);
        const lastLine = lines[lines.length - 1];
        const remainingLines: string[] = [];

        for (const line of completedLines) {
            if (/%[A-Za-z0-9_]+-[0-7]-[A-Za-z0-9_]+:/.test(line)) {
                console.log(chalk.yellow(`[Syslog Notification] ${line}`));
                this.emitNotification(line);
            } else {
                remainingLines.push(line);
            }
        }

        this.buffer = remainingLines.join('\n') + (remainingLines.length > 0 ? '\n' : '') + lastLine;
    }

    private handleData(data: Buffer): void {
        const chunk = data.toString('utf-8');
        this.buffer += chunk;

        this.cleanBuffer();
        this.extractSyslogs();

        this.eventEmitter.emit('stream_updated');
    }

    public async execute(command: string, timeoutMs: number = 15000): Promise<string> {
        const chan = this.channel;
        if (!chan) {
            throw new Error('SSH channel is inactive. Cannot execute command.');
        }

        return new Promise((resolve, reject) => {
            const commandStartIndex = this.buffer.length;
            
            const timeout = setTimeout(() => {
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error(`SSH Command execution timed out after ${timeoutMs}ms: "${command}"`));
            }, timeoutMs);

            this.eventEmitter.on('stream_updated', () => {
                const commandOutput = this.buffer.slice(commandStartIndex);
                const match = PROMPT_REGEX.exec(commandOutput);
                if (match) {
                    clearTimeout(timeout);
                    this.eventEmitter.removeAllListeners('stream_updated');
                    
                    const fullOutput = commandOutput;
                    this.updateStateFromPrompt(match[1]);

                  
                    const matchIndex = commandOutput.indexOf(match[0]);
                    const newStart = commandStartIndex + matchIndex + match[0].length;
                    this.buffer = this.buffer.slice(newStart);

                    resolve(fullOutput);
                }
            });

            chan.write(`${command}\r\n`);
        });
    }

    public async disconnect(): Promise<void> {
        if (this.channel) {
            this.channel.end();
            this.channel = null;
        }
        if (this.client) {
            this.client.end();
            this.client = null;
        }
        console.log(chalk.green(`✔ SSH Session to ${this.config.host} disconnected cleanly.`));
    }
}
