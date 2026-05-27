
New-Item -ItemType Directory -Force -Path "test-runs" | Out-Null


function Clear-MockState {
    if (Test-Path ".mock-state-switch1.json") {
        Remove-Item ".mock-state-switch1.json" -Force
    }
}


Write-Host "Running Scenario 1: OSPF..."
Clear-MockState
npm run start -- run --protocol mock --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --model qwen3.5-4b --non-interactive --goal "Configure OSPF process 10, advertise network 192.168.1.0/24 in area 0 on Switch1. Then show the routing table and ping 192.168.1.254 to verify connectivity." > test-runs/scenario1.log 2>&1

Write-Host "Running Scenario 2: ACL..."
Clear-MockState
npm run start -- run --protocol mock --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --model qwen3.5-4b --non-interactive --goal "Create a named extended ACL BLOCK_HTTP on Switch1. Permit tcp any any eq 80, permit tcp any any eq 443, and apply it inbound on interface GigabitEthernet0/1." > test-runs/scenario2.log 2>&1


Write-Host "Running Scenario 3: DHCP Pool..."
Clear-MockState
npm run start -- run --protocol mock --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --model qwen3.5-4b --non-interactive --goal "Create a DHCP pool OFFICE_NET on Switch1 with network 192.168.10.0/24, default-router 192.168.10.254, dns-server 8.8.8.8, and exclude addresses 192.168.10.1 to 192.168.10.10." > test-runs/scenario3.log 2>&1


Write-Host "Running Scenario 4: Multi-VLAN..."
Clear-MockState
npm run start -- run --protocol mock --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --model qwen3.5-4b --non-interactive --goal "Create VLAN 10, VLAN 20, VLAN 30 on Switch1. Then assign GigabitEthernet0/2 to VLAN 10 and display show vlan brief." > test-runs/scenario4.log 2>&1
Write-Host "Running Scenario 5: Loopback & Static Route..."
Clear-MockState
npm run start -- run --protocol mock --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --model qwen3.5-4b --non-interactive --goal "Create Loopback5 interface on Switch1 with IP 5.5.5.5/32, then configure a static route for 10.100.0.0/16 pointing to Loopback5." > test-runs/scenario5.log 2>&1

Write-Host "All Scenarios Completed!"
