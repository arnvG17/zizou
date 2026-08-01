// src/tui/diff-preview.tsx
//
// LAYER: tui/
//
// Ink component for diff preview before file write/edit.
// Shows a compact diff with accept/reject prompt.

import React from "react";
import { Box, Text } from "ink";
import * as diff from "diff";

interface DiffPreviewProps {
  /** The file path being modified */
  filePath: string;
  /** The original content (null for new files) */
  oldContent: string | null;
  /** The new content (null for deletions) */
  newContent: string | null;
  /** Called when user accepts the change */
  onAccept: () => void;
  /** Called when user rejects the change */
  onReject: () => void;
}

export function DiffPreview({
  filePath,
  oldContent,
  newContent,
  onAccept,
  onReject,
}: DiffPreviewProps) {
  // Generate unified diff
  const diffOutput = React.useMemo(() => {
    if (oldContent === null && newContent !== null) {
      // New file
      return [`+++ ${filePath} (new file)`, ...newContent.split("\n").map(line => `+ ${line}`)];
    } else if (oldContent !== null && newContent === null) {
      // Delete file
      return [`--- ${filePath} (deleted)`, ...oldContent.split("\n").map(line => `- ${line}`)];
    } else if (oldContent !== null && newContent !== null) {
      // Modify file
      const changes = diff.diffLines(oldContent, newContent);
      const lines: string[] = [];
      
      for (const change of changes) {
        if (change.added) {
          lines.push(...change.value.split("\n").filter(l => l).map(line => `+ ${line}`));
        } else if (change.removed) {
          lines.push(...change.value.split("\n").filter(l => l).map(line => `- ${line}`));
        } else {
          // Show context lines (simplified)
          const contextLines = change.value.split("\n").filter(l => l).slice(0, 3);
          if (contextLines.length > 0) {
            lines.push(...contextLines.map(line => `  ${line}`));
          }
        }
      }
      
      return [`--- ${filePath}`, `+++ ${filePath}`, ...lines];
    }
    return [];
  }, [filePath, oldContent, newContent]);

  const operation = oldContent === null ? "CREATE" : newContent === null ? "DELETE" : "MODIFY";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color="yellow">
          {operation}: {filePath}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {diffOutput.slice(0, 15).map((line, index) => (
          <Box key={index}>
            <Text
              color={
                line.startsWith("+") ? "green" :
                line.startsWith("-") ? "red" :
                "gray"
              }
            >
              {line}
            </Text>
          </Box>
        ))}
        {diffOutput.length > 15 && (
          <Box>
            <Text color="gray" dimColor>
              ... ({diffOutput.length - 15} more lines)
            </Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Accept this change? (Y/n)
        </Text>
      </Box>
    </Box>
  );
}