import { BaseSession } from '../../infrastructure/protocols/BaseSession';

export class TransactionManager {
    private configChangeLog: string[] = [];
    private targetInterface: string | null = null;
    private backupCreated = false;
    private readonly backupFilename = 'flash:backup-agent.cfg';

    
    public async initializeBackup(session: BaseSession): Promise<void> {
        const state = session.getState();
        
        
        if (state.currentMode === 'USER_EXEC') {
            console.log('[TransactionManager]: Elevating to privileged mode for backup...');
            await session.execute('enable');
        }

        try {
            console.log('[TransactionManager]: Creating device running-config backup on flash...');
            
            
            const rawOutput = await session.execute(`copy running-config ${this.backupFilename}`);
            
            
            if (rawOutput.includes('Destination filename') || rawOutput.includes('?')) {
                const confirmOutput = await session.execute('');
                if (confirmOutput.includes('copied') || confirmOutput.includes('OK')) {
                    this.backupCreated = true;
                    console.log('[TransactionManager]: Running configuration backup successfully created.');
                } else {
                    console.warn('[TransactionManager Warning]: Backup confirmation response did not confirm copy completion.');
                }
            } else if (rawOutput.includes('copied') || rawOutput.includes('OK')) {
                this.backupCreated = true;
                console.log('[TransactionManager]: Running configuration backup successfully created.');
            } else {
                console.warn('[TransactionManager Warning]: Failed to backup running-config. Flash may be missing or read-only.');
            }
        } catch (err: any) {
            console.warn(`[TransactionManager Warning]: Backup creation skipped/failed: ${err.message}`);
        }
    }

    
    public trackMutation(command: string): void {
        const cleanCmd = command.trim();
        
        
        const interfaceMatch = /^interface\s+([A-Za-z0-9\/\.\-]+)/i.exec(cleanCmd);
        if (interfaceMatch) {
            this.targetInterface = interfaceMatch[1];
        }
        
        if (this.isMutational(cleanCmd)) {
            this.configChangeLog.push(cleanCmd);
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
               !lower.startsWith('interface');
    }

    
    public async executeRollback(session: BaseSession): Promise<string> {
        console.warn('[TransactionManager]: Safety rollback triggered!');
        
        if (this.backupCreated) {
            try {
                console.warn(`[TransactionManager]: Restoring running configuration atomically using ${this.backupFilename}...`);
                
                
                const state = session.getState();
                if (state.currentMode === 'USER_EXEC') {
                    await session.execute('enable');
                } else if (state.currentMode === 'GLOBAL_CONFIG' || state.currentMode === 'INTERFACE_CONFIG') {
                    await session.execute('end');
                }
                
                const restoreOutput = await session.execute(`configure replace ${this.backupFilename} force`);
                if (!restoreOutput.includes('% Invalid') && !restoreOutput.includes('Unrecognized')) {
                    console.log('[TransactionManager]: Atomic restore completed successfully.');
                    this.clear();
                    return restoreOutput;
                }
                console.warn('[TransactionManager]: configure replace failed/unsupported. Falling back to command inversion.');
            } catch (err: any) {
                console.warn(`[TransactionManager Warning]: Atomic replace failed: ${err.message}. Falling back to command inversion.`);
            }
        }

        
        console.warn(`[TransactionManager]: Executing manual inversion for ${this.configChangeLog.length} mutations...`);
        let rollbackSequence: string[] = ['configure terminal'];

        if (this.targetInterface) {
            rollbackSequence.push(`interface ${this.targetInterface}`);
            
            
            for (const cmd of [...this.configChangeLog].reverse()) {
                const clean = cmd.trim();
                const lower = clean.toLowerCase();
                
                if (lower.startsWith('ip address') || lower.startsWith('ip add')) {
                    rollbackSequence.push('no ip address');
                } else if (lower.startsWith('shutdown')) {
                    rollbackSequence.push('no shutdown');
                } else if (lower.startsWith('no shutdown')) {
                    rollbackSequence.push('shutdown');
                } else if (lower.startsWith('description')) {
                    rollbackSequence.push('no description');
                } else {
                    
                    if (lower.startsWith('no ')) {
                        rollbackSequence.push(clean.substring(3));
                    } else {
                        rollbackSequence.push(`no ${clean}`);
                    }
                }
            }
        } else {
            
            for (const cmd of [...this.configChangeLog].reverse()) {
                const clean = cmd.trim();
                const lower = clean.toLowerCase();
                if (lower.startsWith('no ')) {
                    rollbackSequence.push(clean.substring(3));
                } else {
                    rollbackSequence.push(`no ${clean}`);
                }
            }
        }
        
        rollbackSequence.push('end');

        let summary = '';
        for (const rollbackCmd of rollbackSequence) {
            console.log(`[TransactionManager Rollback]: Executing "${rollbackCmd}"`);
            summary += await session.execute(rollbackCmd);
        }
        
        this.clear();
        return summary;
    }

    public clear(): void {
        this.configChangeLog = [];
        this.targetInterface = null;
    }

    public hasMutations(): boolean {
        return this.configChangeLog.length > 0;
    }
}
