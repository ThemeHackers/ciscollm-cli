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
                console.warn(chalk.yellow('[!] Flash storage is not accessible or not found. Skipping backup creation.'));
                return;
            }

            console.log(chalk.cyan('❯ Creating device running-config backup on flash...'));
            const rawOutput = await session.execute(`copy running-config ${this.backupFilename}`);
            
            if (rawOutput.includes('Destination filename') || rawOutput.includes('?')) {
                const confirmOutput = await session.execute('');
                if (confirmOutput.includes('copied') || confirmOutput.includes('OK')) {
                    this.backupCreated = true;
                    console.log(chalk.green('[+] Running configuration backup successfully created.'));
                } else {
                    console.warn(chalk.yellow('[!] Backup confirmation response did not confirm copy completion.'));
                }
            } else if (rawOutput.includes('copied') || rawOutput.includes('OK')) {
                this.backupCreated = true;
                console.log(chalk.green('[+] Running configuration backup successfully created.'));
            } else {
                console.warn(chalk.yellow('[!] Failed to backup running-config. Flash may be missing or read-only.'));
            }
        } catch (err: any) {
            console.warn(chalk.yellow(`[!] Backup creation skipped/failed: ${err.message}`));
        }
    }

    public trackMutation(command: string): void {
        const clean = command.trim();
        const lower = clean.toLowerCase();

        const submodePrefixes = [
            { match: ['interface ', 'int '], key: 'interface' },
            { match: ['router '], key: 'router' },
            { match: ['line '], key: 'line' },
            { match: ['vlan '], key: 'vlan' },
            { match: ['ip dhcp pool ', 'ip dhcp pool'], key: 'dhcp' },
            { match: ['ip access-list ', 'ip access-list'], key: 'acl' },
            { match: ['route-map '], key: 'route-map' },
            { match: ['policy-map '], key: 'policy-map' },
            { match: ['class-map '], key: 'class-map' }
        ];

        let matchedKey: string | null = null;
        let matchedPrefixes: string[] = [];

        for (const item of submodePrefixes) {
            const found = item.match.find(p => lower.startsWith(p));
            if (found) {
                matchedKey = item.key;
                matchedPrefixes = item.match;
                break;
            }
        }

        if (matchedKey) {
            if (this.contextStack.length > 0) {
                const last = this.contextStack[this.contextStack.length - 1].toLowerCase();
                const lastMatches = matchedPrefixes.some(p => last.startsWith(p));
                if (lastMatches) {
                    this.contextStack.pop();
                }
            }
            this.contextStack.push(clean);
            if (matchedKey === 'interface') {
                const parts = clean.split(/\s+/);
                this.targetInterface = parts[1] || null;
            }
        } else if (lower === 'exit') {
            this.contextStack.pop();
            const last = this.contextStack[this.contextStack.length - 1];
            if (last && (last.toLowerCase().startsWith('interface ') || last.toLowerCase().startsWith('int '))) {
                const parts = last.trim().split(/\s+/);
                this.targetInterface = parts[1] || null;
            } else {
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
               !lower.startsWith('vlan ') &&
               !lower.startsWith('ip dhcp pool') &&
               !lower.startsWith('ip access-list') &&
               !lower.startsWith('route-map') &&
               !lower.startsWith('policy-map') &&
               !lower.startsWith('class-map');
    }

    public async executeRollback(session: BaseSession, failedCommand?: string): Promise<string> {
        console.warn(chalk.red('[!] Safety rollback triggered!'));

        // Capture the state before rollback
        const stateBeforeRollback = session.getState();
        const modeBeforeRollback = stateBeforeRollback.currentMode;

        // Clean the context stack from the failed command if applicable
        const savedContext = [...this.contextStack];
        if (failedCommand) {
            const cleanFailed = failedCommand.trim().toLowerCase();
            const lastContext = savedContext[savedContext.length - 1]?.toLowerCase();
            if (lastContext) {
                const submodePrefixes = [
                    { match: ['interface ', 'int '], key: 'interface' },
                    { match: ['router '], key: 'router' },
                    { match: ['line '], key: 'line' },
                    { match: ['vlan '], key: 'vlan' },
                    { match: ['ip dhcp pool ', 'ip dhcp pool'], key: 'dhcp' },
                    { match: ['ip access-list ', 'ip access-list'], key: 'acl' },
                    { match: ['route-map '], key: 'route-map' },
                    { match: ['policy-map '], key: 'policy-map' },
                    { match: ['class-map '], key: 'class-map' }
                ];
                let matchedPrefixesForCleaning: string[] = [];
                for (const item of submodePrefixes) {
                    const matchesFailed = item.match.some(p => cleanFailed.startsWith(p));
                    if (matchesFailed) {
                        matchedPrefixesForCleaning = item.match;
                        break;
                    }
                }
                const lastMatches = matchedPrefixesForCleaning.some(p => lastContext.startsWith(p));
                if (lastMatches || cleanFailed === lastContext) {
                    savedContext.pop();
                }
            }
        }

        const snapshotCapableSession = session as BaseSession & {
            hasSnapshots?: () => boolean;
            restoreBackupSnapshot?: () => boolean;
            restoreToInitialSnapshot?: () => boolean;
        };

        let rollbackResult = '';

        if (snapshotCapableSession.restoreBackupSnapshot?.()) {
            console.log(chalk.green('[+] Mock backup restore completed successfully.'));
            rollbackResult = 'Mock backup restore completed successfully.';
            this.clear();
        } else if (snapshotCapableSession.hasSnapshots?.() && snapshotCapableSession.restoreToInitialSnapshot?.()) {
            console.log(chalk.green('[+] Mock snapshot restore completed successfully.'));
            rollbackResult = 'Mock snapshot restore completed successfully.';
            this.clear();
        } else {
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
                        console.log(chalk.green('[+] Atomic restore completed successfully.'));
                        rollbackResult = restoreOutput;
                        this.clear();
                    } else {
                        console.warn(chalk.yellow('[!] configure replace failed/unsupported. Falling back to command inversion.'));
                    }
                } catch (err: any) {
                    console.warn(chalk.yellow(`[!] Atomic replace failed: ${err.message}. Falling back to command inversion.`));
                }
            }

            if (!rollbackResult) {
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
                rollbackResult = summary;
                this.clear();
            }
        }

      
        const isConfigMode = ['GLOBAL_CONFIG', 'INTERFACE_CONFIG', 'VLAN_CONFIG'].includes(modeBeforeRollback);
        if (isConfigMode) {
            console.log(chalk.cyan(`❯ Re-entering previous configuration context...`));
            let currentState = session.getState();
            if (currentState.currentMode === 'USER_EXEC') {
                await session.execute('enable');
            }
            await session.execute('configure terminal');
            for (const submode of savedContext) {
                console.log(chalk.gray(`❯ Restoring context: Executing "${submode}"`));
                await session.execute(submode);
            }
        }

        return rollbackResult;
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
