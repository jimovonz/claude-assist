#!/usr/bin/env python3
"""
Google Calendar operations — create events, list events, check free time.

Usage:
  gcal.py list [--days 7]                    # list upcoming events
  gcal.py create --title "..." --start "..." --end "..." [--desc "..."] [--location "..."]
  gcal.py today                               # today's events
  gcal.py free --date "2026-03-27"           # free slots on a date

Dates: ISO format (2026-03-27T14:00:00) or natural (parsed by caller).
For all-day events: use date only (2026-03-27) for --start and --end.

Output: JSON
"""

import sys
import json
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

TOKEN_PATH = Path.home() / ".config" / "google" / "token.json"
# NZDT = UTC+13
LOCAL_TZ = timezone(timedelta(hours=13))


def get_creds():
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json())
        TOKEN_PATH.chmod(0o600)
    return creds


def get_cal():
    return build('calendar', 'v3', credentials=get_creds())


def format_event(event):
    start = event.get('start', {})
    end = event.get('end', {})
    return {
        'id': event['id'],
        'title': event.get('summary', '(no title)'),
        'start': start.get('dateTime', start.get('date', '')),
        'end': end.get('dateTime', end.get('date', '')),
        'location': event.get('location', ''),
        'description': event.get('description', ''),
        'status': event.get('status', ''),
        'htmlLink': event.get('htmlLink', ''),
    }


def cmd_list(days=7):
    cal = get_cal()
    now = datetime.now(LOCAL_TZ)
    time_min = now.isoformat()
    time_max = (now + timedelta(days=days)).isoformat()

    events = cal.events().list(
        calendarId='primary', timeMin=time_min, timeMax=time_max,
        singleEvents=True, orderBy='startTime', maxResults=50,
    ).execute().get('items', [])

    print(json.dumps([format_event(e) for e in events], indent=2))


def cmd_today():
    cal = get_cal()
    now = datetime.now(LOCAL_TZ)
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    events = cal.events().list(
        calendarId='primary', timeMin=start_of_day.isoformat(),
        timeMax=end_of_day.isoformat(),
        singleEvents=True, orderBy='startTime',
    ).execute().get('items', [])

    print(json.dumps([format_event(e) for e in events], indent=2))


def cmd_create(title, start, end, description='', location=''):
    cal = get_cal()

    event_body = {'summary': title}
    if description:
        event_body['description'] = description
    if location:
        event_body['location'] = location

    # Determine if all-day or timed event
    if 'T' in start:
        # Timed event — ensure timezone
        if not start.endswith('Z') and '+' not in start and '-' not in start[10:]:
            start += '+13:00'
        if not end.endswith('Z') and '+' not in end and '-' not in end[10:]:
            end += '+13:00'
        event_body['start'] = {'dateTime': start}
        event_body['end'] = {'dateTime': end}
    else:
        # All-day event
        event_body['start'] = {'date': start}
        event_body['end'] = {'date': end}

    event = cal.events().insert(calendarId='primary', body=event_body).execute()
    print(json.dumps({
        'ok': True,
        'id': event['id'],
        'title': event.get('summary', ''),
        'start': event['start'].get('dateTime', event['start'].get('date', '')),
        'end': event['end'].get('dateTime', event['end'].get('date', '')),
        'htmlLink': event.get('htmlLink', ''),
    }, indent=2))


def cmd_free(date_str):
    cal = get_cal()
    date = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=LOCAL_TZ)
    start = date.replace(hour=8, minute=0)
    end = date.replace(hour=18, minute=0)

    events = cal.events().list(
        calendarId='primary', timeMin=start.isoformat(),
        timeMax=end.isoformat(),
        singleEvents=True, orderBy='startTime',
    ).execute().get('items', [])

    # Calculate free slots
    busy = []
    for e in events:
        s = e['start'].get('dateTime', e['start'].get('date', ''))
        en = e['end'].get('dateTime', e['end'].get('date', ''))
        busy.append({'title': e.get('summary', ''), 'start': s, 'end': en})

    print(json.dumps({
        'date': date_str,
        'businessHours': '08:00-18:00',
        'events': busy,
        'eventCount': len(busy),
    }, indent=2))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command')

    list_p = sub.add_parser('list')
    list_p.add_argument('--days', type=int, default=7)

    sub.add_parser('today')

    create_p = sub.add_parser('create')
    create_p.add_argument('--title', required=True)
    create_p.add_argument('--start', required=True)
    create_p.add_argument('--end', required=True)
    create_p.add_argument('--desc', default='')
    create_p.add_argument('--location', default='')

    free_p = sub.add_parser('free')
    free_p.add_argument('--date', required=True)

    args = parser.parse_args()

    if args.command == 'list':
        cmd_list(args.days)
    elif args.command == 'today':
        cmd_today()
    elif args.command == 'create':
        cmd_create(args.title, args.start, args.end, args.desc, args.location)
    elif args.command == 'free':
        cmd_free(args.date)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
