import sys
import json
import datetime
import os
import subprocess

def run_cmd(cmd, cwd):
    try:
        subprocess.run(cmd, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except subprocess.CalledProcessError:
        return False
    except FileNotFoundError:
        return False 

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    args = json.loads(sys.argv[1])
    hostname = args.get("hostname", "unknown_device")
    config = args.get("config_text", "")
    
    backup_dir = os.path.join(os.getcwd(), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    
    filename = f"{hostname}.cfg"
    filepath = os.path.join(backup_dir, filename)
    
    with open(filepath, 'w') as f:
        f.write(config)
        

    git_msg = "Git is not installed or failed to initialize."
    has_git = False
    
    if not os.path.exists(os.path.join(backup_dir, ".git")):
        if run_cmd(["git", "init"], cwd=backup_dir):
            has_git = True
    else:
        has_git = True
        
    if has_git:
        run_cmd(["git", "add", "."], cwd=backup_dir)
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if run_cmd(["git", "commit", "-m", f"Automated backup for {hostname} at {timestamp}"], cwd=backup_dir):
            git_msg = "Configuration successfully committed to local Git repository."
        else:
            git_msg = "No changes detected to commit."
        
    print(json.dumps({
        "status": "SUCCESS",
        "message": f"Configuration saved to {filepath}",
        "version_control": git_msg,
        "bytes_written": len(config)
    }, indent=2))

if __name__ == "__main__":
    main()
