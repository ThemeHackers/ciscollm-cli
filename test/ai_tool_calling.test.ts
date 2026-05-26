import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { LLMClient } from '../src/infrastructure/llm/LLMClient';
import { PromptEngine } from '../src/core/agent/PromptEngine';
import { ChatMessage, ToolCall } from '../src/shared/types';
import { CiscoAgentTools } from '../src/infrastructure/llm/ToolDefinitions';
import { MockSession } from '../src/infrastructure/protocols/MockSession';

const mockDevice = new MockSession('Switch1');

async function executeMockTool(call: ToolCall): Promise<string> {
    let args: any = {};
    try {
        args = JSON.parse(call.function.arguments);
    } catch {
        return `[Format Error] Invalid JSON arguments for tool "${call.function.name}".`;
    }

    switch (call.function.name) {
        case 'enable_ios_shell': {
            const mode = args.mode as string;
            if (mode === 'global') {
                await mockDevice.execute('enable');
                await mockDevice.execute('configure terminal');
                const out = await mockDevice.execute('shell processing full');
                await mockDevice.execute('end');
                return out || 'IOS Shell enabled globally (shell processing full).';
            } else {
                await mockDevice.execute('enable');
                const out = await mockDevice.execute('terminal shell');
                return out || 'IOS Shell enabled for this terminal session.';
            }
        }

        case 'define_shell_variable': {
            const out = await mockDevice.execute(`${args.name}=${args.value}`);
            return out || `Shell variable defined: ${args.name}=${args.value}`;
        }

        case 'execute_shell_loop': {
            const itemsStr = Array.isArray(args.items) ? args.items.join(' ') : args.items;
            const loopCmd = `for ${args.variable} in ${itemsStr}; do ${args.command}; done`;
            const out = await mockDevice.execute(loopCmd);
            return out || `Loop completed: ${loopCmd}`;
        }

        case 'define_shell_function': {
            const funcCmd = `${args.name}() { ${args.body}; }`;
            const out = await mockDevice.execute(funcCmd);
            return out || `Function defined: ${args.name}()`;
        }

        case 'execute_ios_command': {
            const out = await mockDevice.execute(args.command);
            return out || `Command executed: ${args.command}`;
        }

        case 'ping_test': {
            const out = await mockDevice.execute(`ping ${args.destination}`);
            return out || `Ping to ${args.destination} completed.`;
        }

        default:
            return `[Unknown Tool] "${call.function.name}" is not recognized.`;
    }
}

function printDivider(label?: string) {
    const line = '═'.repeat(52);
    if (label) {
        const pad = Math.max(0, 52 - label.length - 2);
        const left = Math.floor(pad / 2);
        const right = pad - left;
        console.log(chalk.bold.blue(`╔${'═'.repeat(left)} ${label} ${'═'.repeat(right)}╗`));
    } else {
        console.log(chalk.bold.blue(`╚${line}╝`));
    }
}

function printThoughts(reasoning: string) {
    if (!reasoning.trim()) return;
    console.log(chalk.gray('  ┌' + '─'.repeat(48) + '┐'));
    reasoning.trim().split('\n').forEach(line => {
        const padded = line.padEnd(48);
        console.log(chalk.dim(`  │ ${padded} │`));
    });
    console.log(chalk.gray('  └' + '─'.repeat(48) + '┘'));
}


