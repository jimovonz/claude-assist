import React from "react";
import { Box, Text } from "ink";
import { Markdown } from "./Markdown";

export interface Message {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

interface MessageBlockProps {
  message: Message;
}

export function MessageBlock({ message }: MessageBlockProps) {
  const isUser = message.role === "user";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "blue" : "green"}>
        {isUser ? "You" : "Claude"}
        {message.streaming && <Text dimColor> (streaming...)</Text>}
      </Text>
      <Box marginLeft={2}>
        {isUser ? (
          <Text wrap="wrap">{message.text}</Text>
        ) : (
          <Markdown text={message.text} />
        )}
      </Box>
    </Box>
  );
}
