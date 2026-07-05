import sys
import json
import re
from typing import Dict, List, Any

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    try:
        args: Dict[str, Any] = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON argument: {str(e)}"}))
        return

    raw_output: str = args.get("bgp_output", "")
    
    neighbors_down: List[Dict[str, str]] = []
    neighbors_up: List[Dict[str, Any]] = []
    
    lines: List[str] = raw_output.strip().split('\n')
    in_neighbor_section: bool = False
    
    # Improved Regex for parsing BGP IPv4/IPv6 neighbors
    bgp_regex = re.compile(
        r'^([a-fA-F0-9\.\:]+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+([0-9a-zA-Z\:]+)\s+([0-9a-zA-Z]+)'
    )
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        if "Neighbor" in line and "State/PfxRcd" in line:
            in_neighbor_section = True
            continue
            
        if in_neighbor_section:
            match = bgp_regex.match(line)
            if not match:
                parts = line.split()
                if len(parts) >= 10:
                    neighbor_ip, as_num, uptime, state_or_pfx = parts[0], parts[2], parts[-2], parts[-1]
                else:
                    continue
            else:
                neighbor_ip, as_num, uptime, state_or_pfx = match.groups()
                
            if state_or_pfx.isdigit():
                neighbors_up.append({
                    "ip": neighbor_ip, 
                    "asn": as_num, 
                    "uptime": uptime, 
                    "prefixes_received": int(state_or_pfx)
                })
            else:
                neighbors_down.append({
                    "ip": neighbor_ip, 
                    "asn": as_num, 
                    "uptime": uptime, 
                    "state": state_or_pfx
                })
                    
    print(json.dumps({
        "healthy": len(neighbors_down) == 0,
        "neighbors_up": neighbors_up,
        "neighbors_down": neighbors_down,
        "total_active": len(neighbors_up),
        "total_configured": len(neighbors_up) + len(neighbors_down),
        "action_required": len(neighbors_down) > 0
    }, indent=2))

if __name__ == "__main__":
    main()
