import sys
import json
import os
import urllib.request
import urllib.error

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    args = json.loads(sys.argv[1])
    channel = args.get("channel", "#general")
    message = args.get("message", "")
    severity = args.get("severity", "info")
    
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        print(json.dumps({
            "status": "FAILED",
            "error": "Environment variable SLACK_WEBHOOK_URL is not set. Please set it to enable Slack notifications."
        }))
        return
        
    icons = {
        "info": "ℹ️",
        "warning": "⚠️",
        "critical": "🚨"
    }
    
    payload = {
        "channel": channel,
        "text": f"{icons.get(severity, '')} *[ciscollm-cli]* {message}"
    }
    
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode('utf-8')
            print(json.dumps({
                "status": "DELIVERED",
                "slack_response": res_body,
                "message": "Notification successfully sent to Slack."
            }, indent=2))
    except urllib.error.URLError as e:
        print(json.dumps({
            "status": "FAILED",
            "error": str(e)
        }, indent=2))

if __name__ == "__main__":
    main()
