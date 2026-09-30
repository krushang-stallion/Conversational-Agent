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
   *Note: Tool results are automatically sanitized and surface pre-signed S3 links in `ai_view_url`.*

2. **Inspect Attached Approval Documents**:
   ```bash
   inspect_document_attachment(ai_view_url="<ai_view_url>")
   ```
   Read and extract municipal conditions, clauses, and stage requirements from primary sanction PDFs (e.g. IOD, Amendment letters, NOCs).

3. **Match Extracted Conditions Against Stallion Checklist**:
   Compare each required condition from the sanction document against the permissions uploaded in Stallion:
   - **Matched & Active**: Document uploaded, approved, and within validity date.
   - **Uploaded but Pending**: Document uploaded under review or awaiting NOC receipt.
   - **Missing / Not Uploaded**: Required by IOD/sanction condition but not present in Stallion database.

4. **Construction Blocker Analysis**:
   Map pending or missing clearances dynamically to their actual construction milestone impact based on the real permissions data and any extracted IOD conditions. Do not force fixed boilerplate phase templates or assume placeholder clearances that are absent from project records.

5. **Dynamic Audit Output**:
   Present findings dynamically based strictly on the fetched tool data:
   - Provide real status breakdowns (Issued/Approved vs. Pending/In-Process).
   - Detail genuine bottlenecks with assigned owners, expiry dates, and real-world impact.
   - Avoid fixed boilerplate templates or placeholder rows. Offer proactive follow-up on actual pending items.
