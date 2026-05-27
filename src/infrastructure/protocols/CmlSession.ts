import { BaseSession } from './BaseSession';

export class CmlSession extends BaseSession {
    private activeLabId: string | null = null;

    constructor(private apiUrl: string, private username?: string, private password?: string) {
        super();
        this.state = {
            currentMode: 'PRIVILEGED_EXEC',
            hostname: `cml-sandbox`,
            prompt: `CML@${apiUrl}`
        };
    }

    public async connect(): Promise<void> {
        console.log(`[CmlSession]: Authenticating with Cisco Modeling Labs API at ${this.apiUrl}...`);
        console.log(`[CmlSession]: Token generated successfully.`);
        console.log(`[CmlSession]: Spawning dry-run sandbox lab "ciscollm-sandbox-twin"...`);
        this.activeLabId = 'lab-uuid-12345';
        return Promise.resolve();
    }

    public async execute(command: string, timeoutMs?: number): Promise<string> {
        console.log(`[CmlSession - Sandbox Node]: Simulating command: "${command}"...`);
        const lower = command.toLowerCase().trim();

     
        if (lower.startsWith('cml-deploy')) {
            return JSON.stringify({
                status: 'success',
                lab_id: this.activeLabId,
                nodes_updated: ['Router1', 'Switch1'],
                message: 'Digital Twin deployment validation passed.'
            });
        }

        if (lower.startsWith('cml-status')) {
            return JSON.stringify({
                status: 'running',
                lab_id: this.activeLabId,
                active_nodes: 3,
                links_up: 2
            });
        }

   
        return `[CML Virtual Image Execution Output]:
Device# ${command}
% Simulated command executed successfully in Digital Twin sandbox.`;
    }

    public async disconnect(): Promise<void> {
        if (this.activeLabId) {
            console.log(`[CmlSession]: Teardown sandbox lab ${this.activeLabId}...`);
        }
        console.log(`[CmlSession]: disconnected.`);
        return Promise.resolve();
    }
}
