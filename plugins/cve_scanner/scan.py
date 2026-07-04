import sys
import json
import urllib.request
import urllib.error
import urllib.parse

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing arguments"}))
        return
        
    args = json.loads(sys.argv[1])
    version = args.get("ios_version", "unknown")
    
    if version == "unknown":
        print(json.dumps({"error": "Missing ios_version in arguments"}))
        return


    keyword = urllib.parse.quote(f"Cisco IOS {version}")
    url = f"https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch={keyword}"
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'ciscollm-cli/1.0'})
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode('utf-8'))
            
            vulnerabilities = data.get('vulnerabilities', [])
            cves = []
            
            for v in vulnerabilities:
                cve_data = v.get('cve', {})
                cve_id = cve_data.get('id')
                metrics = cve_data.get('metrics', {})
                

                severity = "UNKNOWN"
                if 'cvssMetricV31' in metrics:
                    severity = metrics['cvssMetricV31'][0]['cvssData']['baseSeverity']
                elif 'cvssMetricV30' in metrics:
                    severity = metrics['cvssMetricV30'][0]['cvssData']['baseSeverity']
                elif 'cvssMetricV2' in metrics:
                    severity = metrics['cvssMetricV2'][0]['baseSeverity']
                    
                cves.append({
                    "id": cve_id,
                    "severity": severity,
                    "description": cve_data.get('descriptions', [{}])[0].get('value', '')
                })
                

                if len(cves) >= 5:
                    break
            
            print(json.dumps({
                "status": "VULNERABLE" if cves else "SECURE",
                "cve_count_found": data.get('totalResults', 0),
                "top_cves": cves
            }, indent=2))
            
    except urllib.error.URLError as e:
        print(json.dumps({
            "status": "ERROR",
            "error": f"Failed to reach NVD API: {str(e)}"
        }, indent=2))

if __name__ == "__main__":
    main()
