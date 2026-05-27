import { SessionState } from '../../shared/types';

export abstract class BaseSession {
    protected state: SessionState = { currentMode: 'UNKNOWN', hostname: 'Router', prompt: '>' };
    
    public abstract connect(): Promise<void>;
    public abstract execute(command: string, timeoutMs?: number): Promise<string>;
    public abstract disconnect(): Promise<void>;
    
    public getState(): SessionState {
        return { ...this.state };
    }

    public isShellEnabled(): boolean {
        return false;
    }

    
    protected updateStateFromPrompt(promptStr: string): void {
        const target = promptStr.trim();
        if (!target) return;

        if (target.endsWith('>')) {
            this.state.currentMode = 'USER_EXEC';
        } else if (target.endsWith('config-if)#')) {
            this.state.currentMode = 'INTERFACE_CONFIG';
        } else if (target.endsWith('config)#') || target.endsWith(')#')) {
            this.state.currentMode = 'GLOBAL_CONFIG';
        } else if (target.endsWith('#')) {
            this.state.currentMode = 'PRIVILEGED_EXEC';
        } else {
            this.state.currentMode = 'UNKNOWN';
        }
        
        
        const hostMatch = /^([A-Za-z0-9_\-]+)/.exec(target);
        if (hostMatch) {
            this.state.hostname = hostMatch[1];
        }
        this.state.prompt = target;
    }
}
