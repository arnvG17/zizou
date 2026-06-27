/**
 * Figurine.tsx — Pixel-art splash screen (ZIZOU wordmark + animated sprite + goalpost).
 *
 * Ported from zizou_cli_full_flow_v3.html into Ink/React for the terminal.
 * - Welcome line & model/cwd status bar
 * - 24×30 animated footballer sprite + separate moving football + goalpost behind
 * - Block-pixel "ZIZOU" wordmark
 * - Responsive sizing and layout options
 * - Mini-wordmark helper for the sidebar
 *
 * Layer: ui
 * Allowed imports: none (UI only)
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useStdout, useInput } from "ink";

// ─── Brand colour ────────────────────────────────────────────────────────────
const BRAND = "#3B5FE0";

// ─── Terminal size hook ──────────────────────────────────────────────────────
export function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

// ─── FONT — 7-wide × 9-tall block-pixel letter definitions ──────────────────
const FONT: Record<string, string[]> = {
  Z: ["1111111","1111111","0000110","0001100","0011000","0110000","1100000","1111111","1111111"],
  I: ["1111111","1111111","0011100","0011100","0011100","0011100","0011100","1111111","1111111"],
  O: ["0111110","1111111","1100011","1100011","1100011","1100011","1100011","1111111","0111110"],
  U: ["1100011","1100011","1100011","1100011","1100011","1100011","1100011","1111111","0111110"],
};

// ─── MINI FONT for Sidebar (3 rows high) ─────────────────────────────────────
const MINI_FONT: Record<string, string[]> = {
  Z: ["██████", "    ██", "██████"],
  I: ["██", "██", "██"],
  O: ["██████", "██  ██", "██████"],
  U: ["██  ██", "██  ██", "██████"],
};

// ─── SPRITE COLORS ───────────────────────────────────────────────────────────
const SPRITE_COLORS: Record<string, string> = {
  S: "#F0BD96",  // skin
  s: "#D89A70",  // skin shadow
  H: "#F7D2AE",  // skin highlight
  B: "#2A211B",  // brow
  M: "#FFFFFF",  // mouth white
  m: "#C97A5E",  // mouth lip
  C: "#3B5FE0",  // blue shirt
  c: "#28459E",  // dark blue
  X: "#F2F2EF",  // white band
  R: "#D43B3B",  // red stripe
  k: "#1E2230",  // crest
  W: "#F4F4F2",  // shorts
  w: "#D8D8D4",  // shorts shadow
  K: "#3B5FE0",  // socks
  D: "#23211F",  // boots
  F: "#F6F6F2",  // ball white
  f: "#1B1B1B",  // ball line
  g: "#C9C9C5",  // ball shadow
  i: "#FFFFFF",  // ball highlight
  P: "#E9E9E6",  // goalpost
  n: "#444444",  // goal net hatch
};

// ─── SPRITE FRAMES (v4 — 24-wide × 30-tall) ─────────────────────────────────
const FRAME_1 = [
  "......SSSSSSSSSSSS......",
  ".....SHSSSSSSSSSSHS.....",
  "....SSSSSSSSSSSSSSSS....",
  "....SSSSSSSSSSSSSSSS....",
  "....SSSSSSSSSSSSSSSS....",
  "....SBBSSSSSSSSBBSS.....",
  "....SSSSSSSSSSSSSS......",
  "....SSSMMMMMMMMMSSS.....",
  ".....SSmMMMMMMMmSS......",
  "......SSSSSSSSSSS.......",
  "......CCCCCCCCCCC.......",
  ".....CCCCCCCCCCCCC......",
  "....CCCkCCCCCCCCCCC.....",
  "....CCCCCCCCCCCCCCC.....",
  "....XXXXXXXXXXXXXXX.....",
  "....XXXXXXXXXXXXXXX.....",
  "....RRRRRRRRRRRRRRR.....",
  "....XXXXXXXXXXXXXXX.....",
  "....XXXXXXXXXXXXXXX.....",
  "....CCCCCCCCCCCCCCC.....",
  ".....CCCCCCCCCCCCC......",
  "......CCCCCCCCCCC.......",
  ".......WWWWW.WWWWW......",
  ".......WWWWW.WWWWW......",
  ".......WWWWW.WWWWW......",
  "........KKK...KKK.......",
  "........KKK...KKK.......",
  "........DDD...DDD.......",
  "........................",
  "........................",
];

const FRAME_2 = [
  ".....SSSSSSSSSSSS.......",
  "....SHSSSSSSSSSSHS......",
  "...SSSSSSSSSSSSSSSS.....",
  "...SSSSSSSSSSSSSSSS.....",
  "...SSSSSSSSSSSSSSSS.....",
  "...SBBSSSSSSSSBBSS......",
  "...SSSSSSSSSSSSSS.......",
  "...SSSMMMMMMMMMSSS......",
  "....SSmMMMMMMMmSS.......",
  ".....SSSSSSSSSSS........",
  ".....CCCCCCCCCCCC.......",
  "....CCCCCCCCCCCCCC......",
  "...CCCkCCCCCCCCCCCC.....",
  "...CCCCCCCCCCCCCCCC.....",
  "...XXXXXXXXXXXXXXXX.....",
  "...XXXXXXXXXXXXXXXX.....",
  "...RRRRRRRRRRRRRRRR.....",
  "...XXXXXXXXXXXXXXXX.....",
  "...XXXXXXXXXXXXXXXX.....",
  "...CCCCCCCCCCCCCCC......",
  "....CCCCCCCCCCCCC.......",
  ".....CCCCCCCCCCC........",
  ".......WWWWW....WWWWW...",
  ".......WWWWW.....WWWWW..",
  ".......WWWWW......WWWW..",
  "........KKK.........KK..",
  "........KKK..........D..",
  "........DDD.............",
  "........................",
  "........................",
];

const SPRITE_W = 24;
const CANVAS_W = 26; // Goalpost is 26 wide, sprite centered at col index 1

// ─── BALL FRAME & POSITIONS ──────────────────────────────────────────────────
const BALL_FRAME = [
  ".iFFi.",
  "FFfFF",
  "FfgfF",
  "FFggF",
  ".gFFg."
];
const BALL_W = 5;
const BALL_H = 5;
const BALL_POS_1 = { col: 13, row: 25 };
const BALL_POS_2 = { col: 19, row: 22 };

// ─── GOALPOST GENERATOR (16 tall × 26 wide) ──────────────────────────────────
const GOALPOST_H = 16;
const GOALPOST_W = 26;

function generateGoalpostGrid(): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < GOALPOST_H; r++) {
    const row: string[] = [];
    for (let c = 0; c < GOALPOST_W; c++) {
      const isLeftPost = (c === 1 || c === 2);
      const isRightPost = (c === GOALPOST_W - 3 || c === GOALPOST_W - 2);
      const isTopBar = (r === 0 || r === 1);
      const insideFrame = c > 2 && c < GOALPOST_W - 3 && r > 1;
      const netDot = insideFrame && ((r + c) % 3 === 0);

      if (isTopBar || isLeftPost || isRightPost) {
        row.push("P");
      } else if (netDot) {
        row.push("n");
      } else {
        row.push(".");
      }
    }
    grid.push(row);
  }
  return grid;
}

// ─── Sizing Modes ────────────────────────────────────────────────────────────
export type FigurineSizeMode = "full" | "compact" | "tiny" | "text-only";

export function getFigurineSizeMode(cols: number): FigurineSizeMode {
  if (cols >= 90) return "full";
  if (cols >= 60) return "compact";
  if (cols >= 40) return "tiny";
  return "text-only";
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function buildPixelRow(
  rowData: string[],
  colorMap: Record<string, string>,
  px: string,
  empty: string,
): Array<{ text: string; color: string | null }> {
  const segments: Array<{ text: string; color: string | null }> = [];
  let currentColor: string | null = null;
  let currentText = "";

  for (let i = 0; i < rowData.length; i++) {
    const ch = rowData[i];
    const color = colorMap[ch] ?? null;
    const char = color ? px : empty;

    if (color === currentColor) {
      currentText += char;
    } else {
      if (currentText) {
        segments.push({ text: currentText, color: currentColor });
      }
      currentColor = color;
      currentText = char;
    }
  }
  if (currentText) {
    segments.push({ text: currentText, color: currentColor });
  }
  return segments;
}

function SegmentRow({ segments }: { segments: Array<{ text: string; color: string | null }> }) {
  return (
    <Text>
      {segments.map((seg, i) =>
        seg.color ? (
          <Text key={i} color={seg.color}>{seg.text}</Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}

// ─── Wordmark Component ──────────────────────────────────────────────────────

function Wordmark({ pixelChar, emptyChar, gap }: { pixelChar: string; emptyChar: string; gap: string }) {
  const word = "ZIZOU";
  const rowCount = FONT.Z.length; // 9

  const rows = useMemo(() => {
    const result: Array<Array<{ text: string; color: string | null }>> = [];
    for (let r = 0; r < rowCount; r++) {
      const segments: Array<{ text: string; color: string | null }> = [];
      for (let li = 0; li < word.length; li++) {
        const letter = word[li];
        const bits = FONT[letter]?.[r] ?? "0000000";
        let letterStr = "";
        for (const b of bits) {
          letterStr += b === "1" ? pixelChar : emptyChar;
        }
        segments.push({ text: letterStr, color: BRAND });
        if (li < word.length - 1) {
          segments.push({ text: gap, color: null });
        }
      }
      result.push(segments);
    }
    return result;
  }, [pixelChar, emptyChar, gap]);

  return (
    <Box flexDirection="column" alignItems="center">
      {rows.map((segs, i) => (
        <SegmentRow key={i} segments={segs} />
      ))}
    </Box>
  );
}

// ─── Sprite + Goalpost + Ball Component ───────────────────────────────────────

function SpriteWithBallAndGoalpost({ px, empty }: { px: string; empty: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f === 0 ? 1 : 0));
    }, 600);
    return () => clearInterval(id);
  }, []);

  const compositeRows = useMemo(() => {
    const spriteRows = frame === 0 ? FRAME_1 : FRAME_2;
    const ballPos = frame === 0 ? BALL_POS_1 : BALL_POS_2;
    const postGrid = generateGoalpostGrid();

    // Create 26x30 grid
    const canvas: string[][] = Array.from({ length: 30 }, () =>
      Array.from({ length: CANVAS_W }, () => ".")
    );

    // 1. Layer goalpost on bottom 16 rows
    for (let r = 0; r < GOALPOST_H; r++) {
      const canvasRow = 14 + r;
      for (let c = 0; c < GOALPOST_W; c++) {
        const ch = postGrid[r][c];
        if (ch !== ".") {
          canvas[canvasRow][c] = ch;
        }
      }
    }

    // 2. Layer sprite (centered horizontally, starting at col 1)
    for (let r = 0; r < 30; r++) {
      const rowStr = spriteRows[r];
      for (let c = 0; c < SPRITE_W; c++) {
        const ch = rowStr[c];
        if (ch !== ".") {
          canvas[r][c + 1] = ch;
        }
      }
    }

    // 3. Layer ball
    for (let br = 0; br < BALL_H; br++) {
      const gridRow = ballPos.row + br;
      if (gridRow < 0 || gridRow >= 30) continue;
      for (let bc = 0; bc < BALL_W; bc++) {
        const gridCol = ballPos.col + bc + 1;
        if (gridCol < 0 || gridCol >= CANVAS_W) continue;
        const ballCh = BALL_FRAME[br]?.[bc] ?? ".";
        if (ballCh !== "." && ballCh !== " ") {
          canvas[gridRow][gridCol] = ballCh;
        }
      }
    }

    return canvas.map((row) => buildPixelRow(row, SPRITE_COLORS, px, empty));
  }, [frame, px, empty]);

  return (
    <Box flexDirection="column" alignItems="center">
      {compositeRows.map((segs, i) => (
        <SegmentRow key={i} segments={segs} />
      ))}
    </Box>
  );
}

// ─── Mini Sidebar Wordmark Component ─────────────────────────────────────────

export function SidebarWordmark() {
  const word = "ZIZOU";
  const rowCount = 3;

  const rows = useMemo(() => {
    const result: Array<Array<{ text: string; color: string | null }>> = [];
    for (let r = 0; r < rowCount; r++) {
      const segments: Array<{ text: string; color: string | null }> = [];
      for (let li = 0; li < word.length; li++) {
        const letter = word[li];
        const art = MINI_FONT[letter]?.[r] ?? "      ";
        segments.push({ text: art, color: BRAND });
        if (li < word.length - 1) {
          segments.push({ text: " ", color: null });
        }
      }
      result.push(segments);
    }
    return result;
  }, []);

  return (
    <Box flexDirection="column" alignItems="center">
      {rows.map((segs, i) => (
        <SegmentRow key={i} segments={segs} />
      ))}
    </Box>
  );
}

// ─── Main Splash Component ───────────────────────────────────────────────────

export function Figurine() {
  const { cols } = useTerminalSize();
  const mode = getFigurineSizeMode(cols);

  const cwd = useMemo(() => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const full = process.cwd();
    if (home && full.startsWith(home)) {
      return "~" + full.slice(home.length).replace(/\\/g, "/");
    }
    return full.replace(/\\/g, "/");
  }, []);

  const px = mode === "tiny" ? "█" : "██";
  const empty = mode === "tiny" ? " " : "  ";
  const wordGap = mode === "tiny" ? " " : "  ";

  if (mode === "text-only") {
    return (
      <Box flexDirection="column" paddingX={2} marginY={1}>
        <Text color="#8A8F98">
          Welcome to the <Text color={BRAND} bold>Zizou</Text> agent experience <Text color={BRAND}>*</Text>
        </Text>
        <Box marginTop={1}>
          <Text color="#6B7280">
            <Text color={BRAND}>{">"}</Text> claude-sonnet-4-6 · {cwd}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center" paddingX={2} marginY={1} width="100%">
      {/* Welcome line */}
      <Box marginBottom={1} width="100%">
        <Text color="#8A8F98">
          Welcome to the <Text color={BRAND}>Zizou</Text> agent experience <Text color={BRAND}>*</Text>
        </Text>
      </Box>

      {/* Stacked Wordmark + Sprite */}
      <Box flexDirection="column" alignItems="center" gap={1}>
        {mode !== "tiny" && (
          <Box marginBottom={1}>
            <SpriteWithBallAndGoalpost px={px} empty={empty} />
          </Box>
        )}
        <Wordmark pixelChar={px} emptyChar={empty} gap={wordGap} />
      </Box>

      {/* Status bar */}
      <Box marginTop={2} width="100%" borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="rgba(255,255,255,0.08)" paddingTop={1}>
        <Text color="#6B7280">
          <Text color={BRAND}>{">"}</Text> claude-sonnet-4-6 · {cwd}
        </Text>
      </Box>
    </Box>
  );
}
