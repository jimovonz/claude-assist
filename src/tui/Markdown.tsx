import React from "react";
import { Text, Box } from "ink";

interface MarkdownProps {
  text: string;
}

interface Line {
  type: "heading" | "code_start" | "code_end" | "code" | "list" | "text" | "blank";
  content: string;
  level?: number;
  lang?: string;
}

export function classifyLine(line: string, inCode: boolean): Line {
  if (inCode) {
    if (line.startsWith("```")) return { type: "code_end", content: "" };
    return { type: "code", content: line };
  }

  if (line.startsWith("```")) {
    const lang = line.slice(3).trim();
    return { type: "code_start", content: "", lang: lang || undefined };
  }

  const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
  if (headingMatch) {
    return { type: "heading", content: headingMatch[2]!, level: headingMatch[1]!.length };
  }

  if (line.match(/^[-*]\s+/)) {
    return { type: "list", content: line.replace(/^[-*]\s+/, "") };
  }

  if (line.trim() === "") return { type: "blank", content: "" };

  return { type: "text", content: line };
}

function renderInlineFormatting(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<Text key={key++}>{boldMatch[1]}</Text>);
      parts.push(<Text key={key++} bold>{boldMatch[2]!}</Text>);
      remaining = boldMatch[3]!;
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<Text key={key++}>{codeMatch[1]}</Text>);
      parts.push(<Text key={key++} color="cyan">{codeMatch[2]!}</Text>);
      remaining = codeMatch[3]!;
      continue;
    }

    // Italic (single *)
    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(<Text key={key++}>{italicMatch[1]}</Text>);
      parts.push(<Text key={key++} italic>{italicMatch[2]!}</Text>);
      remaining = italicMatch[3]!;
      continue;
    }

    // Plain text
    parts.push(<Text key={key++}>{remaining}</Text>);
    break;
  }

  return parts;
}

export function Markdown({ text }: MarkdownProps) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let codeLang: string | undefined;
  let key = 0;

  for (const line of lines) {
    const classified = classifyLine(line, inCode);

    switch (classified.type) {
      case "code_start":
        inCode = true;
        codeBuffer = [];
        codeLang = classified.lang;
        break;

      case "code_end":
        elements.push(
          <Box key={key++} borderStyle="round" borderColor="gray" paddingX={1} marginY={0}>
            <Text>
              {codeLang && <Text dimColor>{codeLang}\n</Text>}
              <Text color="white">{codeBuffer.join("\n")}</Text>
            </Text>
          </Box>
        );
        inCode = false;
        codeBuffer = [];
        codeLang = undefined;
        break;

      case "code":
        codeBuffer.push(classified.content);
        break;

      case "heading":
        elements.push(
          <Box key={key++} marginTop={1}>
            <Text bold underline color="cyan">{classified.content}</Text>
          </Box>
        );
        break;

      case "list":
        elements.push(
          <Box key={key++} marginLeft={2}>
            <Text>
              <Text color="gray">  - </Text>
              {renderInlineFormatting(classified.content)}
            </Text>
          </Box>
        );
        break;

      case "blank":
        elements.push(<Text key={key++}>{" "}</Text>);
        break;

      case "text":
        elements.push(
          <Text key={key++} wrap="wrap">{renderInlineFormatting(classified.content)}</Text>
        );
        break;
    }
  }

  // Flush unclosed code block
  if (inCode && codeBuffer.length > 0) {
    elements.push(
      <Box key={key++} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="white">{codeBuffer.join("\n")}</Text>
      </Box>
    );
  }

  return <Box flexDirection="column">{elements}</Box>;
}
