export type CiscoDeviceMode = 'USER_EXEC' | 'PRIVILEGED_EXEC' | 'GLOBAL_CONFIG' | 'INTERFACE_CONFIG' | 'UNKNOWN';

export interface SessionState {
    currentMode: CiscoDeviceMode;
    hostname: string;
    prompt: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface TopologyLink {
    localDeviceId: string;
    localInterface: string;
    remoteDeviceId: string;
    remoteInterface: string;
    protocol: 'cdp' | 'lldp';
}

export interface NetworkTopology {
    discoveredAt: string;
    nodes: string[];
    links: TopologyLink[];
}
