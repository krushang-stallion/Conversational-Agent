#!/usr/bin/env python3
"""
Stallion Authentication Helper for Hermes Agent.
Handles OTP-based login (send-otp, verify-otp), JWT token management,
and updating ~/.hermes/.env or session state.
"""

import sys
import json
import os
import urllib.request
import urllib.error

BASE_URL = os.environ.get("STALLION_BACKEND_URL", "https://api.dev.batman.co.in")
HERMES_ENV_PATH = os.path.expanduser("~/.hermes/.env")
TOKEN_CACHE_PATH = os.path.expanduser("~/.hermes/stallion_jwt.json")


def send_otp(mobile_number: str) -> dict:
    url = f"{BASE_URL}/auth/send-otp"
    payload = json.dumps({"mobile_number": str(mobile_number).strip()}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        return {"success": False, "error": f"HTTP {e.code}: {err_msg}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def verify_otp(mobile_number: str, code: str) -> dict:
    url = f"{BASE_URL}/auth/verify-otp"
    payload = json.dumps({
        "mobile_number": str(mobile_number).strip(),
        "code": str(code).strip()
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success") and "data" in data and "token" in data["data"]:
                token = data["data"]["token"]
                user = data["data"].get("user", {})
                save_token(token, user)
            return data
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        return {"success": False, "error": f"HTTP {e.code}: {err_msg}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def save_token(token: str, user: dict = None):
    # 1. Save to local JSON cache
    cache = {"token": token, "user": user or {}}
    os.makedirs(os.path.dirname(TOKEN_CACHE_PATH), exist_ok=True)
    with open(TOKEN_CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)

    # 2. Update ~/.hermes/.env MCP_STALLION_API_KEY
    if os.path.exists(HERMES_ENV_PATH):
        with open(HERMES_ENV_PATH, "r") as f:
            lines = f.readlines()
        new_lines = []
        found = False
        for line in lines:
            if line.startswith("MCP_STALLION_API_KEY="):
                new_lines.append(f"MCP_STALLION_API_KEY={token}\n")
                found = True
            elif line.startswith("STALLION_JWT_TOKEN="):
                new_lines.append(f"STALLION_JWT_TOKEN={token}\n")
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"\nMCP_STALLION_API_KEY={token}\n")
            new_lines.append(f"STALLION_JWT_TOKEN={token}\n")
        with open(HERMES_ENV_PATH, "w") as f:
            f.writelines(new_lines)


def get_stored_token() -> str:
    if os.path.exists(TOKEN_CACHE_PATH):
        try:
            with open(TOKEN_CACHE_PATH, "r") as f:
                data = json.load(f)
                return data.get("token", "")
        except Exception:
            pass
    return os.environ.get("MCP_STALLION_API_KEY", os.environ.get("STALLION_JWT_TOKEN", ""))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 stallion_auth.py send-otp <mobile_number>")
        print("  python3 stallion_auth.py verify-otp <mobile_number> <code>")
        print("  python3 stallion_auth.py get-token")
        print("  python3 stallion_auth.py set-token <token>")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "send-otp":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "Missing mobile_number"}))
            sys.exit(1)
        res = send_otp(sys.argv[2])
        print(json.dumps(res, indent=2))

    elif cmd == "verify-otp":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Missing mobile_number or code"}))
            sys.exit(1)
        res = verify_otp(sys.argv[2], sys.argv[3])
        print(json.dumps(res, indent=2))

    elif cmd == "get-token":
        t = get_stored_token()
        print(json.dumps({"token": t, "has_token": bool(t)}))

    elif cmd == "set-token":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "Missing token"}))
            sys.exit(1)
        save_token(sys.argv[2])
        print(json.dumps({"success": True, "message": "Token saved successfully"}))

    else:
        print(json.dumps({"success": False, "error": f"Unknown command {cmd}"}))
        sys.exit(1)
