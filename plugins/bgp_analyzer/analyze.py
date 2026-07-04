import sys
import json
import re

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    args = json.loads(sys.argv[1])
    raw_output = args.get("bgp_output", "")
   
    
    neighbors_down = []
    neighbors_up = []
    
    lines = raw_output.strip().split('\n')
    
    in_neighbor_section = False
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        if "Neighbor" in line and "State/PfxRcd" in line:
            in_neighbor_section = True
            continue
            
        if in_neighbor_section:

            match = re.match(r'^([a-fA-F0-9\.\:]+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+([0-9a-zA-Z\:]+)\s+([0-9a-zA-Z]+)', line)
            
            if not match:
              
                parts = line.split()
                if len(parts) >= 10:
                    neighbor_ip = parts[0]
                    as_num = parts[2]
                    uptime = parts[-2]
                    state_or_pfx = parts[-1]
                else:
                    continue
            else:
                neighbor_ip = match.group(1)
                as_num = match.group(2)
                uptime = match.group(3)
                state_or_pfx = match.group(4)
                
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
