import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { BaseSession } from './BaseSession';
import { EventEmitter } from 'events';
import { PROMPT_REGEX, MORE_REGEX } from '../../shared/constants';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';

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
            const args = ['-batch', '-serial', this.comPort, '-sercfg', `${this.baudRate},8,n,1,N`];
            
            let plinkPath = 'plink.exe';
            const localCwdPath = path.resolve(process.cwd(), 'plink.exe');
            const projectRootPath = path.resolve(__dirname, '..', '..', '..', 'plink.exe');
            const nextToExecPath = path.resolve(__dirname, 'plink.exe');

            if (fs.existsSync(localCwdPath)) {
                plinkPath = localCwdPath;
            } else if (fs.existsSync(projectRootPath)) {
                plinkPath = projectRootPath;
            } else if (fs.existsSync(nextToExecPath)) {
                plinkPath = nextToExecPath;
            }

            console.log(chalk.cyan(`❯ Spawning connection via serial port ${this.comPort}...`));
            this.process = spawn(plinkPath, args);
            this.process.stdin.setDefaultEncoding('utf-8');

            let finished = false;

            const cleanupAndReject = async (errMessage: string) => {
                if (finished) return;
                finished = true;
                clearTimeout(connectTimer);
                const available = await PlinkSerialSession.listAvailableComPorts();
                const portMsg = available.length > 0 
                    ? `Active COM ports detected: ${available.join(', ')}`
                    : 'No active COM ports detected on the system.';
                reject(new Error(`${errMessage}. ${portMsg}`));
            };

            this.process.stdin.on('error', (err) => {
                console.error(chalk.red(`⚠ Stdin Error: ${err.message}`));
            });

            this.process.stdout.on('data', (data: Buffer) => this.handleData(data));
            this.process.stderr.on('data', (data: Buffer) => {
                console.error(chalk.red(`⚠ Stderr: ${data.toString()}`));
            });

            this.process.on('error', async (err) => {
                await cleanupAndReject(`Failed to start plink process: ${err.message}`);
            });

            this.process.on('close', async (code) => {
                console.log(chalk.gray(`❯ Plink process closed with code ${code}`));
                await cleanupAndReject(`plink process exited prematurely with code ${code}`);
            });
            
            const connectTimer = setTimeout(async () => {
                try {
                    const match = PROMPT_REGEX.exec(this.buffer);
                    if (match) {
                        this.updateStateFromPrompt(match[1]);
                        console.log(chalk.cyan(`❯ Disabling pagination with 'terminal length 0'...`));
                        await this.execute('terminal length 0').catch(err => {
                            console.warn(chalk.yellow(`⚠ Failed to set terminal length 0: ${err.message}`));
                        });
                        finished = true;
                        this.process?.removeAllListeners('close');
                        this.process?.on('close', (code) => {
                            console.log(chalk.gray(`❯ Plink process closed with code ${code}`));
                        });
                        resolve();
                    } else {
                        await cleanupAndReject(`Failed to sync serial prompt on ${this.comPort}`);
                    }
                } catch (e: any) {
                    await cleanupAndReject(`Connection synchronization failed: ${e.message}`);
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

            if (!proc.stdin || !proc.stdin.writable) {
                clearTimeout(timeout);
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error('Process stdin is not writable. Connection might be closed.'));
                return;
            }

            try {
                proc.stdin.write(`${command}\r\n`, (err) => {
                    if (err) {
                        clearTimeout(timeout);
                        this.eventEmitter.removeAllListeners('stream_updated');
                        reject(new Error(`Failed to write command to stdin: ${err.message}`));
                    }
                });
            } catch (writeErr: any) {
                clearTimeout(timeout);
                this.eventEmitter.removeAllListeners('stream_updated');
                reject(new Error(`Exception writing to process stdin: ${writeErr.message}`));
            }
        });
    }

    public async disconnect(): Promise<void> {
        if (this.process) {
            console.log(chalk.gray(`❯ Detaching sub-process pipelines...`));
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
            const cmd = 'powershell -Command "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Caption -match \'USB.*Serial|USB-to-Serial|Prolific|CH340|FTDI|Silicon Labs|CP210\' } | Select-Object -ExpandProperty Caption"';
            exec(cmd, (error: any, stdout: string) => {
                if (error) {
                    resolve([]);
                    return;
                }
                const ports: string[] = [];
                const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                for (const line of lines) {
                    const match = /\((COM\d+)\)/i.exec(line);
                    if (match) {
                        ports.push(match[1]);
                    }
                }
                resolve(ports);
            });
        });
    }
}
