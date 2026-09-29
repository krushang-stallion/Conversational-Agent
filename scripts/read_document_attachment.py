#!/usr/bin/env python3
"""
Stallion Document Attachment Reader.
Safely inspects file attachments from S3 pre-signed URLs or local files.
- For PDFs: downloads and extracts text, clauses, dates, and approval conditions.
- For DWG (CAD): safely flags as binary CAD drawing and returns viewer reference,
  strictly preventing invisible unicode errors and context window flooding.
"""

import sys
import os
import json
import re
import urllib.request
import urllib.parse
import hashlib

workspace_scratch = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scratch")
try:
    os.makedirs(workspace_scratch, exist_ok=True)
    SCRATCH_DIR = workspace_scratch
except Exception:
    SCRATCH_DIR = os.path.expanduser("~/.hermes/scratch")
    os.makedirs(SCRATCH_DIR, exist_ok=True)


def is_dwg_file(url_or_path: str) -> bool:
    parsed = urllib.parse.urlparse(url_or_path)
    clean_path = parsed.path.lower()
    return clean_path.endswith(".dwg") or ".dwg?" in url_or_path.lower()


def is_pdf_file(url_or_path: str) -> bool:
    parsed = urllib.parse.urlparse(url_or_path)
    clean_path = parsed.path.lower()
    return clean_path.endswith(".pdf") or ".pdf?" in url_or_path.lower()


# Municipal Permission Master mapping for Mumbai / Maharashtra Urban Development
IOD_CONDITION_PATTERNS = [
    {
        "keywords": ["cfo", "fire noc", "chief fire officer", "fire safety", "fire fighting"],
        "permission_name": "CFO NOC",
        "category": "Fire",
        "authority": "Chief Fire Officer (CFO)",
        "suggested_role": "Liaison Architect / Fire Consultant",
        "default_stage": "Before further CC / OC"
    },
    {
        "keywords": ["tree authority", "tree cutting", "tree transplantation", "superintendent of gardens"],
        "permission_name": "Tree Authority NOC",
        "category": "Environment",
        "authority": "Tree Authority / Garden Dept",
        "suggested_role": "Environmental / Liaison Consultant",
        "default_stage": "Before CC / Plinth"
    },
    {
        "keywords": ["swd", "storm water", "storm water drain", "dy. ch. eng. (swd)"],
        "permission_name": "SWD NOC / Remarks",
        "category": "Drainage",
        "authority": "Dy. Ch. Eng. (SWD)",
        "suggested_role": "MEP / Liaison Consultant",
        "default_stage": "Before Plinth CC"
    },
    {
        "keywords": ["sewerage", "s&d", "drainage remarks", "ch. eng. (s&d)", "sewage"],
        "permission_name": "Sewerage & Drainage Remarks",
        "category": "Drainage",
        "authority": "Dy. Ch. Eng. (S&D)",
        "suggested_role": "MEP Consultant",
        "default_stage": "Before Plinth CC"
    },
    {
        "keywords": ["environmental clearance", "seiaa", "moef", "environment dept", "state level environment"],
        "permission_name": "Environmental Clearance (EC)",
        "category": "Environment",
        "authority": "SEIAA / MoEF & CC",
        "suggested_role": "Environmental Consultant",
        "default_stage": "Before construction beyond 20,000 sq.m / further CC"
    },
    {
        "keywords": ["civil aviation", "aai noc", "airport authority", "height clearance", "aerodrome"],
        "permission_name": "AAI NOC (Civil Aviation)",
        "category": "Aviation",
        "authority": "Airports Authority of India (AAI)",
        "suggested_role": "Liaison Architect",
        "default_stage": "Before CC above AMSL height limit"
    },
    {
        "keywords": ["traffic", "traffic police", "parking layout", "joint commissioner of police (traffic)"],
        "permission_name": "Traffic Police NOC",
        "category": "Traffic",
        "authority": "Traffic Police Mumbai",
        "suggested_role": "Traffic / Liaison Consultant",
        "default_stage": "Before CC"
    },
    {
        "keywords": ["high rise", "hrc", "technical committee", "high rise committee"],
        "permission_name": "High Rise Committee (HRC) Approval",
        "category": "Structural",
        "authority": "MCGM High Rise Committee",
        "suggested_role": "Structural Engineer / Principal Architect",
        "default_stage": "Before CC beyond 70m / 120m"
    },
    {
        "keywords": ["water supply", "hydraulic engineer", "borewell", "water connection", "he dept"],
        "permission_name": "Hydraulic Engineer / Water Remarks",
        "category": "Water",
        "authority": "Hydraulic Engineer (H.E.)",
        "suggested_role": "MEP Consultant",
        "default_stage": "Before Plinth / OC"
    },
    {
        "keywords": ["solid waste", "swm", "organic waste converter", "garbage disposal"],
        "permission_name": "SWM NOC (Solid Waste Management)",
        "category": "Environment",
        "authority": "Solid Waste Management Dept",
        "suggested_role": "Liaison / Sustainability Consultant",
        "default_stage": "Before CC / OC"
    },
    {
        "keywords": ["heritage", "heritage committee", "mhcc", "listed heritage"],
        "permission_name": "Heritage Conservation Committee NOC",
        "category": "Heritage",
        "authority": "Mumbai Heritage Conservation Committee (MHCC)",
        "suggested_role": "Heritage Conservation Architect",
        "default_stage": "Before IOD / CC"
    },
    {
        "keywords": ["soil testing", "geotechnical", "structural stability", "peer review"],
        "permission_name": "Soil Investigation & Structural Peer Review",
        "category": "Structural",
        "authority": "Registered Structural Engineer",
        "suggested_role": "Structural Consultant",
        "default_stage": "Before CC / Excavation"
    }
]


