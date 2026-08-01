// src/tui/file-search-overlay.tsx
//
// LAYER: tui/
//
// Ink component for @ file search overlay.
// Detects @ typed in main input, shows fuzzy matches, allows navigation.

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import fuzzysort from "fuzzysort";
import { getFileIndex } from "./file-index.js";

interface FileSearchOverlayProps {
  /** The current input text from the main TextInput */
  inputValue: string;
  /** Cursor position in the input */
  cursorPosition: number;
  /** Called when a file is selected */
  onSelectFile: (filePath: string) => void;
  /** Called to close the overlay */
  onClose: () => void;
}

interface FileMatch {
  path: string;
  score: number;
}

export function FileSearchOverlay({
  inputValue,
  cursorPosition,
  onSelectFile,
  onClose,
}: FileSearchOverlayProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // Extract the search query after @
  useEffect(() => {
    const textBeforeCursor = inputValue.slice(0, cursorPosition);
    const atMatch = textBeforeCursor.match(/@([^\s]*)$/);
    
    if (atMatch) {
      setSearchQuery(atMatch[1]);
    } else {
      setSearchQuery("");
      onClose();
    }
  }, [inputValue, cursorPosition, onClose]);

  // Get filtered matches
  const matches = useMemo(() => {
    if (!searchQuery) return [];
    
    const allFiles = getFileIndex();
    const results = fuzzysort.go(searchQuery, allFiles, {
      limit: 10,
      threshold: -10000, // Allow some fuzziness
    });
    
    return results.map((result) => ({
      path: result.target,
      score: result.score,
    }));
  }, [searchQuery]);

  // Reset selection when matches change
  useEffect(() => {
    setSelectedIndex(0);
  }, [matches]);

  // Handle keyboard navigation using Ink's useInput
  useInput((input, key) => {
    if (matches.length === 0) return;

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, matches.length - 1));
    } else if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (key.return) {
      if (matches[selectedIndex]) {
        onSelectFile(matches[selectedIndex].path);
      }
    } else if (key.escape) {
      onClose();
    }
  });

  // Don't render if no search query or no matches
  if (!searchQuery || matches.length === 0) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color="blue">
          File Search: @{searchQuery}
        </Text>
      </Box>
      {matches.map((match, index) => (
        <Box key={match.path}>
          <Text
            color={index === selectedIndex ? "blue" : "gray"}
            bold={index === selectedIndex}
          >
            {index === selectedIndex ? "❯ " : "  "}
            {match.path}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑↓ Navigate • Enter Select • Esc Close
        </Text>
      </Box>
    </Box>
  );
}