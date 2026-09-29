---
name: permission-response-processor
description: Ingests unstructured WhatsApp/email replies from employees or consultants and extracts structured status, pending items, authority, completion dates, and escalation flags for the Stallion dashboard.
version: 1.0.0
author: Stallion Executive Intelligence
license: MIT
metadata:
  hermes:
    tags: [response, extraction, parsing, status, escalation, stallion, dashboard]
    category: productivity
---

# Permission Response Processor Skill

Use this skill when an employee, liaison architect, or consultant responds to a permission follow-up message.

## Processing Recipe

1. **Ingest Employee Reply**:
   Execute the response structuring script:
   ```bash
   python3 scripts/permission_followup.py record-reply \
     --permission "<permission_name>" \
     --from "<person_name>" \
     --reply "<raw_reply_text>"
   ```

2. **Extraction Extraction Rules**:
   The processor evaluates the reply and extracts:
   - **Current Status**:
     - `Approved / Issued` (e.g. "cleared", "received", "issued")
     - `Submitted & In Scrutiny` (e.g. "submitted", "inward done", "under review")
     - `Query Raised by Authority` (e.g. "query", "objection", "deficiency")
     - `Under Preparation` (e.g. "compiling", "drafting drawings")
   - **Pending Item**: Identifies the specific roadblock (e.g., *Scrutiny fee challan payment*, *Physical site inspection report*, *Revised architectural drawings*).
   - **Pending Authority / Person**: Maps to the municipal body (e.g., *Chief Fire Officer (CFO)*, *Dy. Ch. Eng. (SWD)*, *Executive Engineer BP*).
   - **Expected Completion Date / Timestamp**: Extracts dates (e.g., *15th October*) or timeframe.
   - **Escalation Required**: Flags `true` if keywords indicating delays, objections, or management intervention needed are detected.

3. **Structured Dashboard Update**:
   ```json
   {
     "permission": "CFO NOC",
     "from_person": "Rajesh Sharma",
     "processed_at": "2026-09-29 12:54 PM",
     "current_status": "In Progress",
     "pending_item": "Scrutiny fee challan payment",
     "pending_authority": "Chief Fire Officer (CFO)",
     "expected_completion_date": "15th October",
     "escalation_required": false
   }
   ```

4. **Update Notification**:
   Summarize the structured update for the project manager and highlight if executive escalation is required.
