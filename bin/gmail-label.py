#!/usr/bin/env python3
"""
Gmail label operations — create, list, apply, remove labels.

Usage:
  gmail-label.py list                              # list all labels
  gmail-label.py create <name>                     # create a label
  gmail-label.py apply <message_id> <label_name>   # apply label to message
  gmail-label.py remove <message_id> <label_name>  # remove label from message
  gmail-label.py mark-read <message_id>            # mark message as read

Output: JSON
"""

import sys
import json
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

TOKEN_PATH = Path.home() / ".config" / "google" / "token.json"


def get_creds():
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json())
        TOKEN_PATH.chmod(0o600)
    return creds


def get_gmail():
    return build('gmail', 'v1', credentials=get_creds())


def find_label_id(gmail, name):
    """Find label ID by name (case-insensitive). Returns None if not found."""
    labels = gmail.users().labels().list(userId='me').execute().get('labels', [])
    for label in labels:
        if label['name'].lower() == name.lower():
            return label['id']
    return None


def cmd_list():
    gmail = get_gmail()
    labels = gmail.users().labels().list(userId='me').execute().get('labels', [])
    # Sort: user labels first, then system
    user_labels = sorted([l for l in labels if l['type'] == 'user'], key=lambda l: l['name'])
    system_labels = sorted([l for l in labels if l['type'] == 'system'], key=lambda l: l['name'])
    print(json.dumps({
        'user': [{'id': l['id'], 'name': l['name']} for l in user_labels],
        'system': [{'id': l['id'], 'name': l['name']} for l in system_labels],
    }, indent=2))


def cmd_create(name):
    gmail = get_gmail()
    # Check if already exists
    existing = find_label_id(gmail, name)
    if existing:
        print(json.dumps({'id': existing, 'name': name, 'existed': True}))
        return

    label = gmail.users().labels().create(userId='me', body={
        'name': name,
        'labelListVisibility': 'labelShow',
        'messageListVisibility': 'show',
    }).execute()
    print(json.dumps({'id': label['id'], 'name': label['name'], 'existed': False}))


def cmd_apply(message_id, label_name):
    gmail = get_gmail()
    label_id = find_label_id(gmail, label_name)
    if not label_id:
        # Auto-create the label
        label = gmail.users().labels().create(userId='me', body={
            'name': label_name,
            'labelListVisibility': 'labelShow',
            'messageListVisibility': 'show',
        }).execute()
        label_id = label['id']

    gmail.users().messages().modify(userId='me', id=message_id, body={
        'addLabelIds': [label_id],
    }).execute()
    print(json.dumps({'ok': True, 'messageId': message_id, 'label': label_name, 'labelId': label_id}))


def cmd_remove(message_id, label_name):
    gmail = get_gmail()
    label_id = find_label_id(gmail, label_name)
    if not label_id:
        print(json.dumps({'ok': False, 'error': f'Label "{label_name}" not found'}))
        return

    gmail.users().messages().modify(userId='me', id=message_id, body={
        'removeLabelIds': [label_id],
    }).execute()
    print(json.dumps({'ok': True, 'messageId': message_id, 'label': label_name, 'removed': True}))


def cmd_mark_read(message_id):
    gmail = get_gmail()
    gmail.users().messages().modify(userId='me', id=message_id, body={
        'removeLabelIds': ['UNREAD'],
    }).execute()
    print(json.dumps({'ok': True, 'messageId': message_id, 'markedRead': True}))


def main():
    if len(sys.argv) < 2:
        print('Usage: gmail-label.py <list|create|apply|remove|mark-read> [args]', file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'list':
        cmd_list()
    elif cmd == 'create' and len(sys.argv) >= 3:
        cmd_create(sys.argv[2])
    elif cmd == 'apply' and len(sys.argv) >= 4:
        cmd_apply(sys.argv[2], sys.argv[3])
    elif cmd == 'remove' and len(sys.argv) >= 4:
        cmd_remove(sys.argv[2], sys.argv[3])
    elif cmd == 'mark-read' and len(sys.argv) >= 3:
        cmd_mark_read(sys.argv[2])
    else:
        print(f'Unknown command or missing args: {cmd}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
