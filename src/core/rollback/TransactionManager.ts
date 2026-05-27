import { BaseSession } from '../../infrastructure/protocols/BaseSession';
import chalk from 'chalk';

export class TransactionManager {
    private configChangeLog: string[] = [];
    private mutationsWithContext: Array<{ command: string; contextStack: string[] }> = [];
    private contextStack: string[] = [];
    private targetInterface: string | null = null;
    private backupCreated = false;
    private readonly backupFilename = 'flash:backup-agent.cfg';

    public async initializeBackup(session: BaseSession): Promise<void> {
        const state = session.getState();
        
        if (state.currentMode === 'USER_EXEC') {
            console.log(chalk.cyan('❯ Elevating to privileged mode for backup...'));
            await session.execute('enable');
        }

        try {
            console.log(chalk.cyan('❯ Checking flash storage reachability...'));
            const flashCheck = await session.execute('dir flash:');
            if (flashCheck.includes('% Invalid') || flashCheck.includes('No such file') || flashCheck.includes('Error')) {
                console.warn(chalk.yellow('⚠ Flash storage is not accessible or not found. Skipping backup creation.'));
                return;
            }

            console.log(chalk.cyan('❯ Creating device running-config backup on flash...'));
            const rawOutput = await session.execute(`copy running-config ${this.backupFilename}`);
            
            if (rawOutput.includes('Destination filename') || rawOutput.includes('?')) {
                const confirmOutput = await session.execute('');
                if (confirmOutput.includes('copied') || confirmOutput.includes('OK')) {
                    this.backupCreated = true;
                    console.log(chalk.green('✔ Running configuration backup successfully created.'));
                } else {
                    console.warn(chalk.yellow('⚠ Backup confirmation response did not confirm copy completion.'));
                }
            } else if (rawOutput.includes('copied') || rawOutput.includes('OK')) {
                this.backupCreated = true;
                console.log(chalk.green('✔ Running configuration backup successfully created.'));
            } else {
                console.warn(chalk.yellow('⚠ Failed to backup running-config. Flash may be missing or read-only.'));
            }
        } catch (err: any) {
            console.warn(chalk.yellow(`⚠ Backup creation skipped/failed: ${err.message}`));
        }
    }

    public trackMutation(command: string): void {
        const clean = command.trim();
        const lower = clean.toLowerCase();

        if (lower.startsWith('interface ') || lower.startsWith('int ')) {
            const parts = clean.split(/\s+/);
            if (parts.length >= 2) {
                if (this.contextStack.length > 0 && this.contextStack[this.contextStack.length - 1].startsWith('interface')) {
                    this.contextStack.pop();
                }
                this.contextStack.push(`interface ${parts[1]}`);
                this.targetInterface = parts[1];
            }
        } else if (lower.startsWith('router ')) {
            if (this.contextStack.length > 0 && this.contextStack[this.contextStack.length - 1].startsWith('router')) {
                this.contextStack.pop();
            }
            this.contextStack.push(clean);
        } else if (lower.startsWith('line ')) {
            if (this.contextStack.length > 0 && this.contextStack[this.contextStack.length - 1].startsWith('line')) {
                this.contextStack.pop();
            }
            this.contextStack.push(clean);
        } else if (lower.startsWith('vlan ') && !lower.startsWith('no vlan ')) {
            if (this.contextStack.length > 0 && this.contextStack[this.contextStack.length - 1].startsWith('vlan')) {
                this.contextStack.pop();
            }
            this.contextStack.push(clean);
        } else if (lower === 'exit') {
            this.contextStack.pop();
            if (this.contextStack.length === 0 || !this.contextStack[this.contextStack.length - 1].startsWith('interface')) {
                this.targetInterface = null;
            }
        } else if (lower === 'end') {
            this.contextStack = [];
            this.targetInterface = null;
        }

        if (this.isMutational(clean)) {
            this.configChangeLog.push(clean);
            this.mutationsWithContext.push({
                command: clean,
                contextStack: [...this.contextStack]
            });
        }
    }

    private isMutational(command: string): boolean {
        const lower = command.toLowerCase();
        return !lower.startsWith('show') && 
               !lower.startsWith('enable') && 
               !lower.startsWith('exit') && 
               !lower.startsWith('end') &&
               !lower.startsWith('configure terminal') &&
               !lower.startsWith('conf t') &&
               !lower.startsWith('copy') &&
               !lower.startsWith('interface') &&
               !lower.startsWith('int ') &&
               !lower.startsWith('router ') &&
               !lower.startsWith('line ') &&
               !lower.startsWith('vlan ');
    }

