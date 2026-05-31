import chalk from 'chalk';
import http from 'http';
import { startSshServer } from './ssh';
import { startTelnetServer } from './telnet';


const SSH_PORT = 2222;
const TELNET_PORT = 2323;
const HTTP_PORT = 11434;

const availableModels: string[] = [];
let loadedModel: string | null = null;
const jobs = new Map<string, { model: string; progress: number; status: string }>();

function getTimestamp(): string {
    const now = new Date();
    return chalk.dim(`[${now.toLocaleTimeString()}]`);
}

function printDashboard(httpPort: number) {
    console.clear();
    console.log(chalk.bold.cyan(`
      :::::::::   ::::::::   ::::::::   ::::::::   ::::::::       ::::    ::::  ::::     ::::  
     :+:    :+: :+:    :+: :+:    :+: :+:    :+: :+:    :+:      +:+:+: :+:+:+ +:+    +:+:+:   
     +:+    +:+ +:+    +:+ +:+        +:+        +:+    +:+      +:+ +:+:+ +:+ +:+         +:+ 
     +#++:++#+  +#+    +:+ +#++:++#++ +#++:++#++ +#+    +:+      +#+  +:+  +#+ +#+    +#++:++#+ 
     +#+        +#+    +:+        +#+        +#+ +#+    +#+      +#+       +#+ +#+         +#+  
     #+#        #+#    #+# #+#    #+# #+#    #+# #+#    #+#      #+#       #+# #+#         #+#  
     ###         ########   ########   ########   ########       ###       ### #########   ###  
    `));
    console.log(chalk.bold.yellow('               Cisco IOS Multi-Protocol Test Simulator \n'));
    
    console.log(chalk.cyan('┌─────────────────────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('│') + chalk.bold.white('  PROTOCOL   │ PORT │ STATUS    │ CONNECTION URI                              ') + chalk.cyan('│'));
    console.log(chalk.cyan('├────────────┼──────┼───────────┼─────────────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + `  SSH        ` + chalk.cyan('│') + ` 2222 ` + chalk.cyan('│') + chalk.bold.green('  ACTIVE   ') + chalk.cyan('│') + ` ssh://127.0.0.1:2222                         ` + chalk.cyan('│'));
    console.log(chalk.cyan('│') + `  Telnet     ` + chalk.cyan('│') + ` 2323 ` + chalk.cyan('│') + chalk.bold.green('  ACTIVE   ') + chalk.cyan('│') + ` telnet://127.0.0.1:2323                      ` + chalk.cyan('│'));
    console.log(chalk.cyan('│') + `  NETCONF    ` + chalk.cyan('│') + ` 2222 ` + chalk.cyan('│') + chalk.bold.green('  ACTIVE   ') + chalk.cyan('│') + ` netconf://127.0.0.1:2222 (Subsystem)         ` + chalk.cyan('│'));
    const portStr = ` ${httpPort}`.padEnd(6);
    const uriStr = ` http://127.0.0.1:${httpPort}/v1`.padEnd(46);
    console.log(chalk.cyan('│') + `  HTTP (LLM) ` + chalk.cyan('│') + portStr + chalk.cyan('│') + chalk.bold.green('  ACTIVE   ') + chalk.cyan('│') + uriStr + chalk.cyan('│'));
    console.log(chalk.cyan('└─────────────────────────────────────────────────────────────────────────────┘'));
    console.log(chalk.bold.magenta('\nLogs:'));
    console.log(chalk.dim('-------------------------------------------------------------------------------'));
}


function log(msg: string) {
    console.log(`${getTimestamp()} ${msg}`);
}

function startHttpServer(port: number, logCb: (msg: string) => void, onBound: (actualPort: number) => void): http.Server {
    const server = http.createServer((req, res) => {
        const url = req.url || '';
        const method = req.method || 'GET';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        logCb(`${chalk.bold.green('[HTTP]')} ${method} ${url}`);

        if (method === 'GET' && (url === '/api/v1/models' || url === '/v1/models' || url === '/api/tags')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: availableModels }));
            return;
        }

        if (method === 'GET' && url === '/api/v1/models/loaded') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: loadedModel }));
            return;
        }

        if (method === 'POST' && url === '/api/v1/models/download') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const model = data.model;
                    if (!model) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'model parameter is required' }));
                        return;
                    }
                    const jobId = `job-${Math.random().toString(36).substring(2, 9)}`;
                    jobs.set(jobId, { model, progress: 0, status: 'downloading' });
                    
                    logCb(`Starting download job ${jobId} for model ${model}`);
                    
                    const interval = setInterval(() => {
                        const job = jobs.get(jobId);
                        if (job) {
                            if (job.progress < 100) {
                                job.progress = Math.min(100, job.progress + 30);
                                logCb(`Job ${jobId} progress: ${job.progress}%`);
                                if (job.progress === 100) {
                                    job.status = 'completed';
                                    if (!availableModels.includes(job.model)) {
                                        availableModels.push(job.model);
                                    }
                                    logCb(`Job ${jobId} completed. Added model ${job.model} to available models.`);
                                    clearInterval(interval);
                                }
                            }
                        } else {
                            clearInterval(interval);
                        }
                    }, 1500);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ job_id: jobId }));
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid json' }));
                }
            });
            return;
        }

        if (method === 'GET' && url.startsWith('/api/v1/models/download/status/')) {
            const jobId = url.substring('/api/v1/models/download/status/'.length);
            const job = jobs.get(jobId);
            if (!job) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'job not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: job.status,
                progress: `${job.progress}%`
            }));
            return;
        }

        if (method === 'POST' && url === '/api/v1/models/load') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const model = data.model;
                    if (!model) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'model parameter is required' }));
                        return;
                    }
                    logCb(`Loading model ${model} into memory`);
                    loadedModel = model;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success', message: `Model ${model} loaded successfully` }));
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid json' }));
                }
            });
            return;
        }


        if (method === 'POST' && (url === '/v1/chat/completions' || url === '/api/v1/chat')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.stream) {
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive'
                        });

                        const responseChunks = [
                            { choices: [{ delta: { role: 'assistant', content: 'Hello' } }] },
                            { choices: [{ delta: { content: '!' } }] },
                            { choices: [{ delta: { content: ' How **can**' } }] },
                            { choices: [{ delta: { content: ' I **' } }] },
                            { choices: [{ delta: { content: 'assist**' } }] },
                            { choices: [{ delta: { content: ' you?' } }] }
                        ];

                        let i = 0;
                        const interval = setInterval(() => {
                            if (i < responseChunks.length) {
                                res.write(`data: ${JSON.stringify(responseChunks[i])}\n\n`);
                                i++;
                            } else {
                                res.write('data: [DONE]\n\n');
                                res.end();
                                clearInterval(interval);
                            }
                        }, 50);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            choices: [{
                                message: {
                                    role: 'assistant',
                                    content: 'Hello! I am a simulated LLM.'
                                }
                            }]
                        }));
                    }
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid json' }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            startHttpServer(port + 1, logCb, onBound);
        } else {
            logCb(`${chalk.bold.red('[HTTP]')} Server error: ${err.message}`);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        onBound(port);
    });

    return server;
}


let httpServer: http.Server | null = null;
try {
    const sshServer = startSshServer(SSH_PORT, (msg) => {
        log(`${chalk.bold.blue('[SSH]')} ${msg}`);
    });

    const telnetServer = startTelnetServer(TELNET_PORT, (msg) => {
        log(`${chalk.bold.yellow('[Telnet]')} ${msg}`);
    });

    httpServer = startHttpServer(HTTP_PORT, (msg) => {
        log(msg);
    }, (actualPort) => {
        printDashboard(actualPort);
        log(`${chalk.bold.green('[HTTP]')} HTTP Server listening on port ${actualPort}`);
        log(`${chalk.bold.blue('[SSH]')} SSH & NETCONF Server listening on port ${SSH_PORT}`);
        log(`${chalk.bold.yellow('[Telnet]')} Telnet Server listening on port ${TELNET_PORT}`);
    });

    process.on('SIGINT', () => {
        log(chalk.red('Shutting down simulator servers...'));
        sshServer.close();
        telnetServer.close();
        if (httpServer) httpServer.close();
        process.exit(0);
    });
} catch (e: any) {
    console.error(chalk.red(`Failed to start simulator: ${e.message}`));
}
