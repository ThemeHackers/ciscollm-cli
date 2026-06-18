# ciscollm-cli

`ciscollm-cli` is an autonomous Cisco IOS automation agent CLI powered by LLM tool-calling. It allows network engineers to configure, troubleshoot, monitor, and simulate Cisco hardware safely and efficiently with strict enterprise safety guardrails and closed-loop auto-healing capabilities.

---

## 🚀 Core Capabilities

1. **Intelligent Cisco Automation Swarm**
   * Multi-agent coordination with role-based routing (Core, Distribution, Access).
   * Supports both local models (Ollama, LM Studio) and cloud endpoints (OpenRouter).

2. **Enterprise-Grade Safety Guardrails & Custom Playbook**
   * **Command Firewall**: Intercepts high-risk commands (e.g., disabling AAA, removing access groups, shutting management interfaces).
   * **Custom Playbook (`.ciscollm-guard.yaml`)**: Custom block lists, protected interfaces, and confirmation rules loaded dynamically from your project directory.
   * **Dry-Run Validation**: Analyzes network topology beforehand to prevent accidental disruptions.
   * **Strict Command Reference**: Restricts execution to valid Cisco IOS command sets indexed from `cf_command_ref.pdf`.

3. **Closed-Loop Auto-Healing (AIOps)**
   * Real-time monitoring of syslog notification events (interface state transitions, OSPF adjacency status changes).
   * Autonomous diagnosis, remediation planning, validation, and rollback via an AI-driven OODA loop.

4. **Atomic Transactions & Recovery**
   * **Atomic Replace**: Backs up configuration to flash and uses `configure replace` to restore state on failures.
   * **Command Inversion Fallback**: Generates reverse commands (e.g., `shutdown` -> `no shutdown`) to recover state if flash storage is unavailable.

5. **Live Visualization & Audits**
   * **Visual Control Dashboard**: A real-time SPA showing network topology maps, agent thinking logs, configuration diffs, and manual rollbacks.
   * **State Diff Engine**: Displays colorized differences (green/red/yellow) in routing tables, VLANs, and interfaces.
   * **Enterprise Audit Log**: Local, structured audit logging (`audit.log` & `healing-audit.log`) for compliance.

6. **Multi-Protocol Simulation & Adapters**
   * Adapters for Serial (Plink), SSH, Telnet, NETCONF XML, and Cisco Modeling Labs (CML).
   * Stateful mock IOS simulator server and local interactive shell (`ciscollm shell`).

---

## 📦 Quick Start

### Installation
Install the global executable via `npm`:
```bash
npm install -g ciscollm-cli
```

### Starting the Simulator Server (For Sandbox Testing)
Start the multi-protocol test server (SSH, Telnet, NETCONF, and Mock LLM endpoint):
```bash
ciscollm server --ssh-port 2222 --telnet-port 2323 --http-port 11434
```

### Launching the Agent
Run the interactive setup wizard to configure the agent target and goals:
```bash
ciscollm run
```

### Launching the Stateful Mock Cisco IOS Shell
Launch the mock CLI simulator shell directly:
```bash
ciscollm shell
```

### Starting the Visual Control Dashboard
Start the visual dashboard standalone:
```bash
ciscollm dashboard --port 3000
```

---

## 🛠️ CLI Usage & Options

### 1. `ciscollm run [options]`
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
| `-b, --baud <rate>` | Serial transmission baud rate constraint. | `9600` |
| `--host <address>` | Target IP / hostnames, comma-separated. | - |
| `--port <port>` | Target connection port. | - |
| `-u, --username <name>` | Login username. | - |
| `-p, --password <pass>` | Login password. | - |
| `--env-password` | Read device password from `$CISCOLLM_PASS` environment variable. | `false` |
| `--private-key <path>` | SSH private key file path. | - |
| `--passphrase <passphrase>`| Passphrase for the SSH private key file. | - |
| `--netconf-ready-timeout <ms>` | NETCONF SSH connection ready timeout. | - |
| `--netconf-hello-timeout <ms>` | NETCONF hello exchange timeout. | - |
| `--netconf-rpc-timeout <ms>`   | NETCONF RPC invocation timeout. | - |
| `--netconf-keepalive-interval <ms>` | NETCONF SSH keepalive interval. | - |
| `--strict-command-ref` | Block commands not listed in `cf_command_ref.pdf`. | `false` |
| `--no-ref-telemetry` | Disable command-reference telemetry logs during startup. | `false` |
| `--non-interactive` | Auto-reject high-risk commands instead of prompting for approval. | `false` |
| `--rbac-role <role>` | Authorization role (`admin`, `read_only`). | `admin` |
| `--dashboard-port <port>` | Live Visual Dashboard port. | `3000` |

