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
   Map pending or missing clearances dynamically to their actual construction milestone impact based on the real permissions data and any extracted IOD conditions. Do not force fixed boilerplate phase templates or assume placeholder clearances that are absent from project records.

4. **Dynamic Audit Output**:
   Present findings dynamically based strictly on the fetched tool data:
   - Provide real status breakdowns (Issued/Approved vs. Pending/In-Process).
   - Detail genuine bottlenecks with assigned owners, expiry dates, and real-world impact.
   - Avoid fixed boilerplate templates or placeholder rows. Offer proactive follow-up on actual pending items.
