import axios from 'axios';
import { StringDecoder } from 'string_decoder';
import { CiscoAgentTools } from './ToolDefinitions';
import { ChatMessage } from '../../shared/types';

export type LLMProvider = 'local' | 'cloud';

export class LLMClient {
    private provider: LLMProvider;
    private endpoint: string;
    private modelName: string;
    private apiKey?: string;

    constructor(
        provider: LLMProvider = 'local',
        endpoint?: string,
        modelName?: string,
        apiKey?: string
    ) {
        this.provider = provider;
        this.apiKey = apiKey;

        if (this.provider === 'cloud') {
            this.endpoint = endpoint || 'https://openrouter.ai/api/v1';
            this.modelName = modelName || 'nvidia/nemotron-3-super-120b-a12b:free';
        } else {
            this.endpoint = endpoint || 'http://127.0.0.1:11434/v1';
            this.modelName = modelName || 'qwen3.5:4b';
        }
    }

    public getModelName(): string {
        return this.modelName;
    }

    public async generateCompletion(
        messages: ChatMessage[],
        tools: any[] = CiscoAgentTools,
        onChunk?: (data: { content?: string; reasoning?: string }) => void
    ): Promise<ChatMessage> {
        try {
            const url = `${this.endpoint.replace(/\/$/, '')}/chat/completions`;
            
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };

            if (this.provider === 'cloud') {
                const key = this.apiKey || process.env.OPENROUTER_API_KEY;
                if (!key) {
                    throw new Error('API key is required for cloud provider. Set OPENROUTER_API_KEY environment variable or pass --api-key.');
                }
                headers['Authorization'] = `Bearer ${key}`;
                headers['HTTP-Referer'] = 'https://github.com/ThemeHackers/ciscollm-cli';
                headers['X-Title'] = 'ciscollm-cli';
            }

            if (onChunk) {
                return await this.generateCompletionStream(url, headers, messages, tools, onChunk);
            } else {
                return await this.generateCompletionStandard(url, headers, messages, tools);
            }
        } catch (error: any) {
            let details = error.message;
            if (error.response && error.response.data) {
                details = typeof error.response.data === 'string' 
                    ? error.response.data 
                    : JSON.stringify(error.response.data);
            }
            throw new Error(`LLM Client Error [${this.provider}]: ${details}`);
        }
    }

    private async generateCompletionStandard(
        url: string,
        headers: Record<string, string>,
        messages: ChatMessage[],
        tools: any[]
    ): Promise<ChatMessage> {
        const response = await axios.post(url, {
            model: this.modelName,
            messages: messages,
            tools: tools,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 1500
        }, { headers });

        const message = response.data.choices[0].message;
        if (message && message.tool_calls && message.tool_calls.length > 1) {
            message.tool_calls = [message.tool_calls[0]];
        }
        if (message && message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
            this.fallbackRegexToolParsing(message);
        }
        return message;
    }

    private async generateCompletionStream(
        url: string,
        headers: Record<string, string>,
        messages: ChatMessage[],
        tools: any[],
        onChunk: (data: { content?: string; reasoning?: string }) => void
    ): Promise<ChatMessage> {
        const response = await axios.post(url, {
            model: this.modelName,
            messages: messages,
            tools: tools,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 1500,
            stream: true
        }, {
            headers,
            responseType: 'stream'
        });

        const stream = response.data;
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        let fullContent = '';
        let fullReasoning = '';
        const toolCallsAccumulator: any[] = [];

        return new Promise((resolve, reject) => {
            stream.on('data', (chunk: Buffer) => {
                buffer += decoder.write(chunk);
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;
                    if (line === 'data: [DONE]') continue;
                    if (line.startsWith('data: ')) {
                        const dataJson = line.slice(6);
                        if (dataJson.trim() === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(dataJson);
                            const choice = parsed.choices?.[0];
                            if (!choice) continue;
                            const delta = choice.delta;
                            if (!delta) continue;

                            const contentChunk = delta.content || '';
                            if (contentChunk) {
                                fullContent += contentChunk;
                            }

                            const reasoningChunk = delta.reasoning_content || delta.reasoning || delta.thought || '';
                            if (reasoningChunk) {
                                fullReasoning += reasoningChunk;
                            }

                            if (contentChunk || reasoningChunk) {
                                onChunk({ content: contentChunk, reasoning: reasoningChunk });
                            }

                            if (delta.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index ?? 0;
                                    if (!toolCallsAccumulator[idx]) {
                                        toolCallsAccumulator[idx] = {
                                            id: tc.id || '',
                                            type: 'function',
                                            function: {
                                                name: tc.function?.name || '',
                                                arguments: tc.function?.arguments || ''
                                            }
                                        };
                                    } else {
                                        if (tc.id) toolCallsAccumulator[idx].id = tc.id;
                                        if (tc.function?.name) toolCallsAccumulator[idx].function.name = tc.function.name;
                                        if (tc.function?.arguments) {
                                            toolCallsAccumulator[idx].function.arguments += tc.function.arguments;
                                        }
                                    }
                                }
                            }
                        } catch (e) {

                        }
                    }
                }
            });

            stream.on('end', () => {
                const remaining = buffer.trim();
                if (remaining.startsWith('data: ')) {
                    const dataJson = remaining.slice(6);
                    if (dataJson.trim() !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(dataJson);
                            const choice = parsed.choices?.[0];
                            if (choice && choice.delta) {
                                const delta = choice.delta;
                                const contentChunk = delta.content || '';
                                if (contentChunk) {
                                    fullContent += contentChunk;
                                }
                                const reasoningChunk = delta.reasoning_content || delta.reasoning || delta.thought || '';
                                if (reasoningChunk) {
                                    fullReasoning += reasoningChunk;
                                }
                                if (contentChunk || reasoningChunk) {
                                    onChunk({ content: contentChunk, reasoning: reasoningChunk });
                                }
                                if (delta.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index ?? 0;
                                        if (!toolCallsAccumulator[idx]) {
                                            toolCallsAccumulator[idx] = {
                                                id: tc.id || '',
                                                type: 'function',
                                                function: {
                                                    name: tc.function?.name || '',
                                                    arguments: tc.function?.arguments || ''
                                                }
                                            };
                                        } else {
                                            if (tc.id) toolCallsAccumulator[idx].id = tc.id;
                                            if (tc.function?.name) toolCallsAccumulator[idx].function.name = tc.function.name;
                                            if (tc.function?.arguments) {
                                                toolCallsAccumulator[idx].function.arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch {}
                    }
                }

                const finalToolCalls = toolCallsAccumulator.filter(Boolean);
                const message: ChatMessage = {
                    role: 'assistant',
                    content: fullContent,
                };
                if (fullReasoning) {
                    message.reasoning_content = fullReasoning;
                }
                if (finalToolCalls.length > 0) {
                    message.tool_calls = finalToolCalls;
                }

                if (message.tool_calls && message.tool_calls.length > 1) {
                    message.tool_calls = [message.tool_calls[0]];
                }

                if (message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
                    this.fallbackRegexToolParsing(message);
                }

                resolve(message);
            });

            stream.on('error', (err: any) => {
                reject(err);
            });
        });
    }

    private fallbackRegexToolParsing(message: ChatMessage): void {
        const content = message.content;
        const paramRegex = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
        const args: Record<string, any> = {};
        let match;
        while ((match = paramRegex.exec(content)) !== null) {
            const key = match[1];
            const val = match[2].trim();
            args[key] = val;
        }

        if (Object.keys(args).length > 0) {
            let toolName = 'execute_ios_command';
            if ('destination' in args) {
                toolName = 'ping_test';
            } else if ('mode' in args) {
                toolName = 'enable_ios_shell';
            } else if ('name' in args && 'value' in args) {
                toolName = 'define_shell_variable';
            } else if ('variable' in args && 'items' in args && 'command' in args) {
                toolName = 'execute_shell_loop';
                if (typeof args.items === 'string') {
                    try {
                        args.items = JSON.parse(args.items);
                    } catch {
                        args.items = args.items.split(/\s+/).filter(Boolean);
                    }
                }
            } else if ('name' in args && 'body' in args) {
                toolName = 'define_shell_function';
            }

            message.tool_calls = [
                {
                    id: `parsed_${Math.random().toString(36).substring(2, 11)}`,
                    type: 'function',
                    function: {
                        name: toolName,
                        arguments: JSON.stringify(args)
                    }
                }
            ];
        }
    }

    public async ensureReachable(timeoutMs: number = 3500): Promise<void> {
        const base = this.endpoint.replace(/\/$/, '');
        const probeUrls: string[] = [];


        probeUrls.push(`${base}/models`);

      
        if (this.provider === 'local') {
            const withoutV1 = base.replace(/\/v1$/i, '');
            if (withoutV1 !== base) {
                probeUrls.push(`${withoutV1}/api/tags`);
            }
        }

        const errors: string[] = [];
        for (const url of probeUrls) {
            try {
                const response = await axios.get(url, { timeout: timeoutMs });
                if (response.status >= 200 && response.status < 500) {
                    return;
                }
                errors.push(`${url} -> HTTP ${response.status}`);
            } catch (err: any) {
                errors.push(`${url} -> ${err.message}`);
            }
        }

        const guidance = this.provider === 'local'
            ? [
                'For Ollama: run "ollama serve" and ensure your model is pulled (e.g., "ollama pull qwen3.5:4b").',
                'For LM Studio: start the local server and use --local-type lmstudio --endpoint http://127.0.0.1:1234/v1.'
            ].join(' ')
            : 'Check endpoint URL, API key, network, and provider availability.';

        throw new Error(
            `LLM endpoint preflight failed for [${this.provider}] at "${this.endpoint}". ` +
            `Probes: ${errors.join(' | ')}. ${guidance}`
        );
    }
}
