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
  /**
   * Reports whether this overlay currently has matches, and so whether it
   * will consume the Enter key.
   *
   * The parent needs this because Ink delivers a keypress to EVERY mounted
   * useInput handler. With the overlay open, Enter hit both this component
   * (select the file) and the TextInput's onSubmit (send the prompt) — so
   * picking a file also fired the half-typed "@que" prompt. The parent
   * suppresses its submit only while this is true, which keeps Enter working
   * normally when the query matches nothing.
   */
  onActiveChange?: (active: boolean) => void;
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
  onActiveChange,
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
    const allFiles = getFileIndex();

    // A bare "@" lists the first files rather than showing nothing. An empty
    // query is not "no matches" — it is "you have not narrowed yet", and
    // rendering nothing there makes the picker look broken.
    if (!searchQuery) {
      return allFiles.slice(0, 10).map((path) => ({ path, score: 0 }));
    }

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

  // Tell the parent whether Enter belongs to us this render. Also fires with
  // `false` on unmount, so a closed overlay can never leave submit suppressed.
  const active = matches.length > 0;
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

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

  // Nothing matched the query — the overlay gets out of the way, and Enter
  // goes back to submitting the prompt (see onActiveChange).
  if (matches.length === 0) {
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