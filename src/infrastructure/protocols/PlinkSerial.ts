import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { BaseSession } from './BaseSession';
import { EventEmitter } from 'events';
import { PROMPT_REGEX, MORE_REGEX } from '../../shared/constants';
import chalk from 'chalk';

export class PlinkSerialSession extends BaseSession {
    private process: ChildProcessWithoutNullStreams | null = null;
    private buffer: string = '';
    private eventEmitter = new EventEmitter();

    constructor(
        private comPort: string,
        private baudRate: number = 9600
    ) {
        super();
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = ['-serial', this.comPort, '-sercfg', `${this.baudRate},8,n,1,N`];
            
            console.log(chalk.dim(`[PlinkSerial]: Spawning plink.exe with serial port ${this.comPort}...`));
            this.process = spawn('plink.exe', args);
            this.process.stdin.setDefaultEncoding('utf-8');

            this.process.stdout.on('data', (data: Buffer) => this.handleData(data));
            this.process.stderr.on('data', (data: Buffer) => {
                console.error(chalk.dim(`[Plink Stderr]: ${data.toString()}`));
            });

            this.process.on('error', async (err) => {
                const available = await PlinkSerialSession.listAvailableComPorts();
                const portMsg = available.length > 0 
                    ? `Active COM ports detected: ${available.join(', ')}`
                    : 'No active COM ports detected on the system.';
                reject(new Error(`Failed to start plink process: ${err.message}. ${portMsg}`));
            });

            this.process.on('close', (code) => {
                console.log(chalk.dim(`[PlinkSerial]: plink process closed with code ${code}`));
            });
            
            
            setTimeout(async () => {
                try {
                    const match = PROMPT_REGEX.exec(this.buffer);
                    if (match) {
                        this.updateStateFromPrompt(match[1]);
                        console.log(chalk.dim(`[PlinkSerial]: Sending 'terminal length 0' to disable pagination...`));
                        await this.execute('terminal length 0').catch(err => {
                            console.warn(chalk.dim(`[PlinkSerial Warning]: Failed to set terminal length 0: ${err.message}`));
                        });
                        resolve();
                    } else {
                        const available = await PlinkSerialSession.listAvailableComPorts();
                        const portMsg = available.length > 0 
                            ? `Active COM ports detected: ${available.join(', ')}`
                            : 'No active COM ports detected on the system.';
                        reject(new Error(`Failed to sync serial prompt on ${this.comPort}. ${portMsg}`));
                    }
                } catch (e: any) {
                    const available = await PlinkSerialSession.listAvailableComPorts();
                    const portMsg = available.length > 0 
                        ? `Active COM ports detected: ${available.join(', ')}`
                        : 'No active COM ports detected on the system.';
                    reject(new Error(`Connection synchronization failed: ${e.message}. ${portMsg}`));
                }
            }, 3000);
        });
    }

    private handleData(data: Buffer): void {
        const chunk = data.toString('utf-8');
        this.buffer += chunk;

        
        if (MORE_REGEX.test(this.buffer)) {
            if (this.process && !this.process.killed) {
                this.process.stdin.write(' ');
            }
            this.buffer = this.buffer.replace(MORE_REGEX, '');
        }

        this.eventEmitter.emit('stream_updated');
    }

    public async execute(command: string, timeoutMs: number = 15000): Promise<string> {
        const proc = this.process;
        if (!proc || proc.killed) {
            throw new Error('Process is inactive. Cannot execute command.');
        }

        return new Promise((resolve, reject) => {
            this.buffer = ''; 
            
            const timeout = setTimeout(() => {
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error(`Command execution timed out after ${timeoutMs}ms: "${command}"`));
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

            
            proc.stdin.write(`${command}\r\n`);
        });
    }

    public async disconnect(): Promise<void> {
        if (this.process) {
            console.log(chalk.dim('[PlinkSerial]: Detaching sub-process pipelines...'));
            this.process.kill('SIGTERM');
            this.process = null;
        }
    }

    
    public getProcess(): ChildProcessWithoutNullStreams | null {
        return this.process;
    }

    
    public static async listAvailableComPorts(): Promise<string[]> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec('powershell -Command "[System.IO.Ports.SerialPort]::GetPortNames()"', (error: any, stdout: string) => {
                if (error) {
                    resolve([]);
                    return;
                }
                const ports = stdout.split(/\r?\n/).map(p => p.trim()).filter(p => p.length > 0);
                resolve(ports);
            });
        });
    }
}