def parse_iod_conditions(text: str) -> list:
    """
    Extracts conditions and required approvals from IOD/CC documents,
    matching the exact structure required by Stallion Executive Directive:
    - extracted_condition
    - source (e.g. IOD condition 23)
    - stage (e.g. Before further CC)
    - matched_stallion_permission
    - current_status
    - action
    - suggested_role
    """
    extracted_items = []
    lines = text.splitlines()

    # Regex patterns for condition headers
    cond_header_re = re.compile(
        r'(?:condition\s*(?:no\.?|number)?\s*[:\s]*(\d+[\w\.\(\)]*)|(?:clause|sr\.?\s*no\.?)\s*[:\s]*(\d+[\w\.\(\)]*)|^\s*(\d+)[\.\)]\s+)',
        re.IGNORECASE
    )

    # Regex patterns for enforcement stage
    stage_re = re.compile(
        r'(before\s+(?:plinth|further\s+cc|commencement\s+certificate|c\.?c\.?|occupation\s+certificate|o\.?c\.?|work\s+starts|starting\s+work|grant\s+of\s+cc))',
        re.IGNORECASE
    )

    current_cond_num = "General Condition"
    current_buffer = []

    def process_buffer(cond_num: str, buffer_lines: list):
        if not buffer_lines:
            return
        chunk = " ".join(buffer_lines).strip()
        chunk_lower = chunk.lower()

        # Check against permission patterns
        for pat in IOD_CONDITION_PATTERNS:
            if any(k in chunk_lower for k in pat["keywords"]):
                stage_match = stage_re.search(chunk)
                stage = stage_match.group(1).capitalize() if stage_match else pat["default_stage"]

                # Avoid duplicate matches for same permission in same condition
                already_matched = any(
                    item["matched_stallion_permission"] == pat["permission_name"] and item["source"] == f"IOD condition {cond_num}"
                    for item in extracted_items
                )
                if not already_matched:
                    extracted_items.append({
                        "extracted_condition": f"{pat['permission_name']} required",
                        "source": f"IOD condition {cond_num}" if cond_num.isdigit() else cond_num,
                        "stage": stage,
                        "matched_stallion_permission": pat["permission_name"],
                        "category": pat["category"],
                        "authority": pat["authority"],
                        "suggested_role": pat["suggested_role"],
                        "current_status": "Not uploaded",
                        "action": "Permission required",
                        "clause_snippet": chunk[:250] + ("..." if len(chunk) > 250 else "")
                    })

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        match = cond_header_re.search(stripped)
        if match:
            num = match.group(1) or match.group(2) or match.group(3)
            process_buffer(current_cond_num, current_buffer)
            current_cond_num = num
            current_buffer = [stripped]
        else:
            current_buffer.append(stripped)

    # Process remaining buffer
    process_buffer(current_cond_num, current_buffer)

    return extracted_items


