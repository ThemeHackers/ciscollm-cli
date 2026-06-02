# ciscollm-cli

`ciscollm-cli` is an autonomous Cisco IOS automation agent CLI powered by LLM tool-calling. It allows network engineers to configure, troubleshoot, and simulate Cisco hardware safely and efficiently with strict safety guardrails.

---

## 🚀 Core Capabilities

1. **Intelligent Cisco Automation Swarm**
   * Multi-agent coordination with role-based routing (Core, Distribution, Access).
   * Supports both local models (Ollama, LM Studio) and cloud endpoints (OpenRouter).

2. **Enterprise-Grade Safety Guardrails**
   * **Command Firewall**: Intercepts high-risk commands (e.g. disabling AAA, removing access groups, shutting management interfaces).
   * **Dry-Run Validation**: Analyzes network topology beforehand to prevent accidental disruptions.
   * **Strict Command Reference**: Restricts execution to valid Cisco IOS command sets indexed from `cf_command_ref.pdf`.

3. **Atomic Transactions & Recovery**
   * **Atomic Replace**: Backs up configuration to flash and uses `configure replace` to restore state on failures.
   * **Command Inversion Fallback**: Generates reverse commands (e.g. `shutdown` -> `no shutdown`) to recover state if flash storage is unavailable.

4. **Live Visualization & Audits**
   * **Visual Control Dashboard**: A real-time SPA showing network topology maps, agent thinking logs, configuration diffs, and manual rollbacks.
   * **State Diff Engine**: Displays colorized differences (green/red/yellow) in routing tables, VLANs, and interfaces.
   * **Enterprise Audit Log**: Local, structured audit logging (`audit.log`) for compliance.

5. **Multi-Protocol Simulation & Adapters**
   * Adapters for Serial (Plink), SSH, Telnet, NETCONF XML, and Cisco Modeling Labs (CML).
   * Stateful mock IOS simulator server and local interactive shell (`ciscollm shell`).

---

## 📦 Quick Start

### Installation
Install the global executable via `npm`:
```bash
npm install -g ciscollm-cli
```

### Starting the Simulator Server (For Testing)
Start the multi-protocol test server (SSH, Telnet, NETCONF, and Mock LLM endpoint):
```bash
ciscollm server --ssh-port 2222 --telnet-port 2323 --http-port 11434
```

### Launching the Agent
Run the interactive setup wizard to configure the agent target and goals:
```bash
ciscollm run
```

---

## 🛠️ CLI Usage & Options

### `ciscollm run [options]`
Execute configuration or optimization tasks on target hardware.

| Option / Flag | Description | Default |
|---|---|---|
| `-g, --goal <intent>` | Configuration goal. Omit to launch the Interactive Setup Wizard. | - |
| `--protocol <type>` | Connection protocol (`serial`, `ssh`, `telnet`, `netconf`, `cml`). | `serial` |
| `--provider <type>` | LLM provider mode (`local`, `cloud`). | `local` |
| `--local-type <type>` | Local LLM service flavor (`ollama`, `lmstudio`). | `ollama` |
| `--model <name>` | LLM model name. | - |
| `--endpoint <url>` | LLM API server endpoint. | - |
| `--api-key <key>` | Cloud provider (OpenRouter) API key. | - |
| `-c, --com <ports>` | COM Port(s), comma-separated (e.g., `COM3,COM4`). | - |
| `--host <address>` | Target IP / hostnames, comma-separated. | - |
| `-u, --username <name>` | Login username. | - |
| `-p, --password <pass>` | Login password. | - |
| `--strict-command-ref` | Block commands not listed in `cf_command_ref.pdf`. | `false` |
| `--non-interactive` | Auto-reject high-risk commands instead of prompting for approval. | `false` |
| `--rbac-role <role>` | Authorization role (`admin`, `read_only`). | `admin` |
| `--dashboard-port <port>` | Live Visual Dashboard port. | `3000` |

### Other Commands
* `ciscollm server [options]` - Start mock SSH, Telnet, and LLM servers for sandbox testing.
* `ciscollm shell` - Launch a stateful interactive mock Cisco IOS command line directly.
* `ciscollm dashboard [--port <port>]` - Start the visual dashboard standalone.

---

## 💡 Quick Examples

#### 1. Configuring Interfaces via Local Simulation (SSH)
```bash
ciscollm run --protocol ssh --host 127.0.0.1 --port 2222 -u admin -p admin --goal "Configure GigabitEthernet0/1 with IP 192.168.2.1/24 and interface description 'LAN B'"
```

#### 2. Running local LLM (Ollama) against Simulation
```bash
ciscollm run --provider local --local-type ollama --endpoint http://127.0.0.1:11434/v1 --model qwen3.5:4b --protocol ssh --host 127.0.0.1 --port 2222 -u admin -p admin --goal "Show IP routing table"
```

#### 3. Strict Command Reference compliance
```bash
ciscollm run --strict-command-ref --protocol ssh --host 127.0.0.1 --port 2222 -u admin -p admin --goal "Configure router ospf 1 and advertise 192.168.1.0/24"
```

---

## 💻 Development

1. **Setup Workspace:**
   ```bash
   git clone https://github.com/ThemeHackers/ciscollm-cli.git
   cd ciscollm-cli
   npm install
   ```

2. **Build and Run:**
   ```bash
   npm run build
   npm start -- run
   ```

3. **Run Unit Tests:**
   ```bash
   npm run test
   ```
