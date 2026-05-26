import { BaseSession } from '../../infrastructure/protocols/BaseSession';
import { SessionState } from '../../shared/types';

export class MultiAgentCoordinator {
    private sessions: Map<string, BaseSession> = new Map();

    public registerSession(deviceId: string, session: BaseSession): void {
        this.sessions.set(deviceId, session);
    }

    public async connectAll(): Promise<void> {
        console.log(`[MultiAgentCoordinator]: Establishing connections to ${this.sessions.size} devices in parallel...`);
        const promises = Array.from(this.sessions.entries()).map(async ([id, session]) => {
            try {
                await session.connect();
                console.log(`[MultiAgentCoordinator]: Device "${id}" connected successfully.`);
            } catch (err: any) {
                throw new Error(`Device "${id}" failed to connect: ${err.message}`);
            }
        });
        await Promise.all(promises);
    }

    public async executeCommand(deviceId: string, command: string): Promise<string> {
        const session = this.sessions.get(deviceId);
        if (!session) {
            throw new Error(`Device "${deviceId}" is not registered in this coordinator session.`);
        }
        return await session.execute(command);
    }

    public getSessions(): Map<string, BaseSession> {
        return this.sessions;
    }

    public getSession(deviceId: string): BaseSession | undefined {
        return this.sessions.get(deviceId);
    }

    public getAllStates(): Record<string, SessionState> {
        const states: Record<string, SessionState> = {};
        for (const [id, session] of this.sessions.entries()) {
            states[id] = session.getState();
        }
        return states;
    }

    public async disconnectAll(): Promise<void> {
        console.log('[MultiAgentCoordinator]: Terminating all device connection channels...');
        for (const [id, session] of this.sessions.entries()) {
            try {
                await session.disconnect();
                console.log(`[MultiAgentCoordinator]: Device "${id}" disconnected cleanly.`);
            } catch (err: any) {
                console.error(`[MultiAgentCoordinator Warning]: Device "${id}" failed to close cleanly: ${err.message}`);
            }
        }
        this.sessions.clear();
    }
}
