# ciscollm-cli

`ciscollm-cli` is a premium, autonomous Cisco IOS automation agent CLI designed for network configuration, troubleshooting, and simulation. By leveraging LLM tool-calling capabilities, it allows engineers to manage local, remote, or simulated Cisco hardware safely and efficiently.

The CLI features an **Interactive Setup Wizard**, **Multi-Device Coordination**, **Safety Guardrails (Command Firewall)**, **Automatic Configuration Rollbacks**, **Mock Device Simulation**, and **Strict Command Reference Validation**.

---

## 🚀 Key Features

### 1. ⚙️ Interactive Setup Wizard
If `ciscollm run` is executed without a `--goal` parameter, the CLI automatically launches a step-by-step interactive setup wizard (using `inquirer`). The wizard guides the user through:
* **LLM Provider Selection:** Local (Ollama / LM Studio) or Cloud (OpenRouter).
* **Local LLM Settings:** Service type (Ollama/LM Studio), API endpoint URL, and model name.
* **Cloud LLM Settings:** OpenRouter API Key, model name, and endpoint.
* **Connection Protocol:** Serial (with automated COM port scanning), SSH, Telnet, or Mock simulation.
* **Connection Details:** COM port and Baud rate (for serial), or Host target, Port, Username, and Password (for SSH/Telnet).
* **Configuration Goal:** Prompting for the network task the agent needs to achieve.
* **Configuration Summary:** Displays a summary of the setup and prompts for final confirmation before starting execution.

### 2. 🔀 Multi-Device & Multi-Agent Coordination
Manage configurations across multiple Cisco hardware devices simultaneously. The `--com` (for serial) and `--host` (for SSH/Telnet) flags accept comma-separated inputs (e.g. `--com COM3,COM4` or `--host 10.0.0.1,10.0.0.2`). The internal `MultiAgentCoordinator` manages all connections in parallel, tracks status, and handles clean disconnections upon exit.

### 3. 🛡️ Command Firewall & Safety Guardrails
To prevent accidental lockouts, service disruptions, or losing device access, the built-in `CommandFirewall` monitors all LLM-generated commands. 
* **Blocked Operations:**
  * Removing default static routes (`no ip route 0.0.0.0...`) which can break management access.
  * Disabling AAA authentication (`no aaa new-model`) or zeroizing crypto keys (`crypto key zeroize`).
  * Deleting access lists or access groups (`no access-list`, `no ip access-group`).
  * Shutting down active protected interfaces (e.g. `GigabitEthernet0/0`, `GigabitEthernet0/1`, `GigabitEthernet1/0`, `Vlan1`).
  * Removing configured IP addresses on protected interfaces (`no ip address`).
* **Human-in-the-Loop Validation:** High-risk commands trigger a warning prompt, requiring the operator to manually authorize the execution.
* **Non-Interactive Mode:** Running with `--non-interactive` (or setting environment variable `CISCOLLM_NON_INTERACTIVE=true`) automatically rejects all blocked/high-risk commands.

### 4. 🔄 Transaction Rollback & Inversion Manager
If a configuration step fails or the agent encounters command errors, the `TransactionManager` restores the device state:
* **Atomic Backup:** Before modifying config, the agent attempts to back up the current running-config to `flash:backup-agent.cfg`.
* **Atomic Configuration Replace:** Rollbacks prioritize replacing the configuration atomically using `configure replace flash:backup-agent.cfg force`.
* **Command Inversion Fallback:** If flash storage is unreachable, it builds an inverse command sequence in reverse order (e.g. `ip address ...` -> `no ip address`, `shutdown` -> `no shutdown`, `no shutdown` -> `shutdown`, `description ...` -> `no description`) and executes them sequentially in their respective submodes.

### 5. 📚 Strict Command Reference Validation
Enforces compliance against an official Cisco IOS Command Reference index:
* **Strict Validation Mode:** Enabled via `--strict-command-ref` (or setting `CISCOLLM_STRICT_COMMAND_REF=true`). The agent will block any command not listed in the command-reference index.
* **PDF Command Indexer:** The engine reads `cf_command_ref.pdf`, extracts structural commands, and caches them in `.cache/cf_command_ref.index.json` to speed up startup times.
* **Fuzzy Command Family Expansion:** Automatically expands shortened commands (e.g. `sh` -> `show`, `conf t` -> `configure terminal`, `int gig0/1` -> `interface GigabitEthernet0/1`) to check they match valid command families in the index.
* **Reference Telemetry:** Telemetry logs detail the warmup time, source (PDF, cache, or memory), and matched command count. Can be disabled with `--no-ref-telemetry`.

