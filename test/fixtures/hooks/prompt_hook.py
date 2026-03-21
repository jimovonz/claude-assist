#!/usr/bin/env python3
"""Test fixture: mock prompt hook that returns context for known queries."""
import json, sys

data = json.load(sys.stdin)
message = data.get("user_message", "")

# Simulate context injection for specific queries
if "inject-context" in message:
    print(json.dumps({
        "hookSpecificOutput": {
            "additionalContext": "<cairn_context>Relevant test context here.</cairn_context>"
        }
    }))
else:
    print(json.dumps({}))
