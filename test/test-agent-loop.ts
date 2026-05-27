import { CiscoAgentLoop } from '../src/core/agent/AgentLoop';
import { MultiAgentCoordinator } from '../src/core/agent/MultiAgentCoordinator';
import { MockSession } from '../src/infrastructure/protocols/MockSession';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import { ChatMessage } from '../src/shared/types';


delete process.env.NODE_ENV;

class SimulatedLLMClient extends LLMClient {
    private step = 0;

    constructor() {
        super('local');
    }

    public override async ensureReachable(): Promise<void> {
        return Promise.resolve();
    }

    public override async generateCompletion(messages: ChatMessage[]): Promise<ChatMessage> {
        this.step++;

        switch (this.step) {
            case 1:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: The Switch is currently in User EXEC mode (Switch>).
2. TECHNICAL PLAN: Elevate privileges using 'enable' command to access Privileged EXEC mode.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'enable'.`,
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'enable' })
                        }
                    }]
                };

            case 2:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: Currently in Privileged EXEC mode (Switch#).
2. TECHNICAL PLAN: Enter Global Configuration mode using 'configure terminal'.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'configure terminal'.`,
                    tool_calls: [{
                        id: 'call_2',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'configure terminal' })
                        }
                    }]
                };

            case 3:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: Currently in Global Configuration mode (Switch(config)#).
2. TECHNICAL PLAN: Enter interface GigabitEthernet0/1 to configure LAN A interface.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'interface GigabitEthernet0/1'.`,
                    tool_calls: [{
                        id: 'call_3',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'interface GigabitEthernet0/1' })
                        }
                    }]
                };

            case 4:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: Inside interface GigabitEthernet0/1 (config-if).
2. TECHNICAL PLAN: Configure IP address 192.168.2.1 with mask 255.255.255.0.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'ip address 192.168.2.1 255.255.255.0'.`,
                    tool_calls: [{
                        id: 'call_4',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'ip address 192.168.2.1 255.255.255.0' })
                        }
                    }]
                };

            case 5:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: IP address set. Interface is still shutdown.
2. TECHNICAL PLAN: Run 'no shutdown' to enable interface.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'no shutdown'.`,
                    tool_calls: [{
                        id: 'call_5',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'no shutdown' })
                        }
                    }]
                };

            case 6:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: GigabitEthernet0/1 is up.
2. TECHNICAL PLAN: Exit interface config mode to prepare for DHCP setup.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'exit'.`,
                    tool_calls: [{
                        id: 'call_6',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'exit' })
                        }
                    }]
                };

            case 7:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: In Global Configuration mode (config).
2. TECHNICAL PLAN: Exclude gateway IP 192.168.2.1 from dynamic leasing.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'ip dhcp excluded-address 192.168.2.1'.`,
                    tool_calls: [{
                        id: 'call_7',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'ip dhcp excluded-address 192.168.2.1' })
                        }
                    }]
                };

            case 8:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: IP excluded.
2. TECHNICAL PLAN: Define DHCP pool 'LAN_A_POOL' to dynamically lease IP addresses.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'ip dhcp pool LAN_A_POOL'.`,
                    tool_calls: [{
                        id: 'call_8',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'ip dhcp pool LAN_A_POOL' })
                        }
                    }]
                };

            case 9:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: In DHCP pool configuration (dhcp-config).
2. TECHNICAL PLAN: Define pool network range 192.168.2.0/24.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'network 192.168.2.0 255.255.255.0'.`,
                    tool_calls: [{
                        id: 'call_9',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'network 192.168.2.0 255.255.255.0' })
                        }
                    }]
                };

            case 10:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: DHCP network configured.
2. TECHNICAL PLAN: Define default-router as 192.168.2.1.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'default-router 192.168.2.1'.`,
                    tool_calls: [{
                        id: 'call_10',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'default-router 192.168.2.1' })
                        }
                    }]
                };

            case 11:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: DHCP pool configuration completed.
2. TECHNICAL PLAN: Exit config modes to Privileged EXEC mode.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'end'.`,
                    tool_calls: [{
                        id: 'call_11',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'end' })
                        }
                    }]
                };

            case 12:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: Back in Switch# mode.
2. TECHNICAL PLAN: Verify interface configurations using 'show ip interface brief'.
3. NEXT ACTION DETAILS: Call execute_ios_command with 'show ip interface brief'.`,
                    tool_calls: [{
                        id: 'call_12',
                        type: 'function',
                        function: {
                            name: 'execute_ios_command',
                            arguments: JSON.stringify({ command: 'show ip interface brief' })
                        }
                    }]
                };

            case 13:
                return {
                    role: 'assistant',
                    content: `1. CURRENT STATE ANALYSIS: Interface status verified.
2. TECHNICAL PLAN: Execute a validation ping to check routing gateway.
3. NEXT ACTION DETAILS: Call ping_test to 192.168.2.1.`,
                    tool_calls: [{
                        id: 'call_13',
                        type: 'function',
                        function: {
                            name: 'ping_test',
                            arguments: JSON.stringify({ destination: '192.168.2.1', device: 'Switch' })
                        }
                    }]
                };

            default:
                return {
                    role: 'assistant',
                    content: `I have successfully configured interface GigabitEthernet0/1 with IP 192.168.2.1/24. I also configured the DHCP server with pool 'LAN_A_POOL' excluding 192.168.2.1. All checks and validation ping succeeded.`
                };
        }
    }
}

async function runAgentTest() {
    console.log("=== Starting CiscoAgentLoop Execution Simulation ===\n");
    const coordinator = new MultiAgentCoordinator();
    const session = new MockSession('Switch');
    await session.connect();
    coordinator.registerSession('Switch', session);

    const client = new SimulatedLLMClient();
    const agentLoop = new CiscoAgentLoop(client, coordinator);

    await agentLoop.run("Configure LAN A with IP 192.168.2.1/24 for approximately 25 internal hosts. This device is the first machine in our system.");

    console.log("\n=== CiscoAgentLoop Execution Simulation Completed ===");
    await session.disconnect();
}

runAgentTest().catch(console.error);