async function main() {
    console.clear();
    console.log(chalk.bold.bgGreen.black('  🔁 CISCO IOS SHELL — MULTI-TURN TOOL CALLING TEST  '));
    console.log(chalk.dim('Tests the full agentic loop: think → call tool → inject result → repeat\n'));

 
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'provider',
            message: 'Select LLM Provider:',
            choices: [
                { name: 'Local (Ollama / LM Studio)', value: 'local' },
                { name: 'Cloud (OpenRouter)', value: 'cloud' }
            ]
        },
        {
            type: 'list',
            name: 'localType',
            message: 'Select Local LLM Service:',
            choices: [
                { name: 'LM Studio (port 1234)', value: 'lmstudio' },
                { name: 'Ollama (port 11434)', value: 'ollama' }
            ],
            when: (ans) => ans.provider === 'local'
        },
        {
            type: 'input',
            name: 'apiKey',
            message: 'Enter OpenRouter API Key (leave empty to use OPENROUTER_API_KEY env):',
            when: (ans) => ans.provider === 'cloud',
            default: process.env.OPENROUTER_API_KEY || ''
        },
        {
            type: 'input',
            name: 'model',
            message: 'Enter LLM Model Name:',
            default: (ans: any) => ans.provider === 'cloud'
                ? 'nvidia/nemotron-3-super-120b-a12b:free'
                : 'qwen3.5-4b'
        },
        {
            type: 'input',
            name: 'endpoint',
            message: 'Enter LLM API Endpoint URL:',
            default: (ans: any) => {
                if (ans.provider === 'cloud') return 'https://openrouter.ai/api/v1';
                return ans.localType === 'lmstudio'
                    ? 'http://127.0.0.1:1234/v1'
                    : 'http://127.0.0.1:11434/v1';
            }
        }
    ]);

    const client = new LLMClient(answers.provider as any, answers.endpoint, answers.model, answers.apiKey);
    const mockState = `- Device ID: "Switch1"\n  Hostname: "Switch1"\n  Access Mode: "PRIVILEGED_EXEC"\n  CLI Prompt: "Switch1#"`;

    const testGoal = 'Please enable the Cisco IOS shell in session mode, set a variable called SW_TARGET with value 10.0.1.5, and then loop over the targets 10.0.1.5 and 10.0.1.6 to test ping connectivity.';

    console.log('\n' + chalk.bold.yellow('🎯 Goal: ') + chalk.white(`"${testGoal}"`));
    console.log(chalk.dim(`\nExpected tool sequence:`));
    console.log(chalk.dim('  [1] enable_ios_shell → [2] define_shell_variable → [3] execute_shell_loop\n'));

 
    const messages: ChatMessage[] = [
        { role: 'system', content: PromptEngine.getSystemPrompt(mockState) },
        { role: 'user', content: testGoal }
    ];

    const MAX_TURNS = 10;
    let turn = 0;
    let totalToolCalls = 0;
    const toolCallLog: Array<{ turn: number; name: string; args: any; result: string }> = [];

    try {
        while (turn < MAX_TURNS) {
            turn++;

            const shellActive = mockDevice.isShellEnabled();
            const shellTools = ['define_shell_variable', 'execute_shell_loop', 'define_shell_function'];
            const activeTools = CiscoAgentTools.filter(t =>
                shellTools.includes(t.function.name) ? shellActive : true
            );

            const turnLabel = `TURN ${turn}/${MAX_TURNS} — ${shellActive ? chalk.green('Shell: ON') : chalk.yellow('Shell: OFF')} — Tools: ${chalk.cyan(activeTools.length + '/6')}`;
            printDivider(turnLabel);

            const spinner = ora(chalk.cyan('  Agent thinking...')).start();
            let response: ChatMessage;
            try {
                response = await client.generateCompletion(messages, activeTools);
                messages.push(response);
                spinner.succeed(chalk.green('  Thinking complete.'));
            } catch (err: any) {
                spinner.fail(chalk.red('  LLM request failed.'));
                console.error(chalk.red(`  ${err.message}`));
                break;
            }

          
            const thoughts = response.reasoning_content || response.content;
            if (thoughts && thoughts.trim()) {
                console.log('\n' + chalk.bold.magenta('  🧠 Reasoning:'));
                printThoughts(thoughts);
            }

          
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log(`\n  ${chalk.bold.yellow('🛠️  Tool Calls:')} ${chalk.dim(`(${response.tool_calls.length} call(s) this turn)`)}`);

                for (const call of response.tool_calls) {
                    totalToolCalls++;
                    let args: any = {};
                    try { args = JSON.parse(call.function.arguments); } catch {}

                    console.log(`\n  ${chalk.bold.cyan(`[Call #${totalToolCalls}]`)} ${chalk.green(call.function.name)}`);
                    console.log(`  ${chalk.dim('Arguments:')} ${chalk.magenta(JSON.stringify(args))}`);

                    const execSpinner = ora(chalk.dim(`  Executing "${call.function.name}"...`)).start();
                    const result = await executeMockTool(call);
                    execSpinner.succeed(chalk.dim(`  Result ready.`));

                    console.log(`  ${chalk.dim('Result:')} ${chalk.white(result.substring(0, 120))}${result.length > 120 ? chalk.dim('...') : ''}`);

                    toolCallLog.push({ turn, name: call.function.name, args, result });

                
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        name: call.function.name,
                        content: result
                    });
                }

            } else {
            
                printDivider();
                console.log('\n' + chalk.bold.green('✅  AGENT FINISHED — Final Response:'));
                if (thoughts && thoughts.trim()) {
                    printThoughts(thoughts);
                }
                break;
            }
        }

        if (turn >= MAX_TURNS) {
            console.log(chalk.bold.red('\n⚠️  Max turns reached without final answer.'));
        }

     
        printDivider('TOOL CALL SUMMARY');
        console.log(`\n  Total Turns  : ${chalk.cyan(turn)}`);
        console.log(`  Total Calls  : ${chalk.cyan(totalToolCalls)}`);
        console.log();
        toolCallLog.forEach((entry, i) => {
            const status = chalk.bold.green('✔');
            console.log(`  ${status} [Turn ${entry.turn}] ${chalk.green(entry.name)} ${chalk.dim(JSON.stringify(entry.args))}`);
        });

   
        const expectedTools = ['enable_ios_shell', 'define_shell_variable', 'execute_shell_loop'];
        const calledTools = toolCallLog.map(e => e.name);
        const allExpectedCalled = expectedTools.every(t => calledTools.includes(t));

        console.log('\n' + chalk.bold('  Validation:'));
        expectedTools.forEach(t => {
            const called = calledTools.includes(t);
            console.log(`    ${called ? chalk.green('✔') : chalk.red('✘')} ${t}`);
        });

        console.log('\n' + (allExpectedCalled
            ? chalk.bold.bgGreen.black('  ✅  ALL EXPECTED TOOL CALLS COMPLETED SUCCESSFULLY  ')
            : chalk.bold.bgRed.white('  ❌  SOME EXPECTED TOOL CALLS WERE MISSING  ')
        ) + '\n');

    } catch (err: any) {
        console.error(chalk.red(`\nFatal error: ${err.message}`));
    }
}

main();
