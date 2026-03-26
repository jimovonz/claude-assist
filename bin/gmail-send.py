#!/usr/bin/env python3
"""
Gmail send — send an email (for testing and future use).

Usage:
  gmail-send.py --to <email> --subject <subject> --body <body>
  gmail-send.py --to <email> --subject <subject> --body <body> --reply-to <message_id>

Output: JSON with sent message ID
"""

import sys
import json
import argparse
import base64
from email.mime.text import MIMEText
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--to', required=True)
    parser.add_argument('--subject', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('--reply-to', help='Message ID to reply to (sets threadId and In-Reply-To)')
    args = parser.parse_args()

    creds = get_creds()
    gmail = build('gmail', 'v1', credentials=creds)

    msg = MIMEText(args.body)
    msg['to'] = args.to
    msg['subject'] = args.subject

    body = {'raw': base64.urlsafe_b64encode(msg.as_bytes()).decode()}

    # If replying, get the original message's threadId and Message-ID
    if args.reply_to:
        original = gmail.users().messages().get(userId='me', id=args.reply_to, format='metadata',
                                                 metadataHeaders=['Message-ID']).execute()
        body['threadId'] = original['threadId']
        for h in original.get('payload', {}).get('headers', []):
            if h['name'] == 'Message-ID':
                msg['In-Reply-To'] = h['value']
                msg['References'] = h['value']
                body['raw'] = base64.urlsafe_b64encode(msg.as_bytes()).decode()
                break

    result = gmail.users().messages().send(userId='me', body=body).execute()
    print(json.dumps({'ok': True, 'id': result['id'], 'threadId': result['threadId']}))


if __name__ == '__main__':
    main()
