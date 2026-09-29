#!/usr/bin/env python3
"""
Stallion Permission Follow-up & Response Processing Engine.
Implements the 10-step Human-in-the-Loop Follow-up Workflow:
1. Check assigned person
2. Check target timestamp / due date
3. Check latest update
4. Check whether permission blocks another approval or construction stage
5. Draft reminder
6. STRICT GUARDRAIL: Do not send automatically
7. Await authorized Stallion user approval
8. After approval, dispatch reminder
9. Record interaction history
10. Process employee reply into structured JSON:
    - current status
    - pending item
    - pending authority/person
    - expected completion date
    - escalation required
"""

import sys
import os
import json
import uuid
import re
from datetime import datetime

workspace_scratch = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scratch")
try:
    os.makedirs(workspace_scratch, exist_ok=True)
    STORAGE_DIR = workspace_scratch
except Exception:
    STORAGE_DIR = os.path.expanduser("~/.hermes/scratch")
    os.makedirs(STORAGE_DIR, exist_ok=True)

PENDING_DRAFTS_FILE = os.path.join(STORAGE_DIR, "pending_followups.json")
HISTORY_FILE = os.path.join(STORAGE_DIR, "followup_history.json")
UPDATES_FILE = os.path.join(STORAGE_DIR, "permission_dashboard_updates.json")


def load_json(filepath: str) -> dict:
    if os.path.exists(filepath):
        try:
            with open(filepath, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_json(filepath: str, data: dict):
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)


def draft_reminder(
    permission: str,
    assigned_to: str,
    role: str = "Liaison / Consultant",
    phone: str = "",
    due_time: str = "",
    blocks_stage: str = "Next Construction Phase",
    latest_update: str = "Pending submission"
) -> dict:
    draft_id = str(uuid.uuid4())[:8]
    now_str = datetime.now().strftime("%Y-%m-%d %I:%M %p")

    # If due_time is empty, default to sample timestamp
    effective_due = due_time if due_time else "11:45 PM Today"

    # Executive WhatsApp reminder draft format
    reminder_text = (
        f"🚨 *STALLION COMPLIANCE REMINDER* | Project Operations\n"
        f"────────────────────────\n"
        f"👤 *To*: {assigned_to} ({role})\n"
        f"📋 *Item*: {permission}\n"
        f"⏰ *Target Due*: {effective_due}\n"
        f"🚧 *Critical Block*: {blocks_stage}\n"
        f"📝 *Last Update*: {latest_update}\n\n"
        f"Please provide immediate status: is this currently with the authority, or is additional documentation required?\n"
        f"Reply directly to update the Stallion project dashboard."
    )

    draft_record = {
        "draft_id": draft_id,
        "created_at": now_str,
        "permission": permission,
        "assigned_to": assigned_to,
        "role": role,
        "phone": phone,
        "due_time": effective_due,
        "blocks_stage": blocks_stage,
        "latest_update": latest_update,
        "status": "AWAITING_HUMAN_APPROVAL",
        "human_approval_required": True,
        "reminder_draft": reminder_text,
        "instruction": "Do not send automatically. Must be approved by authorized Stallion user."
    }

    drafts = load_json(PENDING_DRAFTS_FILE)
    drafts[draft_id] = draft_record
    save_json(PENDING_DRAFTS_FILE, drafts)

    return {
        "success": True,
        "message": "Follow-up reminder drafted. Awaiting authorized user approval before dispatch.",
        "draft": draft_record
    }


