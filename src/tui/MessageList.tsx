import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import { MessageBlock, type Message } from "./MessageBlock";

interface MessageListProps {
  messages: Message[];
  incognito?: boolean;
  onKeyRef?: React.MutableRefObject<((input: string, key: any) => void) | undefined>;
}

export const MessageList = React.memo(function MessageList({ messages, incognito, onKeyRef }: MessageListProps) {
  const { stdout } = useStdout();
  const [scrollOffset, setScrollOffset] = useState(0);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  // Register scroll handler via ref — no useInput needed
  const handler = useCallback((_input: string, key: any) => {
    if (key.pageUp || (key.shift && key.upArrow)) {
      setScrollOffset((prev) => Math.min(prev + 5, Math.max(0, messages.length - 1)));
    }
    if (key.pageDown || (key.shift && key.downArrow)) {
      setScrollOffset((prev) => Math.max(0, prev - 5));
    }
    if (key.home) {
      setScrollOffset(Math.max(0, messages.length - 1));
    }
    if (key.end) {
      setScrollOffset(0);
    }
  }, [messages.length]);

  useEffect(() => {
    if (onKeyRef) onKeyRef.current = handler;
  }, [handler, onKeyRef]);

  // Calculate visible messages based on scroll offset
  const endIdx = messages.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - 50); // Show up to 50 messages
  const visible = messages.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {scrollOffset > 0 && !incognito && (
        <Text dimColor>-- {scrollOffset} more below (Shift+Down to scroll) --</Text>
      )}
      {visible.map((msg, i) => (
        <MessageBlock key={startIdx + i} message={msg} incognito={incognito} />
      ))}
      {scrollOffset > 0 && !incognito && (
        <Text dimColor>-- scrolled up {scrollOffset} messages --</Text>
      )}
    </Box>
  );
});
