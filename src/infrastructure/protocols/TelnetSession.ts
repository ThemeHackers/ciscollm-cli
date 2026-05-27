import * as net from 'net';
import { BaseSession } from './BaseSession';
import { EventEmitter } from 'events';
import { PROMPT_REGEX, MORE_REGEX } from '../../shared/constants';
import chalk from 'chalk';

export class TelnetSession extends BaseSession {
    private socket: net.Socket | null = null;
    private buffer: string = '';
    private eventEmitter = new EventEmitter();

    constructor(
        private config: {
            host: string;
            port?: number;
            username?: string;
            password?: string;
        }
    ) {
        super();
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const port = this.config.port || 23;
            console.log(chalk.cyan(`❯ Connecting to telnet host ${this.config.host}:${port}...`));
            
            this.socket = net.createConnection({ host: this.config.host, port }, () => {
                console.log(chalk.green(`✔ TCP socket connection established.`));
            });

            this.socket.on('data', (data: Buffer) => this.handleRawData(data));

            this.socket.on('error', (err) => {
                reject(new Error(`Telnet Socket Error: ${err.message}`));
            });

            this.socket.on('close', () => {
                console.log(chalk.gray(`❯ Telnet socket connection closed.`));
            });

            
            let loginState: 'USER' | 'PASS' | 'PROMPT' | 'DONE' = 'USER';
            const connectTimeout = setTimeout(() => {
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error('Telnet connection attempt timed out waiting for credentials or prompt.'));
            }, 15000);

            const checkState = async () => {
                const lowerBuf = this.buffer.toLowerCase();
                
                if (loginState === 'USER' && (lowerBuf.includes('username:') || lowerBuf.includes('login:'))) {
                    console.log(chalk.cyan(`❯ Sending username...`));
                    this.socket?.write(`${this.config.username || ''}\r\n`);
                    this.buffer = '';
                    loginState = 'PASS';
                } else if (loginState === 'PASS' && lowerBuf.includes('password:')) {
                    console.log(chalk.cyan(`❯ Sending password...`));
                    this.socket?.write(`${this.config.password || ''}\r\n`);
                    this.buffer = '';
                    loginState = 'PROMPT';
                } else {
                    const match = PROMPT_REGEX.exec(this.buffer);
                    if (match) {
                        clearTimeout(connectTimeout);
                        this.eventEmitter.removeListener('stream_updated', checkState);
                        this.updateStateFromPrompt(match[1]);
                        console.log(chalk.green(`✔ Logged in successfully. Syncing terminal settings...`));
                        
                        
                        await this.execute('terminal length 0').catch(err => {
                            console.warn(chalk.yellow(`⚠ Failed to set terminal length 0: ${err.message}`));
                        });
                        resolve();
                    }
                }
            };

            this.eventEmitter.on('stream_updated', checkState);
        });
    }

    private handleRawData(data: Buffer): void {
        const cleaned: number[] = [];
        let i = 0;

        while (i < data.length) {
            const byte = data[i];
            
            if (byte === 255) { 
                const command = data[i + 1];
                if (command >= 251 && command <= 254) { 
                    const option = data[i + 2];
                    
                    const response = Buffer.from([255, command === 251 ? 254 : 252, option]); 
                    if (this.socket && !this.socket.destroyed) {
                        this.socket.write(response);
                    }
                    i += 3;
                } else if (command === 255) {
                    cleaned.push(255); 
                    i += 2;
                } else {
                    i += 2; 
                }
            } else {
                cleaned.push(byte);
                i++;
            }
        }

        if (cleaned.length > 0) {
            const chunk = Buffer.from(cleaned).toString('utf-8');
            this.buffer += chunk;

            
            if (MORE_REGEX.test(this.buffer)) {
                if (this.socket && !this.socket.destroyed) {
                    this.socket.write(' ');
                }
                this.buffer = this.buffer.replace(MORE_REGEX, '');
            }

            this.eventEmitter.emit('stream_updated');
        }
    }

    public async execute(command: string, timeoutMs: number = 15000): Promise<string> {
        const sock = this.socket;
        if (!sock || sock.destroyed) {
            throw new Error('Telnet socket is inactive. Cannot execute command.');
        }

        return new Promise((resolve, reject) => {
            this.buffer = ''; 
            
            const timeout = setTimeout(() => {
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error(`Telnet command execution timed out after ${timeoutMs}ms: "${command}"`));
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

            sock.write(`${command}\r\n`);
        });
    }

    public async disconnect(): Promise<void> {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        console.log(chalk.green(`✔ Telnet Session to ${this.config.host} disconnected cleanly.`));
    }
}
