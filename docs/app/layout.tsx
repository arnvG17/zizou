import "./globals.css";
import "./custom.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zizou Docs - AI Coding Agent CLI Reference",
  description: "Official documentation, command reference, and security guides for the Zizou AI coding partner CLI.",
};

import { ThemeProvider } from "@/components/theme-context";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Geist+Pixel:ELSH@90.9&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
