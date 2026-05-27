import * as assert from 'assert';
import { CiscoAgentLoop } from '../src/core/agent/AgentLoop';

console.log('Running agent loop inspection guard test...\n');

async function main() {
    const session = {
        getState: () => ({ currentMode: 'PRIVILEGED_EXEC', hostname: 'iosv-0', prompt: 'iosv-0#' }),
        execute: async (command: string) => {
            if (command === 'show ip interface brief') {
                return 'Interface              IP-Address      OK? Method Status                Protocol\nGigabitEthernet0/1     unassigned      YES unset  administratively down down';
            }
            return 'OK';
        }
    } as any;

    const coordinator = {
        getSessions: () => new Map([['iosv-0', session]]),
        getSession: () => session,
        getTopology: () => ({ discoveredAt: new Date().toISOString(), nodes: [], links: [] }),
        getAllStates: () => ({ 'iosv-0': session.getState() })
    } as any;

    const loop = new CiscoAgentLoop({} as any, coordinator);
    const call = {
        id: 'call-show',
        type: 'function' as const,
        function: {
            name: 'execute_ios_command',
            arguments: JSON.stringify({ command: 'show ip interface brief', device: 'iosv-0' })
        }
    };

    for (let i = 0; i < 4; i++) {
        await (loop as any).handleExecuteCommandCall(call);
    }

    const messages = (loop as any).messages as Array<{ role: string; content: string; name?: string }>;
    const loopBlockMessage = messages.find((message) => message.role === 'tool' && message.content.includes('Loop check block'));

    assert.strictEqual(loopBlockMessage, undefined, 'Repeated inspection commands should not trip the loop block');
    console.log(' -> Agent loop inspection guard test passed.');
}

main().catch((error) => {
    console.error('Agent loop inspection guard test FAILED:', error);
    process.exit(1);
});
