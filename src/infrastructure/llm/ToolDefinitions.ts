export const CiscoAgentTools = [
    {
        type: 'function',
        function: {
            name: 'execute_ios_command',
            description: 'Executes a single raw Cisco IOS command onto a target device and returns raw terminal output.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Cisco IOS command string (e.g., "show ip interface brief", "vlan 10"). IMPORTANT: You must navigate to the appropriate CLI mode (e.g., execute "enable" then "configure terminal") before running configuration commands. Check current prompt and mode in state info first.'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The target device identifier (e.g., "COM3", "COM4"). Required if multiple devices are connected.'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ping_test',
            description: 'Executes a network ping test from the local host or from a target Cisco device to verify connection to a destination IP.',
            parameters: {
                type: 'object',
                properties: {
                    destination: {
                        type: 'string',
                        description: 'The target IP address to ping (e.g. "192.168.1.1").'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The source device identifier (e.g., "COM3") to perform ping from. If omitted, executes ping from the local host.'
                    }
                },
                required: ['destination']
            }
        }
    }
];
