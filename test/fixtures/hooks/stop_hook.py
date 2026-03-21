#!/usr/bin/env python3
"""Test fixture: mock stop hook that returns block/pass based on input."""
import json, sys

data = json.load(sys.stdin)
message = data.get("last_assistant_message", "")

# If the message contains "context: insufficient", simulate a block
if "context: insufficient" in message:
    print(json.dumps({
        "decision": "block",
        "reason": "Retrieved context for testing purposes."
    }))
else:
    # Normal pass — no output means no block
    pass