def approve_and_send(draft_id: str, approved_by: str = "Project Director") -> dict:
    drafts = load_json(PENDING_DRAFTS_FILE)
    if draft_id not in drafts:
        return {
            "success": False,
            "error": f"Draft ID '{draft_id}' not found in pending drafts."
        }

    draft = drafts.pop(draft_id)
    now_str = datetime.now().strftime("%Y-%m-%d %I:%M %p")

    dispatch_record = {
        "dispatch_id": draft_id,
        "permission": draft["permission"],
        "assigned_to": draft["assigned_to"],
        "phone": draft["phone"],
        "approved_by": approved_by,
        "approved_at": now_str,
        "message_sent": draft["reminder_draft"],
        "delivery_channel": "WhatsApp Simulation / Console",
        "delivery_status": "DELIVERED"
    }

    history = load_json(HISTORY_FILE)
    if "dispatches" not in history:
        history["dispatches"] = []
    history["dispatches"].append(dispatch_record)

    save_json(PENDING_DRAFTS_FILE, drafts)
    save_json(HISTORY_FILE, history)

    return {
        "success": True,
        "status": "SENT",
        "message": f"Reminder approved by {approved_by} and dispatched successfully.",
        "dispatch_details": dispatch_record
    }


def process_employee_reply(reply_text: str, permission: str = "Permission", from_person: str = "Employee") -> dict:
    """
    Parses employee WhatsApp reply into structured JSON:
    - current status
    - pending item
    - pending authority/person
    - expected completion date / timestamp
    - escalation required
    """
    text_lower = reply_text.lower()
    now_str = datetime.now().strftime("%Y-%m-%d %I:%M %p")

    # 1. Determine Current Status
    if any(k in text_lower for k in ["approved", "cleared", "received", "issued", "collected", "ready"]):
        status = "Approved / Issued"
    elif any(k in text_lower for k in ["submitted", "applied", "inward done", "scrutiny in progress"]):
        status = "Submitted & In Scrutiny"
    elif any(k in text_lower for k in ["query", "objection", "deficiency", "rejected"]):
        status = "Query Raised by Authority"
    elif any(k in text_lower for k in ["working on", "drafting", "preparing", "in process", "compiling"]):
        status = "Under Preparation"
    else:
        status = "In Progress"

    # 2. Extract Authority
    authority = "Competent Municipal Authority"
    authority_keywords = {
        "cfo": "Chief Fire Officer (CFO)",
        "fire": "CFO Fire Department",
        "swd": "Dy. Ch. Eng. (SWD)",
        "drainage": "Dy. Ch. Eng. (S&D)",
        "seiaa": "State Environment Impact Assessment Authority (SEIAA)",
        "moef": "Ministry of Environment & Forests (MoEF)",
        "tree": "Tree Authority / Garden Dept",
        "ward": "Local Ward Executive Engineer (BP)",
        "eebp": "Executive Engineer Building Proposal (EEBP)",
        "aai": "Airports Authority of India (AAI)",
        "traffic": "Joint Commissioner of Police (Traffic)"
    }
    for kw, auth_name in authority_keywords.items():
        if kw in text_lower:
            authority = auth_name
            break

    # 3. Extract Pending Item
    pending_item = "Final NOC / Sanction order"
    if any(k in text_lower for k in ["scrutiny fee", "challan", "fee receipt"]):
        pending_item = "Scrutiny fee challan payment"
    elif any(k in text_lower for k in ["site inspection", "visit", "inspection"]):
        pending_item = "Physical site inspection report"
    elif any(k in text_lower for k in ["revised drawing", "revision", "architect plan"]):
        pending_item = "Revised architectural drawings submission"
    elif any(k in text_lower for k in ["signature", "sign", "affidavit", "indemnity"]):
        pending_item = "Developer signature / Indemnity bond"
    elif any(k in text_lower for k in ["compliance letter", "clarification"]):
        pending_item = "Compliance letter against scrutiny query"

    # 4. Extract Expected Completion Date / Timestamp
    date_match = re.search(r'\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(?:\d{2,4})?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}:\d{2}\s*(?:am|pm)?)\b', reply_text, re.IGNORECASE)
    expected_date = date_match.group(1) if date_match else "Within 3-5 business days"

    # 5. Check Escalation Need
    escalation_needed = any(k in text_lower for k in [
        "stuck", "delay", "bribe", "issue", "problem", "rejected", "refused",
        "escalat", "help required", "intervention", "held up", "blocking"
    ])

    structured_update = {
        "permission": permission,
        "from_person": from_person,
        "processed_at": now_str,
        "current_status": status,
        "pending_item": pending_item,
        "pending_authority": authority,
        "expected_completion_date": expected_date,
        "escalation_required": escalation_needed,
        "original_reply": reply_text
    }

    # Save to dashboard updates
    dashboard = load_json(UPDATES_FILE)
    if "updates" not in dashboard:
        dashboard["updates"] = []
    dashboard["updates"].append(structured_update)
    save_json(UPDATES_FILE, dashboard)

    return {
        "success": True,
        "message": "Employee reply processed and structured for Stallion dashboard.",
        "dashboard_update": structured_update
    }


