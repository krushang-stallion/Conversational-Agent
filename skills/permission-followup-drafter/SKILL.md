---
name: permission-followup-drafter
description: Human-in-the-loop follow-up engine that inspects pending permissions, target timestamps, and construction blockers to draft WhatsApp reminders. Never sends automatically without user approval.
version: 1.0.0
author: Stallion Executive Intelligence
license: MIT
metadata:
  hermes:
    tags: [followup, whatsapp, reminders, approval, human-in-the-loop, stallion]
    category: productivity
---

# Permission Follow-Up Drafter Skill

Use this skill when drafting and dispatching compliance follow-ups to employees, liaison architects, or consultants.

## Core Rules & Guardrails

> [!CRITICAL]
> **STRICT GUARDRAIL**: NEVER send reminders automatically. Always present the draft to an authorized Stallion user and obtain explicit confirmation before dispatching.

## 10-Step Follow-Up Procedure

1. **Check Assigned Person**: Verify who is responsible for the clearance (`assigned_to`, role, phone).
2. **Check Target Timestamp / Due Date**: Note the target deadline or test timestamp (e.g., `11:45 PM Today` or `15 Oct 2026`).
3. **Check Latest Update**: Review the latest progress note or inward submission date.
4. **Check Blocking Impact**: Determine whether this permission blocks another municipal approval or construction stage.
5. **Draft Reminder**:
   Run the follow-up drafting script:
   ```bash
   python3 scripts/permission_followup.py draft-reminder \
     --permission "<permission_name>" \
     --assigned-to "<person_name>" \
     --role "<role>" \
     --phone "<phone_number>" \
     --due-time "<timestamp_or_date>" \
     --blocks-stage "<stage_blocked>" \
     --latest-update "<notes>"
   ```
6. **Guardrail Enforced**: The script creates the draft with status `AWAITING_HUMAN_APPROVAL` and returns a unique `draft_id`.
7. **Ask Authorized User for Approval**:
   Present the draft clearly:
   > *"Follow-up reminder drafted for Rajesh Sharma regarding CFO NOC (Due: 11:45 PM). Shall I approve and dispatch this reminder now?"*
8. **Dispatch After Approval**:
   Upon user approval ("Yes", "Approved", "Send it"):
   ```bash
   python3 scripts/permission_followup.py approve-and-send <draft_id> "<user_name>"
   ```
9. **Record Interaction**: The dispatch is logged in the interaction history with timestamp and recipient details.
10. **Awaiting Reply**: Transition to tracking employee response.
