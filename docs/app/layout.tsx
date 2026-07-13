import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zizou Docs - AI Coding Agent CLI Reference",
  description: "Official documentation, command reference, and security guides for the Zizou AI coding partner CLI.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
