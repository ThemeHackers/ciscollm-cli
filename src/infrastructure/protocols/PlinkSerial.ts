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

    public static async ensurePlinkExecutable(): Promise<string> {
        const isWindows = process.platform === 'win32';
        if (!isWindows) {
            return 'plink';
        }

        const localCwdPath = path.resolve(process.cwd(), 'plink.exe');
        const projectRootPath = path.resolve(__dirname, '..', '..', '..', 'plink.exe');
        const nextToExecPath = path.resolve(__dirname, 'plink.exe');

        let cmdPath = 'plink.exe';
        if (fs.existsSync(localCwdPath)) {
            cmdPath = localCwdPath;
        } else if (fs.existsSync(projectRootPath)) {
            cmdPath = projectRootPath;
        } else if (fs.existsSync(nextToExecPath)) {
            cmdPath = nextToExecPath;
        } else {
            const arch = process.arch;
            let downloadUrl = 'https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe';
            
            if (arch === 'arm64') {
                downloadUrl = 'https://the.earth.li/~sgtatham/putty/latest/wa64/plink.exe';
            } else if (arch === 'ia32') {
                downloadUrl = 'https://the.earth.li/~sgtatham/putty/latest/w32/plink.exe';
            }

            const targetPath = projectRootPath;
            const { createSpinner } = require('../../cli/ui/ui');
            const spinner = createSpinner(`[Plink Installer] plink.exe not found. Downloading PuTTY plink.exe for ${arch} architecture...`).start();

            try {
                const axios = require('axios');
                const writer = fs.createWriteStream(targetPath);
                const response = await axios({
                    url: downloadUrl,
                    method: 'GET',
                    responseType: 'stream'
                });
                response.data.pipe(writer);
                await new Promise<void>((resolveWrite, rejectWrite) => {
                    writer.on('finish', () => resolveWrite());
                    writer.on('error', (err) => rejectWrite(err));
                });
                spinner.succeed(`[Plink Installer] plink.exe successfully downloaded to ${targetPath}`);
                cmdPath = targetPath;
            } catch (err: any) {
                spinner.fail(`[Plink Installer] Failed to download plink.exe: ${err.message}`);
                throw new Error(`Failed to download required PuTTY plink.exe serial interface: ${err.message}`);
            }
        }

        try {
            const { execSync } = require('child_process');
            const stdout = execSync(`"${cmdPath}" -V`, { encoding: 'utf8', stdio: 'pipe' });
            console.log(chalk.cyan(`[Plink Version Check] Verified plink.exe: ${stdout.trim().split(/\r?\n/)[0]}`));
        } catch (err: any) {
            throw new Error(`plink.exe exists at ${cmdPath} but failed to run or verify version: ${err.message}`);
        }

        return cmdPath;
    }

    public async connect(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let cmd: string;
            let args: string[];

            const isWindows = process.platform === 'win32';
            if (isWindows) {
                args = ['-batch', '-serial', this.comPort, '-sercfg', `${this.baudRate},8,n,1,N`];
                try {
                    cmd = await PlinkSerialSession.ensurePlinkExecutable();
                } catch (err: any) {
                    reject(err);
                    return;
                }
            } else {
                const isCommandAvailable = (commandName: string): boolean => {
                    try {
                        const { execSync } = require('child_process');
                        execSync(`which ${commandName}`, { stdio: 'ignore' });
                        return true;
                    } catch {
                        return false;
                    }
                };

                if (isCommandAvailable('picocom')) {
                    cmd = 'picocom';
                    args = ['-b', String(this.baudRate), this.comPort];
                } else if (isCommandAvailable('socat')) {
                    cmd = 'socat';
                    args = ['-', `${this.comPort},b${this.baudRate},raw,echo=0`];
                } else if (isCommandAvailable('screen')) {
                    cmd = 'screen';
                    args = [this.comPort, String(this.baudRate)];
                } else if (isCommandAvailable('plink')) {
                    cmd = 'plink';
                    args = ['-batch', '-serial', this.comPort, '-sercfg', `${this.baudRate},8,n,1,N`];
                } else {
                    let plinkPath = 'plink';
                    const localCwdPath = path.resolve(process.cwd(), 'plink');
                    const projectRootPath = path.resolve(__dirname, '..', '..', '..', 'plink');
                    const nextToExecPath = path.resolve(__dirname, 'plink');

                    if (fs.existsSync(localCwdPath)) {
                        plinkPath = localCwdPath;
                    } else if (fs.existsSync(projectRootPath)) {
                        plinkPath = projectRootPath;
                    } else if (fs.existsSync(nextToExecPath)) {
                        plinkPath = nextToExecPath;
                    } else {
                        reject(new Error(`No serial communication utility found. Please install one of: picocom, socat, screen, or plink.`));
                        return;
                    }
                    cmd = plinkPath;
                    args = ['-batch', '-serial', this.comPort, '-sercfg', `${this.baudRate},8,n,1,N`];
                }
            }

            console.log(chalk.cyan(`❯ Spawning connection via serial port ${this.comPort} using ${cmd}...`));
            this.process = spawn(cmd, args);
            this.process.stdin.setDefaultEncoding('utf-8');

            let finished = false;

            const cleanupAndReject = async (errMessage: string) => {
                if (finished) return;
                finished = true;
                clearTimeout(connectTimer);
                this.eventEmitter.removeListener('stream_updated', onStreamUpdate);
                if (this.process) {
                    this.process.kill('SIGKILL');
                    this.process = null;
                }
                const available = await PlinkSerialSession.listAvailableComPorts();
                const portMsg = available.length > 0 
                    ? `Active COM ports detected: ${available.join(', ')}`
                    : 'No active COM ports detected on the system.';
                reject(new Error(`${errMessage}. ${portMsg}`));
            };

            this.process.stdin.on('error', (err) => {
                console.error(chalk.red(`[!] Stdin Error: ${err.message}`));
            });

            this.process.stdout.on('data', (data: Buffer) => this.handleData(data));
            this.process.stderr.on('data', (data: Buffer) => {
                console.error(chalk.red(`[!] Stderr: ${data.toString()}`));
            });

            this.process.on('error', async (err) => {
                await cleanupAndReject(`Failed to start plink process: ${err.message}`);
            });

            this.process.on('close', async (code) => {
                console.log(chalk.gray(`❯ Plink process closed with code ${code}`));
                await cleanupAndReject(`plink process exited prematurely with code ${code}`);
            });
            
            const onStreamUpdate = async () => {
                const match = PROMPT_REGEX.exec(this.buffer);
                if (match) {
                    this.eventEmitter.removeListener('stream_updated', onStreamUpdate);
                    clearTimeout(connectTimer);
                    this.updateStateFromPrompt(match[1]);
                    console.log(chalk.cyan(`❯ Disabling pagination with standard commands...`));
                    const paginationCommands = [
                        'terminal length 0',
                        'terminal width 0',
                        'terminal width 511',
                        'screen-length 0 temporary',
                        'set cli screen-length 0'
                    ];
                    for (const cmd of paginationCommands) {
                        await this.execute(cmd).catch(() => {});
                    }
                    finished = true;
                    if (this.process) {
                        this.process.removeAllListeners('close');
                        this.process.on('close', (code) => {
                            console.log(chalk.gray(`❯ Plink process closed with code ${code}`));
                        });
                    }
                    resolve();
                }
            };

            const connectTimer = setTimeout(async () => {
                await cleanupAndReject(`Failed to sync serial prompt on ${this.comPort} due to timeout.`);
            }, 15000);

            this.eventEmitter.on('stream_updated', onStreamUpdate);
            onStreamUpdate();
        });
    }

    private cleanBuffer(): void {
        const globalMoreRegex = new RegExp(MORE_REGEX.source, 'gi');
        if (globalMoreRegex.test(this.buffer)) {
            if (this.process && !this.process.killed && this.process.stdin.writable) {
                this.process.stdin.write(' ');
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
        const proc = this.process;
        if (!proc || proc.killed) {
            throw new Error('Process is inactive. Cannot execute command.');
        }

        return new Promise((resolve, reject) => {
            const commandStartIndex = this.buffer.length;
            
            const timeout = setTimeout(async () => {
                this.eventEmitter.removeAllListeners('stream_updated');
                try {
                    if (proc.stdin && proc.stdin.writable) {
                        proc.stdin.write('\r\n');
                    }
                    await new Promise(r => setTimeout(r, 500));
                    this.buffer = '';
                } catch {}
                reject(new Error(`Command execution timed out after ${timeoutMs}ms: "${command}"`));
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
            const proc = this.process;
            this.process = null;
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (!proc.killed) {
                    proc.kill('SIGKILL');
                }
            }, 500);
        }
    }

    public getProcess(): ChildProcessWithoutNullStreams | null {
        return this.process;
    }

    public static async listAvailableComPorts(): Promise<string[]> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            const isWindows = process.platform === 'win32';
            
            if (!isWindows) {
                try {
                    const devFiles = fs.readdirSync('/dev');
                    const ports: string[] = [];
                    const isMac = process.platform === 'darwin';
                    
                    for (const file of devFiles) {
                        const fullPath = path.join('/dev', file);
                        if (isMac) {
                            if (file.startsWith('cu.') || (file.startsWith('tty.') && (
                                file.includes('usb') || 
                                file.includes('serial') || 
                                file.includes('uart') || 
                                file.includes('modem') || 
                                file.includes('Bluetooth')
                            ))) {
                                ports.push(fullPath);
                            }
                        } else {
                            if (file.startsWith('ttyUSB') || file.startsWith('ttyACM') || file.startsWith('ttyS')) {
                                ports.push(fullPath);
                            }
                        }
                    }
                    resolve(ports.sort());
                } catch (err) {
                    resolve([]);
                }
                return;
            }


            const psCmd = `powershell -Command "Get-CimInstance Win32_PnPEntity | Where-Object Name -like '*(COM*' | Select-Object -ExpandProperty Name"`;
            exec(psCmd, { timeout: 4000 }, (psErr: any, psStdout: string) => {
                if (!psErr && psStdout.trim()) {
                    const ports: string[] = [];
                    const lines = psStdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        const match = /\((COM\d+)\)/i.exec(line);
                        if (match) {
                            const portNumber = match[1].toUpperCase();
                            const friendlyName = line.replace(/\s*\(COM\d+\)\s*/i, '').trim();
                            ports.push(`${portNumber} (${friendlyName})`);
                        }
                    }
                    if (ports.length > 0) {
                       
                        ports.sort((a, b) => {
                            const numA = parseInt((/COM(\d+)/i.exec(a) || [])[1] || '0', 10);
                            const numB = parseInt((/COM(\d+)/i.exec(b) || [])[1] || '0', 10);
                            return numA - numB;
                        });
                        resolve(ports);
                        return;
                    }
                }

               
                const regCmd = 'reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM';
                exec(regCmd, { timeout: 3000 }, (regErr: any, regStdout: string) => {
                    if (regErr) {
                        resolve([]);
                        return;
                    }
                    const ports: string[] = [];
                    const lines = regStdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                    for (const line of lines) {
                        const match = /\b(COM\d+)\b/i.exec(line);
                        if (match) {
                            ports.push(match[1].toUpperCase());
                        }
                    }

                    ports.sort((a, b) => {
                        const numA = parseInt((/COM(\d+)/i.exec(a) || [])[1] || '0', 10);
                        const numB = parseInt((/COM(\d+)/i.exec(b) || [])[1] || '0', 10);
                        return numA - numB;
                    });
                    resolve(ports);
                });
            });
        });
    }
}
