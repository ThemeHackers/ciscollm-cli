import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from './ui';
import { PlinkSerialSession } from '../../infrastructure/protocols/PlinkSerial';

export async function runInteractiveWizard(options: any, requireGoal: boolean = true): Promise<any> {
    let provider = options.provider;
    let localType = options.localType;
    let apiKey = options.api_key || options.apiKey;
    let model = options.model;
    let endpoint = options.endpoint;
    let protocol = options.protocol;
    let com = options.com;
    let baud = options.baud;
    let host = options.host;
    let port = options.port;
    let username = options.username;
    let password = options.envPassword ? (process.env.CISCOLLM_PASS || '') : options.password;
    let goal = options.goal;

    if (requireGoal && goal && !localType && provider === 'local') {
        const { chosenLocalType } = await inquirer.prompt([
            {
                type: 'list',
                name: 'chosenLocalType',
                message: chalk.cyan('Select Local LLM Service:'),
                choices: [
                    { name: `${chalk.green('●')} Ollama          ${chalk.dim('(http://127.0.0.1:11434/v1)')}`, value: 'ollama' },
                    { name: `${chalk.magenta('●')} LM Studio       ${chalk.dim('(http://127.0.0.1:1234/v1)')}`, value: 'lmstudio' },
                    { name: `${chalk.yellow('●')} OpenRouter      ${chalk.dim('(Cloud API)')}`, value: '__cloud__' }
                ],
                default: 'ollama'
            }
        ]);
        if (chosenLocalType === '__cloud__') {
            provider = 'cloud';
            localType = undefined;
            if (!apiKey) {
                const { key } = await inquirer.prompt([{ type: 'password', name: 'key', message: 'OpenRouter API Key:' }]);
                apiKey = key;
            }
        } else {
            localType = chosenLocalType;
        }
    }

    if (!localType) localType = 'lmstudio';

    const detectedComs = await PlinkSerialSession.listAvailableComPorts();

    type StepName = 
        | 'PROVIDER'
        | 'LOCAL_TYPE'
        | 'API_KEY'
        | 'MODEL'
        | 'ENDPOINT'
        | 'PROTOCOL'
        | 'SERIAL_COM'
        | 'SERIAL_BAUD'
        | 'IP_HOST'
        | 'IP_PORT'
        | 'IP_USER'
        | 'IP_PASS'
        | 'GOAL'
        | 'CONFIRMATION';

    let currentStep: StepName = 'PROVIDER';
    const history: StepName[] = [];

    const answers: any = {
        provider: provider || 'local',
        localType: localType || 'lmstudio',
        apiKey: apiKey || '',
        model: model || '',
        endpoint: endpoint || '',
        protocol: protocol || 'serial',
        com: com || '',
        baud: baud || '9600',
        host: host || '',
        port: port || '',
        username: username || '',
        password: password || '',
        goal: goal || ''
    };

    const goForward = (nextStep: StepName) => {
        history.push(currentStep);
        currentStep = nextStep;
    };

    const goBack = () => {
        if (history.length > 0) {
            currentStep = history.pop()!;
        } else {
            logger.warn('Already at the first step.');
        }
    };

    const refreshConsole = () => {
        console.clear();
        logger.banner();
        console.log('');
    };

    while ((currentStep as string) !== 'CONFIRMATION') {
        refreshConsole();
        switch (currentStep as StepName) {
            case 'PROVIDER': {
                const ans = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'provider',
                        message: 'Select LLM Provider:',
                        choices: [
                            { name: 'Local (Ollama / LM Studio)', value: 'local' },
                            { name: 'Cloud (OpenRouter)', value: 'cloud' }
                        ],
                        default: answers.provider
                    }
                ]);
                answers.provider = ans.provider;
                if (answers.provider === 'local') {
                    goForward('LOCAL_TYPE');
                } else {
                    goForward('API_KEY');
                }
                break;
            }

            case 'LOCAL_TYPE': {
                const ans = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'localType',
                        message: 'Select Local LLM Service:',
                        choices: [
                            { name: 'Ollama', value: 'ollama' },
                            { name: 'LM Studio', value: 'lmstudio' },
                            { name: chalk.dim('< Go Back'), value: '__back__' }
                        ],
                        default: answers.localType
                    }
                ]);
                if (ans.localType === '__back__') {
                    goBack();
                } else {
                    answers.localType = ans.localType;
                    goForward('MODEL');
                }
                break;
            }

            case 'API_KEY': {
                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'apiKey',
                        message: 'Enter OpenRouter API Key (or type "back" to go back):',
                        default: answers.apiKey || undefined
                    }
                ]);
                if (ans.apiKey.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.apiKey = ans.apiKey;
                    goForward('MODEL');
                }
                break;
            }

            case 'MODEL': {
                const defaultModel = answers.model || (answers.provider === 'cloud' 
                    ? 'nvidia/nemotron-3-super-120b-a12b:free' 
                    : (answers.localType === 'lmstudio' ? 'google/gemma-4-12b-qat' : 'qwen3.5:4b'));

                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'model',
                        message: 'Enter LLM Model Name (or type "back" to go back):',
                        default: defaultModel
                    }
                ]);
                if (ans.model.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.model = ans.model;
                    goForward('ENDPOINT');
                }
                break;
            }

            case 'ENDPOINT': {
                const defaultEndpoint = answers.endpoint || (answers.provider === 'cloud'
                    ? 'https://openrouter.ai/api/v1'
                    : (answers.localType === 'lmstudio'
                        ? 'http://127.0.0.1:1234/v1'
                        : 'http://127.0.0.1:11434/v1'));

                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'endpoint',
                        message: 'Enter LLM API Endpoint URL (or type "back" to go back):',
                        default: defaultEndpoint
                    }
                ]);
                if (ans.endpoint.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.endpoint = ans.endpoint;
                    goForward('PROTOCOL');
                }
                break;
            }

            case 'PROTOCOL': {
                const ans = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'protocol',
                        message: 'Select Connection Protocol:',
                        choices: [
                            { name: 'serial', value: 'serial' },
                            { name: 'ssh', value: 'ssh' },
                            { name: 'telnet', value: 'telnet' },
                            { name: chalk.dim('< Go Back'), value: '__back__' }
                        ],
                        default: answers.protocol
                    }
                ]);
                if (ans.protocol === '__back__') {
                    goBack();
                } else {
                    answers.protocol = ans.protocol;
                    if (answers.protocol === 'serial') {
                        goForward('SERIAL_COM');
                    } else {
                        goForward('IP_HOST');
                    }
                }
                break;
            }

            case 'SERIAL_COM': {
                if (detectedComs.length > 0) {
                    const choices = detectedComs.map((port: string) => {
                        const match = /^(COM\d+)\b/i.exec(port);
                        const portValue = match ? match[1].toUpperCase() : port;
                        return { name: port, value: portValue };
                    });
                    choices.push({ name: 'Enter COM port(s) manually', value: '__manual__' });
                    choices.push({ name: chalk.dim('< Go Back'), value: '__back__' });

                    const ans = await inquirer.prompt([
                        {
                            type: 'checkbox',
                            name: 'coms',
                            message: 'Select COM Port(s) (Use Space to select, Enter to confirm):',
                            choices: choices,
                            validate: (input) => {
                                if (input.length === 0) {
                                    return 'You must select at least one option.';
                                }
                                if (input.includes('__back__') && input.length > 1) {
                                    return 'Cannot select "< Go Back" along with other ports.';
                                }
                                if (input.includes('__manual__') && input.length > 1) {
                                    return 'Cannot select "Enter COM port(s) manually" along with other ports.';
                                }
                                return true;
                            }
                        }
                    ]);

                    if (ans.coms.includes('__back__')) {
                        goBack();
                    } else if (ans.coms.includes('__manual__')) {
                        const manualAns = await inquirer.prompt([
                            {
                                type: 'input',
                                name: 'com',
                                message: 'Enter COM Port name(s) (comma-separated, e.g. COM3 or COM3,COM4):',
                                validate: (input) => input.trim().length > 0 ? true : 'COM port is required.'
                            }
                        ]);
                        answers.com = manualAns.com;
                        goForward('SERIAL_BAUD');
                    } else {
                        answers.com = ans.coms.join(',');
                        goForward('SERIAL_BAUD');
                    }
                } else {
                    const ans = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'com',
                            message: 'Enter COM Port name(s) (comma-separated, e.g. COM3 or COM3,COM4) (or type "back" to go back):',
                            default: answers.com || undefined,
                            validate: (input) => {
                                if (input.trim().toLowerCase() === 'back') return true;
                                return input.trim().length > 0 ? true : 'COM port is required.';
                            }
                        }
                    ]);
                    if (ans.com.trim().toLowerCase() === 'back') {
                        goBack();
                    } else {
                        answers.com = ans.com;
                        goForward('SERIAL_BAUD');
                    }
                }
                break;
            }

            case 'SERIAL_BAUD': {
                const ans = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'baud',
                        message: 'Select Serial Baud Rate:',
                        choices: [
                            '9600', '19200', '38400', '57600', '115200',
                            { name: chalk.dim('< Go Back'), value: '__back__' }
                        ],
                        default: answers.baud
                    }
                ]);
                if (ans.baud === '__back__') {
                    goBack();
                } else {
                    answers.baud = ans.baud;
                    goForward(requireGoal ? 'GOAL' : 'CONFIRMATION');
                }
                break;
            }

            case 'IP_HOST': {
                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'host',
                        message: 'Enter Target IP address(es) / Hostname(s) (comma-separated) (or type "back" to go back):',
                        default: answers.host || undefined,
                        validate: (input) => {
                            if (input.trim().toLowerCase() === 'back') return true;
                            return input.trim().length > 0 ? true : 'Host address is required.';
                        }
                    }
                ]);
                if (ans.host.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.host = ans.host;
                    goForward('IP_PORT');
                }
                break;
            }

            case 'IP_PORT': {
                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'port',
                        message: 'Enter Connection Port (leave empty for default) (or type "back" to go back):',
                        default: answers.port || undefined
                    }
                ]);
                if (ans.port.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.port = ans.port;
                    goForward('IP_USER');
                }
                break;
            }

            case 'IP_USER': {
                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'username',
                        message: 'Enter Device Username (leave empty if none) (or type "back" to go back):',
                        default: answers.username || undefined
                    }
                ]);
                if (ans.username.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.username = ans.username;
                    goForward('IP_PASS');
                }
                break;
            }

            case 'IP_PASS': {
                const ans = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'password',
                        message: 'Enter Device Password (or type "back" to go back):',
                        default: answers.password || undefined
                    }
                ]);
                if (ans.password === 'back') {
                    goBack();
                } else {
                    answers.password = ans.password;
                    goForward(requireGoal ? 'GOAL' : 'CONFIRMATION');
                }
                break;
            }

            case 'GOAL': {
                const ans = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'goal',
                        message: 'Enter Execution Goal / Intent (or type "back" to go back):',
                        default: answers.goal || undefined,
                        validate: (input) => {
                            if (input.trim().toLowerCase() === 'back') return true;
                            return input.trim().length > 0 ? true : 'Execution goal is required.';
                        }
                    }
                ]);
                if (ans.goal.trim().toLowerCase() === 'back') {
                    goBack();
                } else {
                    answers.goal = ans.goal;
                    goForward('CONFIRMATION');
                }
                break;
            }

            case 'CONFIRMATION':
                break;
        }
    }

    refreshConsole();

    return answers;
}
