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

                    
                    setTimeout(async () => {
                        const match = PROMPT_REGEX.exec(this.buffer);
                        if (match) {
                            this.updateStateFromPrompt(match[1]);
                        }
                        console.log(chalk.cyan(`❯ Disabling pagination with 'terminal length 0'...`));
                        await this.execute('terminal length 0').catch(err => {
                            console.warn(chalk.yellow(`⚠ Failed to set terminal length 0: ${err.message}`));
                        });
                        resolve();
                    }, 2000);
                });
            });

            this.client.on('error', (err) => {
                reject(new Error(`SSH Connection Error: ${err.message}`));
            });

            this.client.connect({
                host: this.config.host,
                port: this.config.port || 22,
                username: this.config.username,
                password: this.config.password,
                privateKey: this.config.privateKey,
                readyTimeout: 15000
            });
        });
    }

    private handleData(data: Buffer): void {
        const chunk = data.toString('utf-8');
        this.buffer += chunk;

        if (MORE_REGEX.test(this.buffer)) {
            if (this.channel) {
                this.channel.write(' ');
            }
            this.buffer = this.buffer.replace(MORE_REGEX, '');
        }

        this.eventEmitter.emit('stream_updated');
    }

    public async execute(command: string, timeoutMs: number = 15000): Promise<string> {
        const chan = this.channel;
        if (!chan) {
            throw new Error('SSH channel is inactive. Cannot execute command.');
        }

        return new Promise((resolve, reject) => {
            this.buffer = ''; 
            
            const timeout = setTimeout(() => {
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error(`SSH Command execution timed out after ${timeoutMs}ms: "${command}"`));
            }, timeoutMs);

            this.eventEmitter.on('stream_updated', () => {
                const match = PROMPT_REGEX.exec(this.buffer);
                if (match) {
                    clearTimeout(timeout);
                    this.eventEmitter.removeAllListeners('stream_updated');
                    
                    const fullOutput = this.buffer;
                    this.updateStateFromPrompt(match[1]);
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