### 6. 🧪 Mock Device Simulation
Mock mode (`--protocol mock`) provides a stateful simulation of a Cisco IOS device, allowing offline development and testing. It features:
* **Stateful Database:** Maintains interfaces, VLANs, shell variables, shell functions, and static routing tables, saved locally under `.mock-state-<device>.json`.
* **Interactive CLI Simulator:** Simulates user and privileged EXEC modes, configuration modes, VLAN databases, DHCP pools, OSPF routers, and IP routing tables.
* **Output Filtering (Pipes):** Supports standard IOS output piping such as `| include`, `| grep`, `| exclude`, and `| begin`.
* **Network Testing:** Simulates latency and ICMP ping responses.

### 7. 🛡️ Pre-Execution Safety Validation (Dry-Run Check)
Before executing any state-mutating command, the agent runs a dry-run check against the known network topology:
* **Topology Awareness:** Analyzes active physical/logical links between core, distribution, and access segments.
* **Accidental Disruption Prevention:** Detects and intercepts commands that could accidentally shut down critical uplink ports or neighbor nodes, ensuring continuous uptime.
* **Inspection Throttling:** Repeated inspection commands such as `show ip interface brief` are not treated as a harmful loop, but repeated configuration retries still are.

### 8. 🧠 Prompt Discipline for Safe Change Windows
The agent prompt now follows a tighter inspection/configuration/verification flow:
* **Single Pre-Check:** Perform one inspection pass before a configuration block instead of repeatedly polling the same status command.
* **Configuration Block:** Apply the requested changes as a focused sequence of commands.
* **Single Verification Pass:** Verify the applied change once with `show` or `ping_test`, then stop if the result is clean.

### 9. 📊 Live Configuration State Diff Engine
Maintains deep visibility of system modifications:
* **Before/After Snapshots:** Takes memory-efficient snapshots of device interfaces, IP addresses, subnets, routing tables, and active VLAN databases before and after executing any command.
* **Visual Colorized Diffs:** Automatically outputs a structured difference report highlighting additions in green, removals in red, and updates/modifications in yellow.

### 10. 🪵 Continuous Enterprise Audit Trails
Ensures accountability for automated activities:
* **Detailed Logs:** Generates structured records containing the timestamp, target device, active agent role, LLM reasoning thoughts, executed commands, and final output status.
* **Local Audit Store:** Persists all interactions locally to `audit.log` for easy integration with standard security information and event management (SIEM) systems.

### 11. 🔀 Hierarchical Network Swarms
Supports role-specific command delegation and intelligence:
* **Role Routing:** Multi-agent coordinator routes tasks to specialized personalities—**Core Agent**, **Distribution Agent**, and **Access Agent**—matching the logical tier of the configuration task.
* **RBAC Constraints:** Restricts operations according to the `--rbac-role` parameter. The `read_only` role safely blocks any modifying actions and logs violations to the audit log.

### 12. 🔌 NETCONF & CML Simulation Adapters
Extends sandbox capabilities beyond local mock devices:
* **Cisco Modeling Labs (CML):** Provides sessions to interact directly with digital twin network simulations.
* **NETCONF XML Sessions:** Supports programmatic configuration using structured XML RPC calls and YANG schemas.
* **NETCONF SSH Auth:** Supports username/password, SSH private key, passphrase, and NETCONF timeout tuning for real devices.

---

## 📦 Installation

To install `ciscollm-cli` globally from npm:

```bash
npm install -g ciscollm-cli
```

Once installed, the global executable `ciscollm` becomes available.

---

## 🛠️ CLI Usage & Options

```bash
ciscollm run [options]
```

### Options Table

