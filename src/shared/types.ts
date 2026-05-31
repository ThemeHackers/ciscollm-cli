export type CiscoDeviceMode = 'USER_EXEC' | 'PRIVILEGED_EXEC' | 'GLOBAL_CONFIG' | 'INTERFACE_CONFIG' | 'VLAN_CONFIG' | 'UNKNOWN';

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
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        duration_ms: number;
        tok_sec: number;
    };
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
