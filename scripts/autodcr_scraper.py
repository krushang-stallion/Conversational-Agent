#!/usr/bin/env python3
"""
MCGM AutoDCR Citizen Search Portal Scraper.
Automates queries against Brihanmumbai Municipal Corporation (MCGM) AutoDCR:
https://autodcr.mcgm.gov.in/CitizenSearch/CitizenSearch.aspx

Supports searching by:
- File Number / Proposal Number (txtFileNo)
- Architect Name (txtArchitect)
- Applicant / Developer Name (txtApplicant)
- Plot / CTS Number (txtPlotNo)
"""

import sys
import os
import json
import re
import urllib.request
import urllib.parse
import http.cookiejar

AUTODCR_URL = "https://autodcr.mcgm.gov.in/CitizenSearch/CitizenSearch.aspx"


def search_autodcr(file_no: str = "", architect: str = "", applicant: str = "", plot_no: str = "") -> dict:
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Origin": "https://autodcr.mcgm.gov.in",
        "Referer": AUTODCR_URL
    }

    try:
        # Step 1: Initial GET request to capture ASP.NET ViewState and Event tokens
        req_get = urllib.request.Request(AUTODCR_URL, headers=headers)
        with opener.open(req_get, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        viewstate = re.search(r'id=["\']__VIEWSTATE["\']\s+value=["\']([^"\']+)["\']', html)
        viewstate_gen = re.search(r'id=["\']__VIEWSTATEGENERATOR["\']\s+value=["\']([^"\']+)["\']', html)
        event_val = re.search(r'id=["\']__EVENTVALIDATION["\']\s+value=["\']([^"\']+)["\']', html)

        if not viewstate:
            return {
                "success": False,
                "error": "Could not extract __VIEWSTATE from MCGM AutoDCR portal."
            }

        # Step 2: Prepare POST parameters
        form_data = {
            "__VIEWSTATE": viewstate.group(1),
            "__VIEWSTATEGENERATOR": viewstate_gen.group(1) if viewstate_gen else "",
            "__EVENTVALIDATION": event_val.group(1) if event_val else "",
            "txtFileNo": file_no.strip(),
            "txtApplicant": applicant.strip(),
            "txtArchitect": architect.strip(),
            "txtPlotNo": plot_no.strip(),
            "Button2": "Search"
        }

        # Include RadScriptManager if present
        rad_script = re.search(r'name=["\']RadScriptManager1_TSM["\']\s+value=["\']([^"\']+)["\']', html)
        if rad_script:
            form_data["RadScriptManager1_TSM"] = rad_script.group(1)

        payload = urllib.parse.urlencode(form_data).encode("utf-8")
        req_post = urllib.request.Request(AUTODCR_URL, data=payload, headers=headers, method="POST")

        with opener.open(req_post, timeout=25) as post_resp:
            result_html = post_resp.read().decode("utf-8", errors="ignore")

        # Step 3: Parse results table
        records = parse_autodcr_table(result_html)

        return {
            "success": True,
            "source": "MCGM AutoDCR Citizen Search",
            "query": {
                "file_no": file_no,
                "architect": architect,
                "applicant": applicant,
                "plot_no": plot_no
            },
            "total_records": len(records),
            "records": records
        }

    except urllib.error.URLError as e:
        return {
            "success": False,
            "error": f"AutoDCR server network error: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"AutoDCR scraping error: {str(e)}"
        }


def parse_autodcr_table(html: str) -> list:
    """Parse HTML table rows from AutoDCR results grid"""
    records = []
    # Match the CitizenSearch results GridView specifically
    table_match = re.search(r'<table[^>]+(?:id|class)=[\'"][^\'"]*(?:gvCitizenSearch|grid)[^\'"]*[\'"][^>]*>(.*?)</table>', html, re.DOTALL | re.IGNORECASE)
    
    if not table_match:
        return records

    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_match.group(1), re.DOTALL | re.IGNORECASE)
    headers = []

    for idx, row in enumerate(rows):
        cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.DOTALL | re.IGNORECASE)
        clean_cells = [re.sub(r'<[^>]+>', '', c).replace('&nbsp;', ' ').strip() for c in cells]

        # Ignore rows that contain JavaScript snippets
        if any("RadAjax" in c or "function" in c for c in clean_cells):
            continue

        if idx == 0 and not headers:
            headers = [h.lower().replace(' ', '_') for h in clean_cells if h]
        else:
            if clean_cells and any(c for c in clean_cells):
                rec = {}
                for h_idx, val in enumerate(clean_cells):
                    h_name = headers[h_idx] if h_idx < len(headers) else f"col_{h_idx}"
                    if h_name:
                        rec[h_name] = val
                if rec and any(v for k, v in rec.items() if not k.startswith("col_") and v):
                    records.append(rec)

    return records


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: python3 autodcr_scraper.py --file-no <str> | --architect <str> | --applicant <str> | --plot-no <str>"
        }))
        sys.exit(1)

    file_no = ""
    architect = ""
    applicant = ""
    plot_no = ""

    args = sys.argv[1:]
    for i in range(len(args)):
        if args[i] == "--file-no" and i + 1 < len(args):
            file_no = args[i + 1]
        elif args[i] == "--architect" and i + 1 < len(args):
            architect = args[i + 1]
        elif args[i] == "--applicant" and i + 1 < len(args):
            applicant = args[i + 1]
        elif args[i] == "--plot-no" and i + 1 < len(args):
            plot_no = args[i + 1]

    result = search_autodcr(file_no=file_no, architect=architect, applicant=applicant, plot_no=plot_no)
    print(json.dumps(result, indent=2))
