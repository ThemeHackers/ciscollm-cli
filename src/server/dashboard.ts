import http from 'http';
import { MultiAgentCoordinator } from '../core/agent/MultiAgentCoordinator';
import { AuditLogger } from '../core/guardrails/AuditLogger';
import { StateDiff } from '../core/rollback/StateDiff';
import chalk from 'chalk';

let activeServer: http.Server | null = null;

export function startDashboardServer(coordinator: MultiAgentCoordinator, port: number): http.Server {
    if (activeServer) {
        try {
            activeServer.close();
        } catch {}
    }

    const server = http.createServer(async (req, res) => {
        const url = req.url || '';
        const method = req.method || 'GET';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (method === 'GET' && url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(getHtmlContent(port));
            return;
        }

        if (method === 'GET' && url === '/api/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                topology: coordinator.getTopology(),
                sessions: coordinator.getAllStates(),
                logs: AuditLogger.getEntries(),
                diffs: StateDiff.getDiffHistory(),
                audits: (coordinator as any).getAuditHistory ? (coordinator as any).getAuditHistory() : []
            }));
            return;
        }

        if (method === 'GET' && url === '/api/topology') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(coordinator.getTopology()));
            return;
        }

        if (method === 'GET' && url === '/api/sessions') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(coordinator.getAllStates()));
            return;
        }

        if (method === 'GET' && url === '/api/logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(AuditLogger.getEntries()));
            return;
        }

        if (method === 'GET' && url === '/api/diffs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(StateDiff.getDiffHistory()));
            return;
        }

        if (method === 'GET' && url === '/api/audits') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify((coordinator as any).getAuditHistory ? (coordinator as any).getAuditHistory() : []));
            return;
        }

        if (method === 'POST' && url === '/api/rollback') {
            const sessions = coordinator.getSessions();
            const promises = Array.from(sessions.entries()).map(async ([id, session]) => {
                await session.execute('configure replace flash:backup-agent.cfg force');
            });

            let count = 0;
            let errorMessage = '';

            const results = await Promise.allSettled(promises);
            results.forEach((res, idx) => {
                if (res.status === 'fulfilled') {
                    count++;
                } else {
                    const devId = Array.from(sessions.keys())[idx];
                    errorMessage += `${devId}: ${res.reason?.message || res.reason}; `;
                }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: count > 0 ? 'success' : 'failed', 
                message: `Rollback completed on ${count} of ${sessions.size} devices.${errorMessage ? ` Errors: ${errorMessage}` : ''}` 
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(chalk.bold.yellow(`\n[!] Warning: Port ${port} is already in use. Live Visual Dashboard could not start.`));
            console.warn(chalk.yellow(`    Please specify a different port using '--dashboard-port <port>' or free up port ${port}.\n`));
        } else {
            console.warn(chalk.bold.yellow(`\n[!] Warning: Visual Dashboard server error: ${err.message}\n`));
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(chalk.bold.green(`[+] Live HTML Visual Dashboard running at: http://localhost:${port}`));
    });

    activeServer = server;
    return server;
}

