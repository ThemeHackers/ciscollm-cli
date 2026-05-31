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
            if (error.response) {
                const status = error.response.status;
                const statusText = error.response.statusText || '';
                let bodyDetails = '';
                if (error.response.data) {
                    if (typeof error.response.data === 'string') {
                        bodyDetails = error.response.data;
                    } else if (error.response.data.constructor && error.response.data.constructor.name === 'IncomingMessage') {
                        bodyDetails = `[Stream Response]`;
                    } else {
                        try {
                            bodyDetails = JSON.stringify(error.response.data);
                        } catch {
                            bodyDetails = `[Unserializable Response Data]`;
                        }
                    }
                }
                details = `HTTP ${status} ${statusText}${bodyDetails ? ` - ${bodyDetails}` : ''} (original error: ${error.message})`;
            }
            throw new Error(`LLM Client Error [${this.provider}]: ${details}`);
        }
    }

    private estimatePromptTokens(messages: ChatMessage[]): number {
        let text = '';
        for (const msg of messages) {
            text += `${msg.role} ${msg.content || ''}\n`;
            if (msg.reasoning_content) text += `${msg.reasoning_content}\n`;
        }
        return Math.ceil(text.length / 3.8);
    }

    private estimateCompletionTokens(message: ChatMessage): number {
        let text = message.content || '';
        if (message.reasoning_content) {
            text += message.reasoning_content;
        }
        if (message.tool_calls) {
            text += JSON.stringify(message.tool_calls);
        }
        return Math.ceil(text.length / 3.6);
    }

    private async generateCompletionStandard(
        url: string,
        headers: Record<string, string>,
        messages: ChatMessage[],
        tools: any[]
    ): Promise<ChatMessage> {
        const startTime = Date.now();
        const response = await axios.post(url, {
            model: this.modelName,
            messages: messages,
            tools: tools,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 1500
        }, { headers });

        const duration_ms = Math.max(1, Date.now() - startTime);
        const message = response.data.choices[0].message;
        if (message && message.tool_calls && message.tool_calls.length > 1) {
            message.tool_calls = [message.tool_calls[0]];
        }
        if (message && message.content && (!message.tool_calls || message.tool_calls.length === 0)) {
            this.fallbackRegexToolParsing(message);
        }

        let prompt_tokens = 0;
        let completion_tokens = 0;
        let total_tokens = 0;

        if (response.data.usage) {
            prompt_tokens = response.data.usage.prompt_tokens || 0;
            completion_tokens = response.data.usage.completion_tokens || 0;
            total_tokens = response.data.usage.total_tokens || 0;
        } else {
            prompt_tokens = this.estimatePromptTokens(messages);
            completion_tokens = this.estimateCompletionTokens(message);
            total_tokens = prompt_tokens + completion_tokens;
        }

        const tok_sec = parseFloat((completion_tokens / (duration_ms / 1000)).toFixed(2));

        message.usage = {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            duration_ms,
            tok_sec
        };

        return message;
    }

    private async generateCompletionStream(
        url: string,
        headers: Record<string, string>,
        messages: ChatMessage[],
        tools: any[],
        onChunk: (data: { content?: string; reasoning?: string }) => void
    ): Promise<ChatMessage> {
        const startTime = Date.now();
        const response = await axios.post(url, {
            model: this.modelName,
            messages: messages,
            tools: tools,
            tool_choice: 'auto',
            temperature: 0.1,
            max_tokens: 1500,
            stream: true,
            stream_options: { include_usage: true }
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
        let streamUsage: any = undefined;

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
                            if (parsed.usage) {
                                streamUsage = parsed.usage;
                            }
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
                            if (parsed.usage) {
                                streamUsage = parsed.usage;
                            }
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

                const duration_ms = Math.max(1, Date.now() - startTime);

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

                let prompt_tokens = 0;
                let completion_tokens = 0;
                let total_tokens = 0;

                if (streamUsage) {
                    prompt_tokens = streamUsage.prompt_tokens || 0;
                    completion_tokens = streamUsage.completion_tokens || 0;
                    total_tokens = streamUsage.total_tokens || 0;
                } else {
                    prompt_tokens = this.estimatePromptTokens(messages);
                    completion_tokens = this.estimateCompletionTokens(message);
                    total_tokens = prompt_tokens + completion_tokens;
                }

                const tok_sec = parseFloat((completion_tokens / (duration_ms / 1000)).toFixed(2));

                message.usage = {
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    duration_ms,
                    tok_sec
                };

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

    private getApiV1BaseUrl(): string {
        const base = this.endpoint.replace(/\/$/, '');
        if (base.endsWith('/v1')) {
            return `${base.substring(0, base.length - 3)}/api/v1`;
        }
        return `${base}/api/v1`;
    }

    public async setupModelIfNeeded(onProgress: (status: string) => void): Promise<boolean> {
        if (this.provider === 'cloud') {
            return false;
        }

        try {
            const apiBase = this.getApiV1BaseUrl();
            const modelsUrl = `${apiBase}/models`;
            
            onProgress('Checking available models...');
            const response = await axios.get(modelsUrl, { timeout: 3500 });
            const data = response.data;
            
            let modelsList: string[] = [];
            if (Array.isArray(data)) {
                modelsList = data.map((m: any) => typeof m === 'string' ? m : m.key || m.id || m.name).filter(Boolean);
            } else if (data && Array.isArray(data.models)) {
                modelsList = data.models.map((m: any) => typeof m === 'string' ? m : m.key || m.id || m.name).filter(Boolean);
            } else if (data && Array.isArray(data.data)) {
                modelsList = data.data.map((m: any) => typeof m === 'string' ? m : m.key || m.id || m.name).filter(Boolean);
            }

            const targetModel = this.modelName.toLowerCase();
            const isModelPresent = modelsList.some(m => m && m.toLowerCase() === targetModel);

           
            let isAlreadyLoaded = false;
            try {
                if (apiBase.includes('1234') || apiBase.includes('lmstudio')) {
                    if (isModelPresent) {
                        isAlreadyLoaded = true;
                    }
                } else if (apiBase.includes('11434') || apiBase.includes('ollama')) {
                    const ollamaBase = apiBase.replace(/\/api\/v1$/, '').replace(/\/v1$/, '');
                    const psRes = await axios.get(`${ollamaBase}/api/ps`, { timeout: 2000 });
                    if (psRes.data && Array.isArray(psRes.data.models)) {
                        const loadedModels = psRes.data.models.map((m: any) => m.name.toLowerCase());
                        if (loadedModels.some((m: string) => m.includes(targetModel) || targetModel.includes(m))) {
                            isAlreadyLoaded = true;
                        }
                    }
                } else {
                    const loadedRes = await axios.get(`${apiBase}/models/loaded`, { timeout: 2000 }).catch(() => null);
                    if (loadedRes && loadedRes.data && loadedRes.data.model) {
                        const activeModel = loadedRes.data.model.toLowerCase();
                        if (activeModel === targetModel) {
                            isAlreadyLoaded = true;
                        }
                    }
                }
            } catch (err) {

            }

            if (isAlreadyLoaded) {
                onProgress(`Model "${this.modelName}" is already loaded. Skipping load.`);
                return true;
            }

            if (!isModelPresent) {
                onProgress(`Model "${this.modelName}" not found. Triggering download...`);
                const downloadUrl = `${apiBase}/models/download`;
                const downloadRes = await axios.post(downloadUrl, { model: this.modelName }, { timeout: 5000 });
                
                if (downloadRes.data?.status === 'already_downloaded') {
                    onProgress(`Model "${this.modelName}" is already downloaded.`);
                } else {
                    const jobId = downloadRes.data?.job_id;
                    if (!jobId) {
                        throw new Error('No job_id returned from download endpoint.');
                    }

                    let completed = false;
                    const statusUrl = `${apiBase}/models/download/status/${jobId}`;
                    while (!completed) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        const statusRes = await axios.get(statusUrl, { timeout: 3500 });
                        const status = statusRes.data?.status;
                        const progress = statusRes.data?.progress || '0%';
                        onProgress(`Downloading "${this.modelName}": ${progress}`);
                        if (status === 'completed' || status === 'success') {
                            completed = true;
                        } else if (status === 'failed' || status === 'error') {
                            throw new Error(`Download job ${jobId} failed.`);
                        }
                    }
                }
            }

            onProgress(`Loading model "${this.modelName}"...`);
            const loadUrl = `${apiBase}/models/load`;
            await axios.post(loadUrl, { model: this.modelName }, { timeout: 120000 });
            onProgress(`Model "${this.modelName}" loaded.`);
            return true;
        } catch (err: any) {
            onProgress(`Skipping auto-load (graceful fallback): ${err.message}`);
            return false;
        }
    }
}
