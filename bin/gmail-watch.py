#!/usr/bin/env python3
"""
Gmail watch — register/renew push notifications via Pub/Sub.

Usage:
  gmail-watch.py start    # register watch (lasts 7 days)
  gmail-watch.py stop     # stop watching
  gmail-watch.py status   # check current watch status

Output: JSON
"""

import sys
import json
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

TOKEN_PATH = Path.home() / ".config" / "google" / "token.json"
TOPIC = os.environ.get("GMAIL_PUBSUB_TOPIC", "projects/GCP_PROJECT_ID/topics/gmail-notifications")
STATE_PATH = Path.home() / ".local" / "state" / "claude-assist" / "gmail-watch.json"


def get_creds():
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json())
        TOKEN_PATH.chmod(0o600)
    return creds


def save_state(data):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(data, indent=2))


def load_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {}


def cmd_start():
    gmail = build('gmail', 'v1', credentials=get_creds())
    result = gmail.users().watch(userId='me', body={
        'topicName': TOPIC,
        'labelIds': ['INBOX'],
    }).execute()

    state = {
        'historyId': result.get('historyId'),
        'expiration': result.get('expiration'),
        'registered_at': __import__('time').time(),
    }
    save_state(state)

    print(json.dumps({
        'ok': True,
        'historyId': result.get('historyId'),
        'expiration': result.get('expiration'),
    }, indent=2))


def cmd_stop():
    gmail = build('gmail', 'v1', credentials=get_creds())
    gmail.users().stop(userId='me').execute()
    save_state({})
    print(json.dumps({'ok': True, 'stopped': True}))


def cmd_status():
    state = load_state()
    if not state:
        print(json.dumps({'watching': False}))
        return

    import time
    expiration = int(state.get('expiration', 0))
    now_ms = int(time.time() * 1000)
    remaining_hours = max(0, (expiration - now_ms) / 3600000)

    print(json.dumps({
        'watching': remaining_hours > 0,
        'historyId': state.get('historyId'),
        'expiration': expiration,
        'remainingHours': round(remaining_hours, 1),
    }, indent=2))


def main():
    if len(sys.argv) < 2:
        print('Usage: gmail-watch.py <start|stop|status>', file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'start':
        cmd_start()
    elif cmd == 'stop':
        cmd_stop()
    elif cmd == 'status':
        cmd_status()
    else:
        print(f'Unknown command: {cmd}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
