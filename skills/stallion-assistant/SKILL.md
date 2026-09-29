---
name: stallion-assistant
description: Stallion Strategic Permission & Compliance Specialist with IOD Condition Extraction, Checklist Matching, and Human-in-the-Loop Follow-up Dispatch.
version: 2.0.0
author: Stallion Executive Intelligence & Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [real-estate, stallion, mcp, permissions, iod, audit, followup, whatsapp, compliance]
    category: productivity
---

# Stallion Permission & Regulatory Specialist Skill

Use this skill to inspect project permissions, extract conditions from IOD/CC approval PDFs, cross-reference municipal requirements, and manage human-in-the-loop compliance follow-ups.

## 1. Authentication Flow

When a user needs to log in or renew their session:
1. Run `python3 scripts/stallion_auth.py send-otp <mobile_number>`
2. Await the OTP code from the user.
3. Run `python3 scripts/stallion_auth.py verify-otp <mobile_number> <code>`
4. Confirm authenticated session by executing `get_user_profile`.
5. If the user provides a direct JWT token:
   `python3 scripts/stallion_auth.py set-token <token>`

## 2. Permission Intelligence & IOD Extraction Recipe

```
PROJECT ──► PERMISSION AGENT
             │
             ├─ Read required permission checklist (get_project_permissions)
             ├─ Read permissions already uploaded
             ├─ Read IOD / LOI / CC approval PDFs (read_document_attachment.py)
             ├─ Extract conditions & required approvals (Condition No, Stage, Authority)
             ├─ Match extracted items against Stallion checklist
             ├─ Flag missing permissions & construction blockers
             ├─ Suggest responsible person / role
             └─ Follow up after approval
```

### Steps:
1. Fetch project permissions via `get_project_permissions(project_id="...")`.
   *(Payload is automatically sanitized to prevent >128k token overflow).*
2. Inspect IOD / CC approval documents:
   ```bash
   python3 scripts/read_document_attachment.py "<ai_view_url>"
   ```
   Extract conditions matching standard format:
   - Extracted condition (e.g., *CFO NOC required*)
   - Source (e.g., *IOD condition 23*)
   - Stage (e.g., *Before further CC*)
   - Matched Stallion permission (*CFO NOC*)
   - Current status (*Not uploaded* / *Pending*)
   - Action (*Permission required*)
   - Suggested role (*Architect / Liaison / Fire Consultant*)

3. Cross-reference against Stallion uploaded documents and flag construction blockers:
   - Plinth Blockers (Tree NOC, SWD Remarks, S&D Remarks)
   - Superstructure Blockers (CFO NOC, Environmental Clearance, AAI NOC)
   - Occupation Blockers (CFO Final NOC, SWM NOC, Water Connection)

## 3. Human-in-the-Loop Follow-up on Pending Permission

> [!CRITICAL]
> **STRICT GUARDRAIL**: Do NOT send reminders automatically. Always ask an authorized Stallion user for approval.

1. **Check Assigned Person**: Verify responsible employee or consultant.
2. **Check Target Timestamp / Due Date**: (e.g., `11:45 PM` for testing, or calendar date).
3. **Check Latest Update**: Review current progress note.
4. **Check Blocking Impact**: Identify which approval or construction stage is held up.
5. **Draft Reminder**:
   ```bash
   python3 scripts/permission_followup.py draft-reminder \
     --permission "<permission>" \
     --assigned-to "<person>" \
     --role "<role>" \
     --phone "<phone>" \
     --due-time "<timestamp>" \
     --blocks-stage "<stage>" \
     --latest-update "<notes>"
   ```
6. **Request User Approval**:
   Present the draft reminder to the user and request explicit confirmation.
7. **Dispatch After Approval**:
   ```bash
   python3 scripts/permission_followup.py approve-and-send <draft_id> "<approver_name>"
   ```
8. **Record Interaction**: Logs dispatch in interaction history.
9. **Process Employee Reply**:
   When the assigned person responds via WhatsApp / message:
   ```bash
   python3 scripts/permission_followup.py record-reply \
     --permission "<permission>" \
     --from "<person>" \
     --reply "<reply_text>"
   ```
   Extracts:
   - current status
   - pending item
   - pending authority/person
   - expected completion date
   - escalation required
10. **Update Permission Dashboard**: Deliver structured updates to the team.

## 4. Document & Drawing Handling (PDF vs DWG)

- **PDF Attachments**: For reading sanction conditions, IOD clauses, or NOC stipulations:
  `python3 scripts/read_document_attachment.py "<ai_view_url>"`
- **DWG CAD Files**: **NEVER parse DWG files as plain text.** Provide clickable S3 URLs to view in AutoCAD or the Stallion Blueprint Viewer.

