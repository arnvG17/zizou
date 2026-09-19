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
  { title: "Operating Modes", slug: "modes-and-context", category: "Guide", sidebarLabel: "Operating Modes" },
  { title: "The Plan Gate", slug: "modes-and-context", hash: "the-plan-gate", category: "Guide", sidebarLabel: "The Plan Gate" },
  { title: "Where Files Go", slug: "modes-and-context", hash: "file-placement", category: "Guide", sidebarLabel: "Where Files Go" },
  { title: "Effort", slug: "modes-and-context", hash: "effort", category: "Guide", sidebarLabel: "Effort" },
  { title: "Slash Commands", slug: "commands", category: "Reference", sidebarLabel: "Slash Commands" },
  { title: "LLM Compatibility", slug: "commands", hash: "llm-compatibility", category: "Reference", sidebarLabel: "LLM Compatibility" },
  { title: "Security", slug: "security", category: "Reference", sidebarLabel: "Security" },
  { title: "File Structure", slug: "file-structure", category: "Reference", sidebarLabel: "File Structure" },
];

export const docRoutes = ["getting-started", "modes-and-context", "commands", "security", "file-structure"];

export function getAdjacentRoutes(currentSlug: string) {
  const index = docRoutes.indexOf(currentSlug);
  const routeTitles: Record<string, string> = {
    "getting-started": "Getting Started",
    "modes-and-context": "Operating Modes",
    "commands": "Slash Commands",
    "security": "Security",
    "file-structure": "File Structure",
  };
  return {
    prev: index > 0 ? { slug: docRoutes[index - 1], title: routeTitles[docRoutes[index - 1]] } : null,
    next: index < docRoutes.length - 1 ? { slug: docRoutes[index + 1], title: routeTitles[docRoutes[index + 1]] } : null,
  };
}