| Option / Flag | Alias | Description | Default Value |
|---|---|---|---|
| `-g, --goal <intent>` | - | The goal of the configuration/troubleshooting task. If not specified, launches the Interactive Setup Wizard. | - |
| `--protocol <type>` | - | Connection protocol (`serial`, `ssh`, `telnet`, `mock`, `netconf`, `cml`). | `serial` |
| `--provider <type>` | - | LLM provider mode (`local`, `cloud`). | `local` |
| `--local-type <type>` | - | Local LLM server flavor (`ollama`, `lmstudio`). | `ollama` |
| `--model <name>` | - | Name of the LLM model to compile. | - |
| `--endpoint <url>` | - | The LLM API endpoint URL. | - |
| `--api-key <key>` | - | API key for the cloud provider (OpenRouter). | - |
| `-c, --com <ports>` | - | COM Port(s), comma-separated (e.g., `COM3` or `COM3,COM4`). | - |
| `-b, --baud <rate>` | - | Serial transmission baud rate. | `9600` |
| `--host <address>` | - | Target IP address or hostname (comma-separated for multi-device). | - |
| `--port <port>` | - | Target connection port. | - |
| `-u, --username <name>` | - | Device login username. | - |
| `-p, --password <pass>` | - | Device login password. | - |
| `--env-password` | - | Read the device password from the `CISCOLLM_PASS` environment variable. | `false` |
| `--private-key <path>` | - | SSH private key file path for SSH and NETCONF sessions. | - |
| `--passphrase <passphrase>` | - | Passphrase for the SSH private key file. | - |
| `--netconf-ready-timeout <ms>` | - | NETCONF SSH ready timeout in milliseconds. | `20000` |
| `--netconf-hello-timeout <ms>` | - | NETCONF hello exchange timeout in milliseconds. | `15000` |
| `--netconf-rpc-timeout <ms>` | - | NETCONF RPC response timeout in milliseconds. | `15000` |
| `--netconf-keepalive-interval <ms>` | - | NETCONF SSH keepalive interval in milliseconds. | `10000` |
| `--strict-command-ref` | - | Block commands not found in the `cf_command_ref.pdf` index. | `false` |
| `--no-ref-telemetry` | - | Disable command-reference warmup telemetry logs. | `false` |
| `--non-interactive` | - | Run without interactive prompts (auto-rejects dangerous commands). | `false` |
| `--rbac-role <role>` | - | Specify the Active Agent RBAC authorization role (`admin`, `read_only`). | `admin` |

---

## 💡 Usage Examples

### 1. Launching the Interactive Setup Wizard
Start the interactive CLI configuration process:
```bash
ciscollm run
```

### 2. Running a Quick Mock Simulation
```bash
ciscollm run --protocol mock --goal "Configure GigabitEthernet0/1 with IP 192.168.2.1/24 and interface description 'LAN B'"
```

### 3. Local Model (Ollama)
```bash
ciscollm run --provider local --local-type ollama --endpoint http://127.0.0.1:11434/v1 --model qwen3.5-4b --protocol mock --goal "Show IP routing table"
```

### 4. Cloud Inference via OpenRouter
```bash
ciscollm run --provider cloud --api-key YOUR_OPENROUTER_API_KEY --protocol mock --goal "Verify interface states"
```

### 5. Enforcing Strict Validation Mode
```bash
ciscollm run --strict-command-ref --protocol mock --goal "Configure router ospf 1 and advertise network 192.168.1.0/24"
```

### 6. NETCONF Session with SSH Key Auth
```bash
ciscollm run --protocol netconf --host 192.168.1.188 --port 830 --username admin --private-key C:\\Users\\me\\.ssh\\id_rsa --passphrase YOUR_PASSPHRASE --netconf-rpc-timeout 20000 --goal "Show running configuration"
```

### 7. NETCONF Session with Password from Environment
```bash
$env:CISCOLLM_PASS = '!@admin1234'
ciscollm run --protocol netconf --host 192.168.1.188 --username admin --env-password --goal "Show interface brief"
```

---

## 💻 Development & Contribution

Follow these steps to set up the project locally for development:

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/ThemeHackers/ciscollm-cli.git
cd ciscollm-cli
npm install
```

### 2. Build the Project
Compile the TypeScript code to target JavaScript inside `dist/`:
```bash
npm run build
```

### 3. Run Development Build
Run the CLI locally from source code:
```bash
npm start -- run --protocol mock --goal "Show running config"
```

### 4. Run Unit Tests
Validate features including the Command Firewall, Transaction Manager, and Error Analyzer:
```bash
npm run test
```
