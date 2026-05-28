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
    },
    {
        type: 'function',
        function: {
            name: 'enable_ios_shell',
            description: 'Enables Cisco IOS Shell (IOS.sh) globally or for the current terminal session.',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['global', 'session'],
                        description: 'Method to enable shell processing. "global" configures full processing globally, "session" enables it for the current terminal only.'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The target device identifier (e.g., "COM3").'
                    }
                },
                required: ['mode']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'define_shell_variable',
            description: 'Binds a value to a Cisco IOS Shell environment variable.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The variable identifier name (e.g., "IP_TARGET").'
                    },
                    value: {
                        type: 'string',
                        description: 'The value to associate with the variable (e.g., "10.0.1.1").'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The target device identifier (e.g., "COM3").'
                    }
                },
                required: ['name', 'value']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_shell_loop',
            description: 'Runs a command loop over a list of items using Cisco IOS Shell syntax.',
            parameters: {
                type: 'object',
                properties: {
                    variable: {
                        type: 'string',
                        description: 'The loop variable name (e.g., "i").'
                    },
                    items: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'The list of items to iterate over.'
                    },
                    command: {
                        type: 'string',
                        description: 'The Cisco command to execute inside the loop body, using the variable (e.g., "ping 10.0.1.$i").'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The target device identifier (e.g., "COM3").'
                    }
                },
                required: ['variable', 'items', 'command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'define_shell_function',
            description: 'Creates a custom user-defined function in Cisco IOS Shell.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The name of the function (e.g., "run_pings").'
                    },
                    body: {
                        type: 'string',
                        description: 'The command body of the function (e.g., "ping 10.0.1.1").'
                    },
                    device: {
                        type: 'string',
                        description: 'Optional. The target device identifier (e.g., "COM3").'
                    }
                },
                required: ['name', 'body']
            }
        }
    }
];