    public async executeRollback(session: BaseSession): Promise<string> {
        console.warn(chalk.red('⚠ Safety rollback triggered!'));

        const snapshotCapableSession = session as BaseSession & {
            hasSnapshots?: () => boolean;
            restoreBackupSnapshot?: () => boolean;
            restoreToInitialSnapshot?: () => boolean;
        };

        if (snapshotCapableSession.restoreBackupSnapshot?.()) {
            console.log(chalk.green('✔ Mock backup restore completed successfully.'));
            this.clear();
            return 'Mock backup restore completed successfully.';
        }

        if (snapshotCapableSession.hasSnapshots?.() && snapshotCapableSession.restoreToInitialSnapshot?.()) {
            console.log(chalk.green('✔ Mock snapshot restore completed successfully.'));
            this.clear();
            return 'Mock snapshot restore completed successfully.';
        }
        
        if (this.backupCreated) {
            try {
                console.warn(chalk.cyan(`❯ Restoring running configuration atomically using ${this.backupFilename}...`));
                
                const state = session.getState();
                if (state.currentMode === 'USER_EXEC') {
                    await session.execute('enable');
                } else if (state.currentMode === 'GLOBAL_CONFIG' || state.currentMode === 'INTERFACE_CONFIG') {
                    await session.execute('end');
                }
                
                const restoreOutput = await session.execute(`configure replace ${this.backupFilename} force`);
                if (!restoreOutput.includes('% Invalid') && !restoreOutput.includes('Unrecognized')) {
                    console.log(chalk.green('✔ Atomic restore completed successfully.'));
                    this.clear();
                    return restoreOutput;
                }
                console.warn(chalk.yellow('⚠ configure replace failed/unsupported. Falling back to command inversion.'));
            } catch (err: any) {
                console.warn(chalk.yellow(`⚠ Atomic replace failed: ${err.message}. Falling back to command inversion.`));
            }
        }

        console.warn(chalk.cyan(`❯ Executing manual inversion for ${this.mutationsWithContext.length} mutations...`));
        let rollbackSequence: string[] = ['configure terminal'];
        let currentRollbackContext: string[] = [];

        for (const item of [...this.mutationsWithContext].reverse()) {
            const targetStack = item.contextStack;

            let needsReentry = false;
            if (currentRollbackContext.length !== targetStack.length) {
                needsReentry = true;
            } else {
                for (let i = 0; i < targetStack.length; i++) {
                    if (currentRollbackContext[i] !== targetStack[i]) {
                        needsReentry = true;
                        break;
                    }
                }
            }

            if (needsReentry) {
                if (currentRollbackContext.length > 0) {
                    rollbackSequence.push('exit');
                }
                for (const submode of targetStack) {
                    rollbackSequence.push(submode);
                }
                currentRollbackContext = [...targetStack];
            }

            const clean = item.command;
            const lower = clean.toLowerCase();
            let inverseCmd = '';

            if (lower.startsWith('ip address') || lower.startsWith('ip add')) {
                inverseCmd = 'no ip address';
            } else if (lower.startsWith('shutdown')) {
                inverseCmd = 'no shutdown';
            } else if (lower.startsWith('no shutdown')) {
                inverseCmd = 'shutdown';
            } else if (lower.startsWith('description')) {
                inverseCmd = 'no description';
            } else if (lower.startsWith('no ')) {
                inverseCmd = clean.substring(3);
            } else {
                inverseCmd = `no ${clean}`;
            }

            rollbackSequence.push(inverseCmd);
        }
        
        rollbackSequence.push('end');

        let summary = '';
        for (const rollbackCmd of rollbackSequence) {
            console.log(chalk.gray(`❯ Rollback: Executing "${rollbackCmd}"`));
            summary += await session.execute(rollbackCmd);
        }
        
        this.clear();
        return summary;
    }

    public clear(): void {
        this.configChangeLog = [];
        this.mutationsWithContext = [];
        this.contextStack = [];
        this.targetInterface = null;
    }

    public hasMutations(): boolean {
        return this.configChangeLog.length > 0 || this.mutationsWithContext.length > 0;
    }
}