### 2. `ciscollm monitor [options]`
Start the Closed-Loop Auto-Diagnosis & Healing Monitor (AIOps) to listen for device syslog events and heal outages autonomously.

| Option / Flag | Description | Default |
|---|---|---|
| `--protocol <type>` | Connection protocol (`serial`, `ssh`, `telnet`). | `serial` |
| `--provider <type>` | LLM provider mode (`local`, `cloud`). | `local` |
| `--api-key <key>` | Cloud provider (OpenRouter) API key. | - |
| `-c, --com <ports>` | COM Port(s), comma-separated. | - |
| `-b, --baud <rate>` | Serial transmission baud rate constraint. | `9600` |
| `--host <address>` | Target IP / hostnames, comma-separated. | - |
| `--port <port>` | Target connection port. | - |
| `-u, --username <name>` | Login username. | - |
| `-p, --password <pass>` | Login password. | - |
| `--env-password` | Read device password from `$CISCOLLM_PASS` environment variable. | `false` |
| `--private-key <path>` | SSH private key file path. | - |
| `--passphrase <passphrase>`| Passphrase for the SSH private key file. | - |
| `--local-type <type>` | Local LLM service flavor (`ollama`, `lmstudio`). | `ollama` |
| `--model <name>` | LLM model name. | - |
| `--endpoint <url>` | LLM API server endpoint. | - |
| `--non-interactive` | Enable completely autonomous, non-interactive healing (skip prompts). | `false` |
| `--min-confidence <conf>` | Minimum AI confidence threshold (0.00 to 1.00) required to apply remediation. | `0.80` |

### Other Commands
* `ciscollm server [options]` - Start mock SSH (`--ssh-port`), Telnet (`--telnet-port`), and HTTP LLM (`--http-port`) servers.
* `ciscollm shell` - Launch a stateful interactive mock Cisco IOS command line directly.
* `ciscollm dashboard [--port <port>]` - Start the visual dashboard standalone (default: 3000).

---

## 🛡️ Custom Safety Playbook (`.ciscollm-guard.yaml`)

You can create a `.ciscollm-guard.yaml` file in the directory where you execute the CLI to define custom safety rules for the command firewall.

### Example Configuration:
```yaml
# .ciscollm-guard.yaml
protectedInterfaces:
  - "GigabitEthernet0/1"
  - "Vlan1"

blockedCommands:
  - "reload"
  - "write erase"
  - "erase startup-config"
  - "crypto key zeroize"

requireConfirmationCommands:
  - "interface Loopback"
  - "ip route 0.0.0.0"
```

* **`protectedInterfaces`**: Safeguards critical interfaces from shutdown or IP removal.
* **`blockedCommands`**: Commands that are strictly banned and rejected automatically.
* **`requireConfirmationCommands`**: Overrides non-interactive mode or triggers an explicit administrator warning before execution.

---

## 🧠 AIOps Auto-Healing (OODA Loop) Workflow

When running `ciscollm monitor`, the agent acts in a closed loop to keep network interfaces and protocols operational:

```
    [Observe]
Syslog Notification (e.g., %LINK-3-UPDOWN)
        │
        ▼
    [Orient]
Gather Diagnostic Context (Routing tables, interface status)
        │
        ▼
    [Decide]
Analyze via LLM to generate Root Cause, Confidence, Remediation, and Verification plan
        │
        ▼
     [Act]
Execute Configuration Remediation with backups (auto-rollback on failure)
        │
        ▼
    [Verify]
Run validation checks. Revert immediately via Transaction Manager if verification fails
```

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

#### 4. Launching the Auto-Healing Monitor
```bash
ciscollm monitor --protocol ssh --host 127.0.0.1 --port 2222 -u admin -p admin --min-confidence 0.85 --non-interactive
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

3. **Run Unit & Integration Tests:**
   * Run the main test suite:
     ```bash
     npm run test
     ```
   * Run AIOps auto-healing tests:
     ```bash
     npm run test:healing
     ```
   * Run Plink serial connection utility tests:
     ```bash
     npm run test:plink
     ```
