import sys
import json
import os
import urllib.request
import urllib.error
import base64
from typing import Dict, Any, Optional

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    try:
        args: Dict[str, Any] = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON argument: {str(e)}"}))
        return

    title: str = args.get("title", "Network Incident")
    description: str = args.get("description", "Created by ciscollm-cli")
    impact: int = args.get("impact", 3)
    
    instance: Optional[str] = os.environ.get("SNOW_INSTANCE")
    user: Optional[str] = os.environ.get("SNOW_USER")
    password: Optional[str] = os.environ.get("SNOW_PASS")
    
    if not instance or not user or not password:
        print(json.dumps({
            "status": "FAILED",
            "error": "Missing ServiceNow credentials. Ensure SNOW_INSTANCE, SNOW_USER, and SNOW_PASS environment variables are set."
        }, indent=2))
        return
        
    url: str = f"https://{instance}.service-now.com/api/now/table/incident"
    
    payload: Dict[str, Any] = {
        "short_description": title,
        "description": description,
        "impact": impact,
        "urgency": impact
    }
    
    data: bytes = json.dumps(payload).encode('utf-8')
    
    auth_str: str = f"{user}:{password}"
    auth_b64: str = base64.b64encode(auth_str.encode('utf-8')).decode('utf-8')
    
    req = urllib.request.Request(url, data=data, headers={
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': f'Basic {auth_b64}'
    })
    
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            res_body = json.loads(response.read().decode('utf-8'))
            ticket = res_body.get('result', {})
            print(json.dumps({
                "status": "CREATED",
                "ticket_id": ticket.get('number'),
                "sys_id": ticket.get('sys_id'),
                "url": f"https://{instance}.service-now.com/nav_to.do?uri=incident.do?sys_id={ticket.get('sys_id')}"
            }, indent=2))
    except urllib.error.URLError as e:
        err_msg = str(e)
        if hasattr(e, 'read'):
            err_msg += f" - {e.read().decode('utf-8', errors='replace')}"
        print(json.dumps({
            "status": "FAILED",
            "error": f"ServiceNow API Error: {err_msg}"
        }, indent=2))
    except Exception as e:
        print(json.dumps({
            "status": "FAILED",
            "error": f"An unexpected error occurred: {str(e)}"
        }, indent=2))

if __name__ == "__main__":
    main()
