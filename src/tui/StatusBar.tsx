import React from "react";
import { Box, Text } from "ink";
import type { ConnectionState } from "./Connection";

interface StatusBarProps {
  connectionState: ConnectionState;
  status: string;
}

const STATE_LABELS: Record<ConnectionState, { text: string; color: string }> = {
  disconnected: { text: "DISCONNECTED", color: "red" },
  connecting: { text: "CONNECTING", color: "yellow" },
  authenticating: { text: "AUTHENTICATING", color: "yellow" },
  connected: { text: "CONNECTED", color: "green" },
};

export function StatusBar({ connectionState, status }: StatusBarProps) {
  const stateInfo = STATE_LABELS[connectionState];

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={stateInfo.color} bold>[{stateInfo.text}]</Text>
      {status && <Text dimColor>{status}</Text>}
    </Box>
  );
}