def extract_pdf_content(file_path: str, max_pages: int = 15, max_chars: int = 8000) -> dict:
    try:
        import pypdf
        reader = pypdf.PdfReader(file_path)
        total_pages = len(reader.pages)
        pages_to_read = min(total_pages, max_pages)

        extracted_text = []
        for i in range(pages_to_read):
            page_text = reader.pages[i].extract_text() or ""
            if page_text.strip():
                extracted_text.append(f"--- [Page {i + 1} of {total_pages}] ---\n" + page_text.strip())

        full_text = "\n\n".join(extracted_text)

        # Extract structured IOD conditions
        iod_conditions = parse_iod_conditions(full_text)

        # Truncate if exceedingly long to protect LLM context
        truncated = False
        if len(full_text) > max_chars:
            full_text = full_text[:max_chars] + "\n... [TRUNCATED FOR CONTEXT WINDOW SAFETY]"
            truncated = True

        return {
            "status": "success",
            "file_type": "pdf",
            "total_pages": total_pages,
            "pages_read": pages_to_read,
            "truncated": truncated,
            "total_iod_conditions_extracted": len(iod_conditions),
            "extracted_iod_conditions": iod_conditions,
            "content": full_text
        }
    except Exception as e:
        return {
            "status": "error",
            "file_type": "pdf",
            "error": f"Failed to extract PDF text: {str(e)}"
        }


def read_attachment(url_or_path: str, max_pages: int = 10) -> dict:
    url_or_path = url_or_path.strip()

    # 1. Handle DWG files safely
    if is_dwg_file(url_or_path):
        parsed = urllib.parse.urlparse(url_or_path)
        file_name = os.path.basename(parsed.path) or "architectural_drawing.dwg"
        return {
            "status": "cad_binary",
            "file_type": "dwg",
            "file_name": file_name,
            "message": "AutoCAD Drawing (binary). This file contains CAD vectors and cannot be ingested as plain text. Please use the direct URL to inspect in AutoCAD or the Stallion Blueprint Viewer.",
            "direct_url": url_or_path
        }

    # 2. Handle PDF files
    local_path = url_or_path
    temp_downloaded = False

    if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
        url_hash = hashlib.md5(url_or_path.encode("utf-8")).hexdigest()[:12]
        local_path = os.path.join(SCRATCH_DIR, f"doc_{url_hash}.pdf")

        if not os.path.exists(local_path) or os.path.getsize(local_path) == 0:
            try:
                req = urllib.request.Request(
                    url_or_path,
                    headers={"User-Agent": "Stallion-Agent/1.0"}
                )
                with urllib.request.urlopen(req, timeout=20) as resp, open(local_path, "wb") as f:
                    f.write(resp.read())
                temp_downloaded = True
            except Exception as e:
                return {
                    "status": "download_failed",
                    "url": url_or_path,
                    "error": f"Unable to fetch S3 attachment: {str(e)}"
                }

    if os.path.exists(local_path):
        result = extract_pdf_content(local_path, max_pages=max_pages)
        parsed = urllib.parse.urlparse(url_or_path)
        result["file_name"] = os.path.basename(parsed.path) or "document.pdf"
        result["source_url"] = url_or_path
        return result

    return {
        "status": "unsupported_format",
        "url": url_or_path,
        "message": "File format not supported for inline text extraction. Please open via direct URL."
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: python3 read_document_attachment.py <url_or_file_path> [--max-pages N]"
        }))
        sys.exit(1)

    target_url = sys.argv[1]
    pages = 10
    if "--max-pages" in sys.argv:
        try:
            idx = sys.argv.index("--max-pages")
            pages = int(sys.argv[idx + 1])
        except Exception:
            pages = 10

    res = read_attachment(target_url, max_pages=pages)
    print(json.dumps(res, indent=2))