def list_all() -> dict:
    drafts = load_json(PENDING_DRAFTS_FILE)
    history = load_json(HISTORY_FILE)
    dashboard = load_json(UPDATES_FILE)

    return {
        "pending_drafts_count": len(drafts),
        "pending_drafts": list(drafts.values()),
        "total_dispatches": len(history.get("dispatches", [])),
        "dispatches": history.get("dispatches", [])[-5:],
        "recent_dashboard_updates": dashboard.get("updates", [])[-5:]
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: permission_followup.py <draft-reminder | approve-and-send | record-reply | list-all> [args]"
        }))
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "draft-reminder":
        args = sys.argv[2:]
        kwargs = {}
        for i in range(len(args)):
            if args[i] == "--permission" and i + 1 < len(args): kwargs["permission"] = args[i + 1]
            elif args[i] == "--assigned-to" and i + 1 < len(args): kwargs["assigned_to"] = args[i + 1]
            elif args[i] == "--role" and i + 1 < len(args): kwargs["role"] = args[i + 1]
            elif args[i] == "--phone" and i + 1 < len(args): kwargs["phone"] = args[i + 1]
            elif args[i] == "--due-time" and i + 1 < len(args): kwargs["due_time"] = args[i + 1]
            elif args[i] == "--blocks-stage" and i + 1 < len(args): kwargs["blocks_stage"] = args[i + 1]
            elif args[i] == "--latest-update" and i + 1 < len(args): kwargs["latest_update"] = args[i + 1]

        res = draft_reminder(
            permission=kwargs.get("permission", "CFO NOC"),
            assigned_to=kwargs.get("assigned_to", "Liaison Architect"),
            role=kwargs.get("role", "Architect / Liaison"),
            phone=kwargs.get("phone", "+91 98200 00000"),
            due_time=kwargs.get("due_time", "11:45 PM"),
            blocks_stage=kwargs.get("blocks_stage", "Before further CC"),
            latest_update=kwargs.get("latest_update", "Under scrutiny")
        )
        print(json.dumps(res, indent=2))

    elif cmd == "approve-and-send":
        draft_id = sys.argv[2] if len(sys.argv) > 2 else ""
        approved_by = sys.argv[3] if len(sys.argv) > 3 else "Authorized Stallion User"
        res = approve_and_send(draft_id, approved_by=approved_by)
        print(json.dumps(res, indent=2))

    elif cmd == "record-reply":
        args = sys.argv[2:]
        reply = ""
        perm = "CFO NOC"
        from_p = "Assigned Employee"
        for i in range(len(args)):
            if args[i] == "--reply" and i + 1 < len(args): reply = args[i + 1]
            elif args[i] == "--permission" and i + 1 < len(args): perm = args[i + 1]
            elif args[i] == "--from" and i + 1 < len(args): from_p = args[i + 1]

        if not reply and len(args) > 0 and not args[0].startswith("--"):
            reply = args[0]

        res = process_employee_reply(reply, permission=perm, from_person=from_p)
        print(json.dumps(res, indent=2))

    elif cmd == "list-all":
        print(json.dumps(list_all(), indent=2))

    else:
        print(json.dumps({"error": f"Unknown command '{cmd}'"}))
        sys.exit(1)
