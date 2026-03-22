import React from "react";
import { Box, Text } from "ink";
import { Markdown } from "./Markdown";
import { bashPrompt } from "./InputArea";

export interface Message {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

interface MessageBlockProps {
  message: Message;
  incognito?: boolean;
}

export function MessageBlock({ message, incognito }: MessageBlockProps) {
  const isUser = message.role === "user";

  if (incognito) {
    return (
      <Box flexDirection="column">
        {isUser ? (
          <Text wrap="wrap">
            <Text color="green">{bashPrompt()}$ </Text>{message.text}
          </Text>
        ) : (
          <Markdown text={message.text} />
        )}
      </Box>
    );
  }

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