function getHtmlContent(port: number): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CiscoLLM Control Center</title>
    <!-- Google Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <!-- Vis Network CDN -->
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        :root {
            --bg-color: #0B0F19;
            --bg-deep: #070A12;
            --card-bg: rgba(17, 24, 39, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --border-glow: rgba(99, 102, 241, 0.2);
            --text-main: #F3F4F6;
            --text-muted: #9CA3AF;
            --accent: #6366F1;
            --accent-glow: rgba(99, 102, 241, 0.35);
            --success: #10B981;
            --warning: #F59E0B;
            --danger: #EF4444;
            --glass-blur: blur(12px);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-color);
            background-image: radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.05) 0%, transparent 40%),
                              radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.03) 0%, transparent 40%);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            overflow-x: hidden;
        }

        header {
            background: rgba(11, 15, 25, 0.8);
            backdrop-filter: var(--glass-blur);
            border-bottom: 1px solid var(--border-color);
            padding: 1rem 1.5rem;
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
            gap: 1rem;
        }

        .brand-container {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .brand-logo {
            width: 10px;
            height: 10px;
            background-color: var(--success);
            border-radius: 50%;
            box-shadow: 0 0 12px var(--success);
            animation: pulse-active 2s infinite;
        }

        header h1 {
            font-size: 1.35rem;
            font-weight: 700;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, #FFF 60%, var(--accent) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        header h1 span {
            font-weight: 400;
            font-size: 0.9rem;
            color: var(--text-muted);
            margin-left: 0.5rem;
        }

        .actions {
            display: flex;
            gap: 0.75rem;
            align-items: center;
        }

        button {
            padding: 0.6rem 1.2rem;
            border-radius: 0.5rem;
            border: 1px solid transparent;
            font-weight: 600;
            font-size: 0.9rem;
            cursor: pointer;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .btn-primary {
            background-color: var(--accent);
            color: white;
            box-shadow: 0 4px 14px var(--accent-glow);
        }

        .btn-primary:hover {
            background-color: #4f46e5;
            transform: translateY(-1px);
        }

        .btn-danger {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .btn-danger:hover {
            background: var(--danger);
            color: white;
            box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4);
            transform: translateY(-1px);
        }

        /* Responsive Metric Cards Grid */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 1rem;
            padding: 1.5rem 1.5rem 0 1.5rem;
        }

        .metric-card {
            background: var(--card-bg);
            backdrop-filter: var(--glass-blur);
            border: 1px solid var(--border-color);
            border-radius: 0.75rem;
            padding: 1.25rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .metric-card:hover {
            border-color: var(--border-glow);
            transform: translateY(-2px);
        }

        .metric-info h3 {
            font-size: 0.8rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 0.25rem;
        }

        .metric-info .value {
            font-size: 1.75rem;
            font-weight: 700;
        }

        .metric-icon {
            font-size: 1.5rem;
            opacity: 0.8;
            color: var(--accent);
        }

        /* Tabs Navigation */
        .tab-bar {
            display: flex;
            padding: 0 1.5rem;
            margin-top: 1.5rem;
            border-bottom: 1px solid var(--border-color);
            gap: 1.5rem;
            overflow-x: auto;
            white-space: nowrap;
        }

        .tab-button {
            background: none;
            border: none;
            color: var(--text-muted);
            padding: 0.75rem 0.25rem;
            font-weight: 500;
            font-size: 0.95rem;
            border-bottom: 2px solid transparent;
            border-radius: 0;
            transition: all 0.2s ease;
        }

        .tab-button:hover {
            color: var(--text-main);
        }

        .tab-button.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
            font-weight: 600;
        }

        /* Tab Contents Layout */
        .tab-content {
            display: none;
            flex: 1;
            padding: 1.5rem;
            animation: fadeIn 0.3s ease-in-out;
        }

        .tab-content.active {
            display: flex;
            flex-direction: column;
        }

        /* Panel Design */
        .panel-container {
            display: grid;
            grid-template-columns: 1.4fr 1fr;
            gap: 1.5rem;
            flex: 1;
        }

        .panel {
            background: var(--card-bg);
            backdrop-filter: var(--glass-blur);
            border: 1px solid var(--border-color);
            border-radius: 0.75rem;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-height: 450px;
        }

        .panel-header {
            padding: 1rem 1.25rem;
            border-bottom: 1px solid var(--border-color);
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 1rem;
        }

        .panel-content {
            flex: 1;
            overflow-y: auto;
            padding: 1.25rem;
        }

        /* Topology Canvas style */
        #topology-canvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: var(--bg-deep);
        }

        /* Active Sessions cards styling */
        .session-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1rem;
        }

        .session-card {
            background: rgba(30, 41, 59, 0.4);
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            transition: border-color 0.2s ease;
        }

        .session-card:hover {
            border-color: var(--accent);
        }

        .session-title {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: 600;
        }

        .session-badge {
            font-size: 0.75rem;
            padding: 0.15rem 0.4rem;
            border-radius: 0.25rem;
            font-weight: 600;
            background: rgba(99, 102, 241, 0.15);
            color: #a5b4fc;
        }

        .session-field {
            font-size: 0.85rem;
            color: var(--text-muted);
            display: flex;
            justify-content: space-between;
        }

        .session-field span:last-child {
            color: var(--text-main);
            font-family: 'JetBrains Mono', monospace;
        }

        /* Log console styling */
        .console-controls {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            margin-bottom: 1rem;
            align-items: center;
        }

        .search-input {
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid var(--border-color);
            border-radius: 0.375rem;
            padding: 0.5rem 0.75rem;
            color: var(--text-main);
            font-family: inherit;
            font-size: 0.85rem;
            flex: 1;
            min-width: 200px;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent);
        }

        .filter-group {
            display: flex;
            gap: 0.35rem;
            overflow-x: auto;
        }

        .filter-btn {
            background: rgba(30, 41, 59, 0.5);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            padding: 0.35rem 0.75rem;
            font-size: 0.8rem;
            border-radius: 0.25rem;
            font-weight: 500;
        }

        .filter-btn.active {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }

        .log-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .log-item {
            background: rgba(15, 23, 42, 0.4);
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            padding: 0.85rem 1rem;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            animation: slideIn 0.2s ease-out;
        }

        .log-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 0.35rem;
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .status-badge {
            display: inline-block;
            padding: 0.15rem 0.4rem;
            border-radius: 0.25rem;
            font-size: 0.725rem;
            font-weight: 700;
            text-transform: uppercase;
        }

        .status-success { background: rgba(16, 185, 129, 0.15); color: var(--success); }
        .status-rollback { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
        .status-blocked { background: rgba(239, 68, 68, 0.15); color: var(--danger); }

        .log-thought {
            color: var(--text-muted);
            font-style: italic;
            margin-top: 0.35rem;
            font-family: 'Outfit', sans-serif;
            font-size: 0.8rem;
            border-left: 2px solid var(--border-glow);
            padding-left: 0.5rem;
        }

        /* Diff styling */
        .diff-added { color: var(--success); font-family: 'JetBrains Mono', monospace; }
        .diff-removed { color: var(--danger); font-family: 'JetBrains Mono', monospace; }
        .diff-modified { color: var(--warning); font-family: 'JetBrains Mono', monospace; }

        /* Comparative Audit Styling */
        .audit-visualizer {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
        }

        .audit-card {
            background: rgba(30, 41, 59, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            padding: 1rem;
        }

        .audit-card h4 {
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            margin-bottom: 0.75rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 0.35rem;
        }

        .audit-metric {
            display: flex;
            justify-content: space-between;
            padding: 0.5rem 0;
            border-bottom: 1px dashed rgba(255,255,255,0.03);
            font-size: 0.9rem;
        }

        .audit-metric:last-child {
            border-bottom: none;
        }

        /* Connection Status Overlay */
        .disconnect-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(7, 10, 18, 0.9);
            backdrop-filter: blur(8px);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.4s ease;
        }

        .disconnect-overlay.visible {
            opacity: 1;
            pointer-events: auto;
        }

        .disconnect-box {
            background: rgba(17, 24, 39, 0.85);
            border: 1px solid var(--danger);
            border-radius: 1rem;
            padding: 2.5rem;
            text-align: center;
            box-shadow: 0 0 30px rgba(239, 68, 68, 0.15);
            max-width: 450px;
            width: 90%;
            animation: slideIn 0.3s ease-out;
        }

        .disconnect-title {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--danger);
            margin-bottom: 1rem;
        }

        .disconnect-text {
            color: var(--text-muted);
            font-size: 0.95rem;
            line-height: 1.5;
            margin-bottom: 1.5rem;
        }

        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(255, 255, 255, 0.1);
            border-top: 4px solid var(--danger);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1.5rem auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* Responsive Layout Overrides */
        @media (max-width: 1024px) {
            .panel-container {
                grid-template-columns: 1fr;
            }
            .audit-visualizer {
                grid-template-columns: 1fr;
            }
        }

        @media (max-width: 640px) {
            header {
                padding: 0.75rem 1rem;
            }
            header h1 {
                font-size: 1.15rem;
            }
            .metrics-grid {
                grid-template-columns: 1fr;
                padding: 1rem 1rem 0 1rem;
            }
            .tab-bar {
                padding: 0 1rem;
                margin-top: 1rem;
            }
            .tab-content {
                padding: 1rem;
            }
            .console-controls {
                flex-direction: column;
                align-items: stretch;
            }
        }

        /* Keyframes */
        @keyframes pulse-active {
            0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
            70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
            100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(3px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes slideIn {
            from { transform: translateY(5px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
    </style>
</head>
<body>
    <header>
        <div class="brand-container">
            <div class="brand-logo"></div>
            <h1>CiscoLLM <span>Visual Control Dashboard v1.1.0</span></h1>
        </div>
        <div class="actions">
            <button class="btn-primary" onclick="reloadData()">Refresh</button>
            <button class="btn-danger" onclick="triggerRollback()">Emergency Rollback</button>
        </div>
    </header>

    <!-- Disconnect Overlay -->
    <div id="disconnect-overlay" class="disconnect-overlay">
        <div class="disconnect-box">
            <div class="spinner"></div>
            <div class="disconnect-title">Connection Lost</div>
            <div class="disconnect-text">
                Disconnected from the CiscoLLM Swarm. Ensure your local CLI execution is active and the API server is running.
            </div>
        </div>
    </div>

    <!-- Top Metrics Overview -->
    <div class="metrics-grid">
        <div class="metric-card">
            <div class="metric-info">
                <h3>Devices Swarm</h3>
                <div class="value" id="count-devices">0</div>
            </div>
            <div class="metric-icon">💻</div>
        </div>
        <div class="metric-card">
            <div class="metric-info">
                <h3>Topology Links</h3>
                <div class="value" id="count-links">0</div>
            </div>
            <div class="metric-icon">🔗</div>
        </div>
        <div class="metric-card">
            <div class="metric-info">
                <h3>Action Logs</h3>
                <div class="value" id="count-logs">0</div>
            </div>
            <div class="metric-icon">📜</div>
        </div>
        <div class="metric-card">
            <div class="metric-info">
                <h3>Safety Audits</h3>
                <div class="value" style="color: var(--success);">Passed</div>
            </div>
            <div class="metric-icon">🛡️</div>
        </div>
    </div>

    <!-- Tab Bar -->
    <div class="tab-bar">
        <button class="tab-button active" onclick="switchTab('topology-tab')">Network Topology</button>
        <button class="tab-button" onclick="switchTab('sessions-tab')">Device Sessions</button>
        <button class="tab-button" onclick="switchTab('logs-tab')">Agent Action Logs</button>
        <button class="tab-button" onclick="switchTab('diffs-tab')">Config Diffs</button>
    </div>

    <!-- Tab Contents -->
    <!-- 1. Topology -->
    <div id="topology-tab" class="tab-content active">
        <div class="panel-container">
            <div class="panel">
                <div class="panel-header">Interactive Swarm Topology Map</div>
                <div style="flex: 1; overflow: hidden; position: relative;">
                    <div id="topology-canvas"></div>
                </div>
            </div>
            <div class="panel">
                <div class="panel-header">Pre/Post Flight Audits Compare</div>
                <div class="panel-content" id="audit-compare-container">
                    <div style="color: var(--text-muted);">No comparison snapshot captured. Trigger commands to evaluate audits.</div>
                </div>
            </div>
        </div>
    </div>

    <!-- 2. Device Sessions -->
    <div id="sessions-tab" class="tab-content">
        <div class="session-grid" id="sessions-container">
            <div style="color: var(--text-muted); grid-column: 1/-1;">No connected device sessions found.</div>
        </div>
    </div>

    <!-- 3. Agent Logs -->
    <div id="logs-tab" class="tab-content">
        <div class="panel" style="min-height: 480px;">
            <div class="panel-header">Real-time Swarm Command Firewalls & Logs</div>
            <div class="panel-content">
                <div class="console-controls">
                    <input type="text" id="log-search" class="search-input" placeholder="Search commands, thoughts, or error logs..." oninput="filterLogs()">
                    <div class="filter-group">
                        <button class="filter-btn active" id="filter-all" onclick="setLogFilter('ALL')">All</button>
                        <button class="filter-btn" id="filter-success" onclick="setLogFilter('SUCCESS')">Success</button>
                        <button class="filter-btn" id="filter-blocked" onclick="setLogFilter('BLOCKED')">Blocked</button>
                        <button class="filter-btn" id="filter-rollback" onclick="setLogFilter('ROLLBACK')">Rollback</button>
                    </div>
                </div>
                <div class="log-list" id="logs-container">
                    <div style="color: var(--text-muted);">No log entries recorded yet.</div>
                </div>
            </div>
        </div>
    </div>

    <!-- 4. Diffs -->
    <div id="diffs-tab" class="tab-content">
        <div class="panel" style="min-height: 480px;">
            <div class="panel-header">Dynamic Configuration Diffs (Before & After Snapshots)</div>
            <div class="panel-content" id="diffs-container">
                <div style="color: var(--text-muted);">No configuration diffs captured yet. Run changes to see differences.</div>
            </div>
        </div>
    </div>

    <script>
        let network = null;
        let activeTab = 'topology-tab';
        let rawLogs = [];
        let logFilter = 'ALL';
        let isConnected = true;

        let lastTopologyJson = '';
        let lastSessionsJson = '';
        let lastLogsJson = '';
        let lastDiffsJson = '';
        let lastAuditsJson = '';

        function switchTab(tabId) {
            document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            const selectedBtn = Array.from(document.querySelectorAll('.tab-button')).find(btn => btn.getAttribute('onclick').includes(tabId));
            if (selectedBtn) selectedBtn.classList.add('active');
            
            document.getElementById(tabId).classList.add('active');
            activeTab = tabId;

            if (tabId === 'topology-tab' && network) {
                setTimeout(() => network.fit(), 200);
            }
        }

        async function reloadData() {
            try {
                const res = await fetch('/api/state');
                if (!res.ok) throw new Error("HTTP " + res.status);
                const data = await res.json();

                if (!isConnected) {
                    isConnected = true;
                    document.getElementById('disconnect-overlay').classList.remove('visible');
                }

                // Update UI sections
                updateTopologyUI(data.topology);
                updateSessionsUI(data.sessions);
                updateLogsUI(data.logs);
                updateDiffsUI(data.diffs);
                updateAuditsUI(data.audits);

            } catch (e) {
                console.error("Connection failed: ", e);
                if (isConnected) {
                    isConnected = false;
                    document.getElementById('disconnect-overlay').classList.add('visible');
                }
            }
        }

        function updateTopologyUI(data) {
            const stableData = {
                nodes: (data && data.nodes) ? data.nodes : [],
                links: (data && data.links) ? data.links : []
            };
            const currentJson = JSON.stringify(stableData);
            if (currentJson === lastTopologyJson) {
                return;
            }
            lastTopologyJson = currentJson;
            
            const container = document.getElementById('topology-canvas');
            const nodes = [];
            const edges = [];

            if (data && data.nodes) {
                document.getElementById('count-devices').innerText = data.nodes.length;
                data.nodes.forEach(node => {
                    const isSwitch = node.toLowerCase().includes('switch');
                    nodes.push({
                        id: node,
                        label: node,
                        shape: 'box',
                        margin: 12,
                        color: {
                            background: isSwitch ? '#1E293B' : '#4F46E5',
                            border: '#6366F1'
                        },
                        font: { color: '#ffffff', size: 14, face: 'Outfit' }
                    });
                });
            }

            if (data && data.links) {
                document.getElementById('count-links').innerText = data.links.length;
                data.links.forEach((link, idx) => {
                    edges.push({
                        id: 'e' + idx,
                        from: link.localDeviceId,
                        to: link.remoteDeviceId,
                        label: link.localInterface + ' ↔ ' + link.remoteInterface,
                        font: { color: '#9CA3AF', size: 10, strokeWidth: 0, face: 'Outfit' },
                        color: { color: '#4B5563' }
                    });
                });
            }

            const visData = {
                nodes: new vis.DataSet(nodes),
                edges: new vis.DataSet(edges)
            };

            const options = {
                physics: { enabled: true, solver: 'repulsion', repulsion: { nodeDistance: 150 } },
                layout: { randomSeed: 42 },
                interaction: { keyboard: false }
            };

            if (network) network.destroy();
            network = new vis.Network(container, visData, options);
        }

        function updateSessionsUI(data) {
            const currentJson = JSON.stringify(data);
            if (currentJson === lastSessionsJson) {
                return;
            }
            lastSessionsJson = currentJson;
            const container = document.getElementById('sessions-container');

            const keys = Object.keys(data);
            if (keys.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); grid-column: 1/-1;">No connected device sessions found.</div>';
                return;
            }

            let cards = '';
            keys.forEach(id => {
                const session = data[id];
                cards += '<div class="session-card">';
                cards += '<div class="session-title">';
                cards += '<span>' + (session.hostname || id) + '</span>';
                cards += '<span class="session-badge">' + session.currentMode + '</span>';
                cards += '</div>';
                cards += '<div class="session-field"><span>Target URI</span><span>' + id + '</span></div>';
                cards += '<div class="session-field"><span>Prompt</span><span>' + session.prompt + '</span></div>';
                cards += '<div class="session-field"><span>Status</span><span style="color: var(--success);">● Active</span></div>';
                cards += '</div>';
            });
            container.innerHTML = cards;
        }

        function updateLogsUI(logs) {
            rawLogs = logs;
            const currentJson = JSON.stringify(rawLogs);
            if (currentJson === lastLogsJson) {
                return;
            }
            lastLogsJson = currentJson;

            document.getElementById('count-logs').innerText = rawLogs.length;
            filterLogs();
        }

        function setLogFilter(filter) {
            logFilter = filter;
            document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
            const filterId = 'filter-' + filter.toLowerCase();
            const btn = document.getElementById(filterId);
            if (btn) btn.classList.add('active');
            filterLogs();
        }

        function filterLogs() {
            const container = document.getElementById('logs-container');
            const searchVal = document.getElementById('log-search').value.toLowerCase().trim();

            const filtered = rawLogs.filter(log => {
                if (logFilter !== 'ALL' && log.status !== logFilter) return false;
                if (searchVal) {
                    const matchCommand = log.command && log.command.toLowerCase().includes(searchVal);
                    const matchThought = log.thought && log.thought.toLowerCase().includes(searchVal);
                    const matchReason = log.reason && log.reason.toLowerCase().includes(searchVal);
                    const matchDevice = log.deviceId && log.deviceId.toLowerCase().includes(searchVal);
                    return matchCommand || matchThought || matchReason || matchDevice;
                }
                return true;
            });

            if (filtered.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted);">No matching log entries found.</div>';
                return;
            }

            container.innerHTML = filtered.map(log => {
                const statusClass = 'status-' + log.status.toLowerCase();
                let itemHtml = '<div class="log-item">';
                itemHtml += '<div class="log-header">';
                itemHtml += '<span><strong>[' + log.deviceId + ']</strong> ' + log.command + '</span>';
                itemHtml += '<span class="status-badge ' + statusClass + '">' + log.status + '</span>';
                itemHtml += '</div>';
                if (log.thought) {
                    itemHtml += '<div class="log-thought">AI: ' + log.thought + '</div>';
                }
                if (log.reason) {
                    itemHtml += '<div style="color: var(--danger); margin-top: 0.35rem;">Rule Violation: ' + log.reason + '</div>';
                }
                itemHtml += '</div>';
                return itemHtml;
            }).join('');
        }

        function updateDiffsUI(data) {
            const currentJson = JSON.stringify(data);
            if (currentJson === lastDiffsJson) {
                return;
            }
            lastDiffsJson = currentJson;
            const container = document.getElementById('diffs-container');

            if (!data || data.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted);">No configuration diffs captured yet. Apply modifications via CLI.</div>';
                return;
            }

            let diffsHtml = data.map(item => {
                let diffHtml = '';
                const diff = item.diff;

                if (diff.hostnameChanged) {
                    diffHtml += '<div class="diff-modified">Hostname Changed: "' + diff.hostnameChanged.before + '" ➔ "' + diff.hostnameChanged.after + '"</div>';
                }
                if (diff.modifiedInterfaces && diff.modifiedInterfaces.length > 0) {
                    diff.modifiedInterfaces.forEach(inf => {
                        diffHtml += '<div class="diff-modified">Interface ' + inf.name + ' changes:</div>';
                        inf.changes.forEach(c => {
                            diffHtml += '<div style="padding-left: 1rem;">- ' + c.field + ': "' + c.before + '" ➔ "' + c.after + '"</div>';
                        });
                    });
                }
                if (diff.addedRoutes && diff.addedRoutes.length > 0) {
                    diff.addedRoutes.forEach(r => {
                        diffHtml += '<div class="diff-added">+ ip route ' + r.network + ' ' + r.mask + ' ' + (r.nextHop || '') + '</div>';
                    });
                }
                if (diff.removedRoutes && diff.removedRoutes.length > 0) {
                    diff.removedRoutes.forEach(r => {
                        diffHtml += '<div class="diff-removed">- ip route ' + r.network + ' ' + r.mask + ' ' + (r.nextHop || '') + '</div>';
                    });
                }
                if (diff.addedVlans && diff.addedVlans.length > 0) {
                    diffHtml += '<div class="diff-added">+ VLANs Added: ' + diff.addedVlans.join(', ') + '</div>';
                }
                if (diff.removedVlans && diff.removedVlans.length > 0) {
                    diffHtml += '<div class="diff-removed">- VLANs Removed: ' + diff.removedVlans.join(', ') + '</div>';
                }

                if (!diffHtml) {
                    diffHtml = '<div style="color: var(--text-muted);">No configuration changes made in this step.</div>';
                }

                let wrapperHtml = '<div style="border-bottom: 1px solid var(--border-color); padding: 0.5rem 0;">';
                wrapperHtml += '<div style="font-size: 0.8rem; color: var(--text-muted);">' + new Date(item.timestamp).toLocaleTimeString() + ' - Device: ' + item.deviceId + '</div>';
                wrapperHtml += diffHtml;
                wrapperHtml += '</div>';
                return wrapperHtml;
            }).join('');

            container.innerHTML = diffsHtml;
        }

        function updateAuditsUI(audits) {
            const currentJson = JSON.stringify(audits);
            if (currentJson === lastAuditsJson) {
                return;
            }
            lastAuditsJson = currentJson;
            const container = document.getElementById('audit-compare-container');

            if (!audits || audits.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted);">No comparison snapshot captured. Trigger commands to evaluate audits.</div>';
                return;
            }

            let html = '';
            audits.forEach(audit => {
                const pre = audit.pre;
                const post = audit.post;
                
                html += '<div style="margin-bottom: 2rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1.5rem;">';
                html += '<div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.75rem;">Device Target: <strong>' + audit.deviceId + '</strong> (' + new Date(audit.timestamp).toLocaleTimeString() + ')</div>';
                html += '<div class="audit-visualizer">';
                
                // Pre-flight Card
                html += '<div class="audit-card">';
                html += '<h4>Pre-Flight Inspection</h4>';
                html += '<div class="audit-metric"><span>Gateway Reachability</span>' + (pre.pingReachability ? '<span style="color: var(--success);">● Reachable</span>' : '<span style="color: var(--danger);">● Unreachable</span>') + '</div>';
                html += '<div class="audit-metric"><span>Down Interfaces</span><span>' + pre.downInterfacesCount + ' down</span></div>';
                html += '<div class="audit-metric"><span>Dynamic Routes</span><span>' + pre.dynamicRoutesCount + ' routes</span></div>';
                html += '<div class="audit-metric"><span>Routing Adjacencies</span><span>' + pre.routingAdjacenciesCount + ' peers</span></div>';
                html += '</div>';

                // Post-flight Card
                html += '<div class="audit-card">';
                html += '<h4>Post-Flight Inspection</h4>';
                html += '<div class="audit-metric"><span>Gateway Reachability</span>' + (post.pingReachability ? '<span style="color: var(--success);">● Reachable</span>' : '<span style="color: var(--danger);">● Unreachable</span>') + '</div>';
                html += '<div class="audit-metric"><span>Down Interfaces</span><span>' + post.downInterfacesCount + ' down</span></div>';
                html += '<div class="audit-metric"><span>Dynamic Routes</span><span>' + post.dynamicRoutesCount + ' routes</span></div>';
                html += '<div class="audit-metric"><span>Routing Adjacencies</span><span>' + post.routingAdjacenciesCount + ' peers</span></div>';
                html += '</div>';

                html += '</div>'; // End audit-visualizer

                // Status message
                if (pre.pingReachability && !post.pingReachability) {
                    html += '<div style="color: var(--danger); margin-top: 1rem; font-weight: 600; font-size: 0.9rem;">[!] WARNING: Network gateway reachability was LOST during this configuration window!</div>';
                } else if (!pre.pingReachability && post.pingReachability) {
                    html += '<div style="color: var(--success); margin-top: 1rem; font-weight: 600; font-size: 0.9rem;">[+] SUCCESS: Network gateway reachability was RESTORED during this configuration window!</div>';
                } else {
                    html += '<div style="color: var(--success); margin-top: 1rem; font-weight: 600; font-size: 0.9rem;">[+] Audit check: Network gateway reachability is stable.</div>';
                }
                
                html += '</div>'; // End outer wrapper
            });

            container.innerHTML = html;
        }

        async function triggerRollback() {
            if (confirm('Are you sure you want to perform an Emergency Configuration Rollback on all devices?')) {
                try {
                    const res = await fetch('/api/rollback', { method: 'POST' });
                    const result = await res.json();
                    alert(result.message || 'Rollback triggered.');
                    reloadData();
                } catch (e) {
                    alert('Rollback failed: ' + e.message);
                }
            }
        }

        setInterval(reloadData, 2500);
        reloadData();
    </script>
</body>
</html>`;
}
