import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';

type CommandCandidate = {
    command: string;
    context: string;
};

type ValidationResult = {
    allowed: boolean;
    reason: string;
    suggestions: string[];
};

type CachePayload = {
    version: number;
    pdfMtimeMs: number;
    pdfSize: number;
    generatedAt: string;
    commands: CommandCandidate[];
};

export type ReferenceWarmupTelemetry = {
    source: 'memory' | 'cache' | 'pdf' | 'error';
    commandCount: number;
    durationMs: number;
    strictMode: boolean;
    cachePath: string;
    error?: string;
};

export class CommandReferenceEngine {
    private static readonly CACHE_VERSION = 1;
    private static readonly CACHE_DIR = '.cache';
    private static readonly CACHE_FILE = 'cf_command_ref.index.json';

    private static instance: CommandReferenceEngine | null = null;

    private loaded = false;
    private loadError: string | null = null;
    private commands: CommandCandidate[] = [];
    private pdfPath: string | null = null;
    private strictMode = /^(1|true|yes|on)$/i.test(process.env.CISCOLLM_STRICT_COMMAND_REF || '');
    private lastWarmupTelemetry: ReferenceWarmupTelemetry = {
        source: 'error',
        commandCount: 0,
        durationMs: 0,
        strictMode: this.strictMode,
        cachePath: this.getCachePath(),
        error: 'Reference warmup has not run yet.'
    };

    public static getInstance(): CommandReferenceEngine {
        if (!CommandReferenceEngine.instance) {
            CommandReferenceEngine.instance = new CommandReferenceEngine();
        }
        return CommandReferenceEngine.instance;
    }

