import * as fs from 'fs';
import * as path from 'path';

export interface MemoryEntry {
    intent: string;
    successfulCommands: string[];
    failedCommands: string[];
    timestamp: string;
}

export class MemoryManager {
    private memoryFile: string;
    private memory: MemoryEntry[] = [];

    constructor(storagePath: string = path.join(process.cwd(), 'memory.json')) {
        this.memoryFile = storagePath;
        this.loadMemory();
    }

    private loadMemory() {
        if (fs.existsSync(this.memoryFile)) {
            try {
                const data = fs.readFileSync(this.memoryFile, 'utf8');
                this.memory = JSON.parse(data);
            } catch (e) {
                console.warn('Failed to load memory file. Starting fresh.');
                this.memory = [];
            }
        }
    }

    public saveExperience(intent: string, successful: string[], failed: string[]) {
        this.memory.push({
            intent,
            successfulCommands: successful,
            failedCommands: failed,
            timestamp: new Date().toISOString()
        });
        
        try {
            fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2));
        } catch (e) {
            console.error('Failed to save memory.');
        }
    }

    public retrieveRelevantExperience(intent: string): string {
        const matches = this.memory.filter(m => 
            m.intent.toLowerCase().includes(intent.toLowerCase()) || 
            intent.toLowerCase().includes(m.intent.toLowerCase())
        );

        if (matches.length === 0) return 'No relevant past experiences found.';

        const latest = matches[matches.length - 1];
        let exp = `Past Experience for similar intent: "${latest.intent}"\n`;
        if (latest.successfulCommands.length > 0) {
            exp += `Successful commands previously used:\n- ${latest.successfulCommands.join('\n- ')}\n`;
        }
        if (latest.failedCommands.length > 0) {
            exp += `Commands to AVOID (previously failed):\n- ${latest.failedCommands.join('\n- ')}\n`;
        }
        return exp;
    }
}
