## Channels

All channels implement the `Channel` interface from `router.ts`. The Router dispatches uniformly — channel-specific behaviour lives in each channel's subdirectory.

### Channel interface
- `reply` / `replyWithView` — send final response (view is optional, Router falls back to reply)
- `sendStatus` — progress updates during processing (tool calls, thinking)
- `sendStreamText` / `sendStreamEnd` — partial text streaming for channels that support it
- `sendTyping` — typing indicator
- `start` / `stop` — lifecycle management
