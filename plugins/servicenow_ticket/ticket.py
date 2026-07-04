import sys
import json
import os
import urllib.request
import urllib.error
import base64

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    args = json.loads(sys.argv[1])
    title = args.get("title", "Network Incident")
    description = args.get("description", "Created by ciscollm-cli")
    impact = args.get("impact", 3)
    
    instance = os.environ.get("SNOW_INSTANCE")
    user = os.environ.get("SNOW_USER")
    password = os.environ.get("SNOW_PASS")
    
    if not all([instance, user, password]):
        print(json.dumps({
            "status": "FAILED",
            "error": "Missing ServiceNow credentials. Ensure SNOW_INSTANCE, SNOW_USER, and SNOW_PASS environment variables are set."
        }))
        return
        
    url = f"https://{instance}.service-now.com/api/now/table/incident"
    
    payload = {
        "short_description": title,
        "description": description,
        "impact": impact,
        "urgency": impact
    }
    
    data = json.dumps(payload).encode('utf-8')
    
    auth_str = f"{user}:{password}"
    auth_b64 = base64.b64encode(auth_str.encode('utf-8')).decode('utf-8')
    
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
            err_msg += f" - {e.read().decode('utf-8')}"
        print(json.dumps({
            "status": "FAILED",
            "error": err_msg
        }, indent=2))

if __name__ == "__main__":
    main()
