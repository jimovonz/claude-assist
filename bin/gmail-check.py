#!/usr/bin/env python3
"""
Gmail check — list unread emails with metadata.
Uses OAuth token at ~/.config/google/token.json.

Usage:
  gmail-check.py                       # unread in last 1 hour
  gmail-check.py --since 24            # unread in last 24 hours
  gmail-check.py --since 24 --body     # include plain text body
  gmail-check.py --query "from:dave"   # custom Gmail search query
  gmail-check.py --id <msg_id>         # get single message by ID

Output: JSON array of messages (or single message object with --id)
"""

import sys
import json
import argparse
import base64
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


def get_header(headers, name):
    for h in headers:
        if h['name'].lower() == name.lower():
            return h['value']
    return ''


def extract_body(payload):
    """Extract plain text body from message payload."""
    if payload.get('mimeType') == 'text/plain' and payload.get('body', {}).get('data'):
        return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace')
    for part in payload.get('parts', []):
        body = extract_body(part)
        if body:
            return body
    return ''


def format_message(msg, include_body=False):
    headers = msg.get('payload', {}).get('headers', [])
    email = {
        'id': msg['id'],
        'threadId': msg['threadId'],
        'from': get_header(headers, 'From'),
        'to': get_header(headers, 'To'),
        'cc': get_header(headers, 'Cc'),
        'subject': get_header(headers, 'Subject'),
        'date': get_header(headers, 'Date'),
        'snippet': msg.get('snippet', ''),
        'labels': msg.get('labelIds', []),
    }
    if include_body:
        body = extract_body(msg.get('payload', {}))
        if body:
            email['body'] = body[:4000]
    return email


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', type=int, default=1, help='Hours to look back (default: 1)')
    parser.add_argument('--max', type=int, default=20, help='Max messages (default: 20)')
    parser.add_argument('--body', action='store_true', help='Include plain text body')
    parser.add_argument('--query', type=str, help='Custom Gmail search query (overrides --since)')
    parser.add_argument('--id', type=str, help='Get single message by ID')
    parser.add_argument('--all', action='store_true', help='Include read messages too')
    args = parser.parse_args()

    creds = get_creds()
    gmail = build('gmail', 'v1', credentials=creds)

    # Single message by ID
    if args.id:
        msg = gmail.users().messages().get(userId='me', id=args.id, format='full').execute()
        print(json.dumps(format_message(msg, include_body=True), indent=2))
        return

    # List messages
    if args.query:
        query = args.query
    else:
        query = f'newer_than:{args.since}h'
        if not args.all:
            query = f'is:unread {query}'

    results = gmail.users().messages().list(userId='me', q=query, maxResults=args.max).execute()
    message_ids = results.get('messages', [])

    if not message_ids:
        print('[]')
        return

    emails = []
    for msg_ref in message_ids:
        msg = gmail.users().messages().get(userId='me', id=msg_ref['id'], format='full').execute()
        emails.append(format_message(msg, include_body=args.body))

    print(json.dumps(emails, indent=2))


if __name__ == '__main__':
    main()