    public async warmup(pdfFileName: string = 'cf_command_ref.pdf'): Promise<void> {
        const startedAt = Date.now();
        if (this.loaded) {
            this.lastWarmupTelemetry = {
                source: 'memory',
                commandCount: this.commands.length,
                durationMs: Date.now() - startedAt,
                strictMode: this.strictMode,
                cachePath: this.getCachePath(),
                error: this.loadError || undefined
            };
            return;
        }

        const pdfPath = path.resolve(process.cwd(), pdfFileName);
        this.pdfPath = pdfPath;
        if (!fs.existsSync(pdfPath)) {
            this.loadError = `Reference file not found: ${pdfPath}`;
            this.loaded = true;
            this.lastWarmupTelemetry = {
                source: 'error',
                commandCount: 0,
                durationMs: Date.now() - startedAt,
                strictMode: this.strictMode,
                cachePath: this.getCachePath(),
                error: this.loadError
            };
            return;
        }

        const stat = fs.statSync(pdfPath);
        const cachePayload = this.loadCache(stat.mtimeMs, stat.size);
        if (cachePayload) {
            this.commands = cachePayload.commands;
            this.loaded = true;
            this.lastWarmupTelemetry = {
                source: 'cache',
                commandCount: this.commands.length,
                durationMs: Date.now() - startedAt,
                strictMode: this.strictMode,
                cachePath: this.getCachePath(),
                error: this.loadError || undefined
            };
            return;
        }

        const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });
        try {
            const result = await parser.getText();
            this.commands = this.extractCommands(result.text || '');
            if (!this.commands.length) {
                this.loadError = 'No command candidates were extracted from cf_command_ref.pdf.';
            } else {
                this.saveCache(stat.mtimeMs, stat.size, this.commands);
            }
        } catch (err: any) {
            this.loadError = `Failed to parse cf_command_ref.pdf: ${err.message}`;
        } finally {
            await parser.destroy();
            this.loaded = true;
            this.lastWarmupTelemetry = {
                source: this.loadError ? 'error' : 'pdf',
                commandCount: this.commands.length,
                durationMs: Date.now() - startedAt,
                strictMode: this.strictMode,
                cachePath: this.getCachePath(),
                error: this.loadError || undefined
            };
        }
    }

    public async getPromptHints(goal: string, limit: number = 12): Promise<string> {
        await this.warmup();

        if (this.loadError) {
            return `Reference status: unavailable (${this.loadError}).`;
        }

        const matches = this.search(goal, limit);
        if (!matches.length) {
            return 'Reference status: loaded, but no close command matches found for this request.';
        }

        return matches
            .map((m, idx) => `${idx + 1}. ${m.command}${m.context ? ` | context: ${m.context}` : ''}`)
            .join('\n');
    }

    public isStrictModeEnabled(): boolean {
        return this.strictMode;
    }

    public setStrictMode(enabled: boolean): void {
        this.strictMode = enabled;
        this.lastWarmupTelemetry = {
            ...this.lastWarmupTelemetry,
            strictMode: enabled
        };
    }

    public getWarmupTelemetry(): ReferenceWarmupTelemetry {
        return this.lastWarmupTelemetry;
    }

    public async validateCommand(command: string): Promise<ValidationResult> {
        await this.warmup();

        const clean = command.trim();
        if (!clean) {
            return {
                allowed: false,
                reason: 'Command is empty.',
                suggestions: []
            };
        }

        if (!this.strictMode) {
            return {
                allowed: true,
                reason: 'Strict command reference mode is disabled.',
                suggestions: []
            };
        }

        if (this.loadError) {
            return {
                allowed: false,
                reason: `Strict mode is enabled but command reference is unavailable (${this.loadError}).`,
                suggestions: []
            };
        }

        const expandedInput = this.expandCommand(clean);
        const normalizedInput = this.normalizeCommand(expandedInput);
        const exact = this.commands.find(c => this.normalizeCommand(c.command) === normalizedInput);
        if (exact) {
            return {
                allowed: true,
                reason: 'Command matched reference exactly.',
                suggestions: []
            };
        }

        const best = this.search(expandedInput, 5).map(c => c.command);
        const allowedByPrefix = this.commands.some(c => this.isLikelySameCommandFamily(expandedInput, c.command));
        if (allowedByPrefix) {
            return {
                allowed: true,
                reason: 'Command matched reference by command-family prefix.',
                suggestions: best
            };
        }

        return {
            allowed: false,
            reason: `Command "${clean}" (expanded to "${expandedInput}") was not found in cf_command_ref.pdf index.`,
            suggestions: best
        };
    }

    private search(goal: string, limit: number): CommandCandidate[] {
        const tokens = this.tokenize(goal);
        if (!tokens.length) {
            return this.commands.slice(0, limit);
        }

        const scored = this.commands
            .map(candidate => {
                const haystack = `${candidate.command} ${candidate.context}`.toLowerCase();
                let score = 0;
                for (const token of tokens) {
                    if (candidate.command.toLowerCase().includes(token)) {
                        score += 4;
                    }
                    if (haystack.includes(token)) {
                        score += 1;
                    }
                }

                if (score === 0) {
                    return null;
                }

              
                score += Math.max(0, 6 - candidate.command.split(/\s+/).length) * 0.05;

                return { candidate, score };
            })
            .filter((item): item is { candidate: CommandCandidate; score: number } => !!item)
            .sort((a, b) => b.score - a.score);

        const unique: CommandCandidate[] = [];
        const seen = new Set<string>();
        for (const item of scored) {
            const key = item.candidate.command.toLowerCase();
            if (!seen.has(key)) {
                unique.push(item.candidate);
                seen.add(key);
            }
            if (unique.length >= limit) {
                break;
            }
        }

        return unique;
    }

    private normalizeCommand(command: string): string {
        return command
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    private isLikelySameCommandFamily(input: string, reference: string): boolean {
        const inputTokens = this.normalizeCommand(input).split(' ');
        const refTokens = this.normalizeCommand(reference).split(' ');

        if (!inputTokens.length || !refTokens.length) {
            return false;
        }

     
        const compareCount = Math.min(3, inputTokens.length, refTokens.length);
        for (let i = 0; i < compareCount; i++) {
            if (inputTokens[i] !== refTokens[i]) {
                return false;
            }
        }
        return true;
    }

    private loadCache(pdfMtimeMs: number, pdfSize: number): CachePayload | null {
        try {
            const cachePath = this.getCachePath();
            if (!fs.existsSync(cachePath)) {
                return null;
            }

            const raw = fs.readFileSync(cachePath, 'utf8');
            const data = JSON.parse(raw) as CachePayload;
            if (
                data.version !== CommandReferenceEngine.CACHE_VERSION ||
                data.pdfMtimeMs !== pdfMtimeMs ||
                data.pdfSize !== pdfSize ||
                !Array.isArray(data.commands)
            ) {
                return null;
            }

            return data;
        } catch {
            return null;
        }
    }

    private saveCache(pdfMtimeMs: number, pdfSize: number, commands: CommandCandidate[]): void {
        try {
            const cachePath = this.getCachePath();
            const cacheDir = path.dirname(cachePath);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const payload: CachePayload = {
                version: CommandReferenceEngine.CACHE_VERSION,
                pdfMtimeMs,
                pdfSize,
                generatedAt: new Date().toISOString(),
                commands
            };

            fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch {
          
        }
    }

    private getCachePath(): string {
        return path.resolve(process.cwd(), CommandReferenceEngine.CACHE_DIR, CommandReferenceEngine.CACHE_FILE);
    }

    private tokenize(text: string): string[] {
        const stopWords = new Set([
            'the', 'and', 'for', 'from', 'with', 'that', 'this', 'then', 'into',
            'user', 'goal', 'please', 'need', 'want', 'configure', 'configuration',
            'device', 'devices', 'switch', 'router', 'cisco', 'ios', 'show', 'set'
        ]);

        return text
            .toLowerCase()
            .split(/[^a-z0-9_\/-]+/)
            .map(t => t.trim())
            .filter(t => t.length >= 3 && !stopWords.has(t));
    }

    private extractCommands(text: string): CommandCandidate[] {
        const lines = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        const candidates: CommandCandidate[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!this.isCommandLine(line)) {
                continue;
            }

            const contextParts: string[] = [];
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const next = lines[j];
                if (this.isStructuralNoise(next) || this.isCommandLine(next)) {
                    break;
                }
                contextParts.push(next);
            }

            candidates.push({
                command: line,
                context: contextParts.join(' ').slice(0, 180)
            });
        }

        const unique = new Map<string, CommandCandidate>();
        for (const candidate of candidates) {
            const key = candidate.command.toLowerCase();
            if (!unique.has(key)) {
                unique.set(key, candidate);
            }
        }

        return Array.from(unique.values());
    }

    private isStructuralNoise(line: string): boolean {
        if (!line) return true;
        if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) return true;
        if (/^chapter\s+\d+/i.test(line)) return true;
        if (/^cisco\s+ios\s+/i.test(line)) return true;
        if (/^(table|figure)\s+\d+/i.test(line)) return true;
        if (/^\d+\s*$/.test(line)) return true;
        return false;
    }

    private isCommandLine(line: string): boolean {
        if (this.isStructuralNoise(line)) {
            return false;
        }

        if (line.length < 3 || line.length > 90) {
            return false;
        }

        if (!/^[a-z][a-z0-9\-\s<>\[\]\{\}\/_\.,:()]*$/i.test(line)) {
            return false;
        }

      
        if (/[A-Z]{4,}/.test(line)) {
            return false;
        }
        if (/\b(the|this|that|when|where|example|configuration|command reference)\b/i.test(line)) {
            return false;
        }
        if (/[.!?]$/.test(line)) {
            return false;
        }

        const words = line.split(/\s+/);
        if (words.length > 9) {
            return false;
        }

        return true;
    }

    public expandCommand(command: string): string {
        const tokens = command.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return command;

        const expanded: string[] = [];

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i].toLowerCase();
            let exp = tokens[i]; 

            if (token === 'sh') {
                exp = 'show';
            } else if (token === 'conf') {
                exp = 'configure';
            } else if (token === 't' && i > 0 && (tokens[i - 1].toLowerCase() === 'conf' || tokens[i - 1].toLowerCase() === 'configure')) {
                exp = 'terminal';
            } else if (token === 'int') {
                exp = 'interface';
            } else if (token === 'add' && i > 0 && tokens[i - 1].toLowerCase() === 'ip') {
                exp = 'address';
            } else if (token === 'run' && i > 0 && (tokens[i - 1].toLowerCase() === 'show' || tokens[i - 1].toLowerCase() === 'sh')) {
                exp = 'running-config';
            } else if (token === 'br' && i > 0) {
                exp = 'brief';
            }

           
            if (i > 0 && (tokens[i - 1].toLowerCase() === 'interface' || tokens[i - 1].toLowerCase() === 'int')) {
                const resolved = this.resolveInterfaceName(tokens[i]);
                if (resolved) exp = resolved;
            } else {
                const resolved = this.resolveInterfaceName(tokens[i]);
                if (resolved) exp = resolved;
            }

            expanded.push(exp);
        }

        let cmd = expanded.join(' ');
        const lower = cmd.toLowerCase();
        if (lower === 'no sh') {
            return 'no shutdown';
        }

        return cmd;
    }

    private resolveInterfaceName(intName: string): string | null {
        const lowerName = intName.toLowerCase();
        const aliases = [
            { canonical: 'GigabitEthernet', aliases: ['gigabitethernet', 'gig', 'gi'] },
            { canonical: 'FastEthernet', aliases: ['fastethernet', 'fa'] },
            { canonical: 'Loopback', aliases: ['loopback', 'lo'] },
            { canonical: 'Vlan', aliases: ['vlan', 'vl'] }
        ];

        for (const entry of aliases) {
            for (const alias of entry.aliases) {
                if (lowerName.startsWith(alias)) {
                    const suffix = intName.substring(alias.length);
                    if (suffix === '' || /^[0-9]/.test(suffix)) {
                        return `${entry.canonical}${suffix}`;
                    }
                }
            }
        }
        return null;
    }
}