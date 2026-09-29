---
name: iod-condition-extractor
description: Extracts municipal condition clauses, required clearances, approval authorities, and milestone stages from IOD, CC, and LOI sanction documents.
version: 1.0.0
author: Stallion Executive Intelligence
license: MIT
metadata:
  hermes:
    tags: [iod, permissions, municipal, conditions, extraction, real-estate, compliance]
    category: productivity
---

# IOD Condition Extractor Skill

Use this skill when processing municipal approval documents, Intimation of Disapproval (IOD), Commencement Certificates (CC), or Letters of Intent (LOI).

## Extraction Recipe

1. **Obtain PDF Document Link**:
   - Pre-signed S3 links are retrieved directly from `get_project_permissions(project_id="...")` in the `ai_view_url` field.
2. **Execute Document Attachment Reader**:
   ```bash
   python3 scripts/read_document_attachment.py "<ai_view_url>"
   ```
3. **Parse Extracted Conditions**:
   The tool extracts clauses matching the standard municipal master:
   - CFO NOC / Fire Safety (Chief Fire Officer)
   - Tree Authority NOC (Garden Department)
   - Storm Water Drain (SWD) Remarks (Dy. Ch. Eng. SWD)
   - Sewerage & Drainage (S&D) Remarks (Dy. Ch. Eng. S&D)
   - Environmental Clearance (SEIAA / MoEF)
   - Civil Aviation NOC (AAI)
   - Traffic Police NOC
   - High Rise Committee (HRC) Approval
   - Hydraulic Engineer / Water Remarks
   - SWM (Solid Waste Management) NOC
   - Heritage Conservation Committee NOC
   - Soil Testing & Structural Peer Review

4. **Structured Output Format**:
   For every extracted clause, present:
   ```json
   {
     "extracted_condition": "CFO NOC required",
     "source": "IOD condition 23",
     "stage": "Before further CC",
     "matched_stallion_permission": "CFO NOC",
     "category": "Fire",
     "authority": "Chief Fire Officer (CFO)",
     "suggested_role": "Liaison Architect / Fire Consultant",
     "current_status": "Not uploaded",
     "action": "Permission required"
   }
   ```
