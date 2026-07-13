export type NavItem = {
  title: string;
  slug: string; // The URL route (e.g. "getting-started", "commands")
  hash?: string; // Anchor link (e.g. "installation")
  category: "Guide" | "Reference";
  sidebarLabel: string;
};

export const navItems: NavItem[] = [
  { title: "Getting Started", slug: "getting-started", category: "Guide", sidebarLabel: "Getting Started" },
  { title: "Installation", slug: "getting-started", hash: "installation", category: "Guide", sidebarLabel: "Installation" },
  { title: "Slash Commands", slug: "commands", category: "Reference", sidebarLabel: "Slash Commands" },
  { title: "LLM Compatibility", slug: "commands", hash: "llm-compatibility", category: "Reference", sidebarLabel: "LLM Compatibility" },
  { title: "Security", slug: "security", category: "Reference", sidebarLabel: "Security" },
  { title: "Architecture", slug: "security", hash: "architecture", category: "Reference", sidebarLabel: "Architecture" },
  { title: "File Structure", slug: "file-structure", category: "Reference", sidebarLabel: "File Structure" },
  { title: "Known Limitations", slug: "file-structure", hash: "known-limitations", category: "Reference", sidebarLabel: "Known Limitations" },
];

export const docRoutes = ["getting-started", "commands", "security", "file-structure"];

export function getAdjacentRoutes(currentSlug: string) {
  const index = docRoutes.indexOf(currentSlug);
  const routeTitles: Record<string, string> = {
    "getting-started": "Getting Started",
    "commands": "Slash Commands",
    "security": "Security & Keys",
    "file-structure": "File Structure & Limitations",
  };
  return {
    prev: index > 0 ? { slug: docRoutes[index - 1], title: routeTitles[docRoutes[index - 1]] } : null,
    next: index < docRoutes.length - 1 ? { slug: docRoutes[index + 1], title: routeTitles[docRoutes[index + 1]] } : null,
  };
}
