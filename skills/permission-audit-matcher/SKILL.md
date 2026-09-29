---
name: permission-audit-matcher
description: Cross-references extracted IOD municipal conditions against Stallion uploaded project permissions, identifies clearance gaps, flags missing documents, and pinpoints construction blockers.
version: 1.0.0
author: Stallion Executive Intelligence
license: MIT
metadata:
  hermes:
    tags: [permissions, audit, matching, compliance, blockers, stallion]
    category: productivity
---

# Permission Audit Matcher Skill

Use this skill to audit project permissions and cross-reference municipal requirements against internal records.

## Audit Workflow

1. **Fetch Project Permissions**:
   ```bash
   get_project_permissions(project_id="...")
   ```
   *Note: Tool results are automatically sanitized to prevent >128k token overload.*

2. **Match Extracted Conditions**:
   Compare each required clearance from the IOD checklist against the permissions uploaded in Stallion:
   - **Matched & Active**: Document uploaded, approved, and within validity date.
   - **Uploaded but Pending**: Document uploaded under review or awaiting NOC receipt.
   - **Missing / Not Uploaded**: Required by IOD condition but not present in Stallion database.

3. **Construction Blocker Analysis**:
   Map each missing clearance to its critical path construction milestone:
   - **Excavation & Shoring**: Requires IOD, Soil Investigation, Borewell NOC.
   - **Plinth CC**: Requires Tree NOC, SWD Remarks, S&D Remarks, CFO Initial NOC.
   - **Further CC (Above Plinth / Superstructure)**: Requires CFO NOC, Environmental Clearance, AAI NOC, HRC approval.
   - **Occupation Certificate (OC)**: Requires CFO Final NOC, Water Connection, SWM NOC, Lift Inspection.

4. **Executive Audit Output**:
   Present an audit table:
   | Permission Name | Category | IOD Source | Stage Required | Stallion Status | Blocking Risk | Suggested Assignee |
   | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
   | CFO NOC | Fire | IOD Cond. 23 | Before further CC | ⚠️ Not Uploaded | Superstructure CC | Liaison Architect |
