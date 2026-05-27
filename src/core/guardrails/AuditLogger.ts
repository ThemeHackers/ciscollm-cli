import * as fs from 'fs';
import * as path from 'path';

export interface AuditLogEntry {
    timestamp: string;
    deviceId: string;
    role: string;
    thought?: string;
    command: string;
    status: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'ROLLBACK';
    outputSnippet?: string;
    reason?: string;
}

export class AuditLogger {
    private static logFile = path.resolve(process.cwd(), 'audit.log');

    public static setLogFile(filePath: string): void {
        this.logFile = path.resolve(process.cwd(), filePath);
    }


    public static log(entry: AuditLogEntry): void {
        const formattedTimestamp = entry.timestamp || new Date().toISOString();
        const outputCleaned = entry.outputSnippet 
            ? entry.outputSnippet.replace(/\r?\n/g, ' ').substring(0, 100) + '...'
            : '';
        const thoughtCleaned = entry.thought
            ? entry.thought.replace(/\r?\n/g, ' ').substring(0, 150) + '...'
            : '';

        const logMessage = `[${formattedTimestamp}] [Device: ${entry.deviceId}] [Role: ${entry.role.toUpperCase()}] [Status: ${entry.status}]
  Thought: ${thoughtCleaned || 'N/A'}
  Command: "${entry.command}"
  Result:  ${outputCleaned || entry.reason || 'N/A'}
--------------------------------------------------------------------------------\n`;

        try {
            fs.appendFileSync(this.logFile, logMessage, 'utf8');
        } catch (e) {
            console.error('[AuditLogger Error]: Failed to write to audit log:', e);
        }
    }
}
