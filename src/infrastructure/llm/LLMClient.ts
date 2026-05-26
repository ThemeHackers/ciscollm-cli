import axios from 'axios';
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
            this.modelName = modelName || 'qwen3.5-4b';
        }
    }

    public async generateCompletion(messages: ChatMessage[], tools: any[] = CiscoAgentTools): Promise<ChatMessage> {
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
                headers['HTTP-Referer'] = 'https://github.com/ThemeHackers/LearnSync';
                headers['X-Title'] = 'ciscollm-cli';
            }

            const response = await axios.post(url, {
                model: this.modelName,
                messages: messages,
                tools: tools,
                tool_choice: 'auto',
                temperature: 0.1
            }, { headers });

            return response.data.choices[0].message;
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
