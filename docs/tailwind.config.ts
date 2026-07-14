import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist Sans", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "monospace"],
        "geist-sans": ["Geist Sans", "system-ui", "sans-serif"],
        "geist-mono": ["Geist Mono", "monospace"],
        instrument: ["var(--font-instrument)", "serif"],
        "instrument-italic": ["var(--font-instrument)", "serif"],
        "pixel-square": ["var(--font-pixel-square)", "monospace"],
        "pixel-grid": ["var(--font-pixel-grid)", "monospace"],
        "pixel-circle": ["var(--font-pixel-circle)", "monospace"],
        "pixel-triangle": ["var(--font-pixel-triangle)", "monospace"],
        "pixel-line": ["var(--font-pixel-line)", "monospace"],
      },
      colors: {
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          blue: "hsl(var(--accent-blue) / <alpha-value>)",
        },
        customBg: "var(--background)",
        customText: "var(--foreground)",
        customCard: "var(--card-bg)",
        customBorder: "var(--border-color)",
      },
    },
  },
  plugins: [],
};

export default config;

