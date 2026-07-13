import Link from "next/link";
import { getAdjacentRoutes } from "@/lib/nav-config";

export function PaginationFooter({ currentSlug }: { currentSlug: string }) {
  const { prev, next } = getAdjacentRoutes(currentSlug);

  return (
    <div className="mt-12 flex flex-col sm:flex-row items-stretch sm:items-center justify-between border-t border-dashed border-current border-opacity-15 pt-8 gap-4 font-mono">
      {prev ? (
        <Link
          href={`/${prev.slug}`}
          className="group flex flex-col items-start border border-current border-opacity-10 hover:border-accent p-4 rounded bg-neutral-900/10 hover:bg-neutral-900/20 transition-all flex-1"
        >
          <span className="text-[9px] text-neutral-500 uppercase tracking-widest flex items-center gap-1 group-hover:text-accent transition-colors">
            ← Previous Section
          </span>
          <span className="text-xs font-bold text-neutral-300 group-hover:text-white mt-1">
            {prev.title}
          </span>
        </Link>
      ) : (
        <div className="flex-1 hidden sm:block" />
      )}
      
      {next ? (
        <Link
          href={`/${next.slug}`}
          className="group flex flex-col items-end border border-current border-opacity-10 hover:border-accent p-4 rounded bg-neutral-900/10 hover:bg-neutral-900/20 transition-all flex-1 text-right"
        >
          <span className="text-[9px] text-neutral-500 uppercase tracking-widest flex items-center gap-1 group-hover:text-accent transition-colors">
            Next Section →
          </span>
          <span className="text-xs font-bold text-neutral-300 group-hover:text-white mt-1">
            {next.title}
          </span>
        </Link>
      ) : (
        <div className="flex-1 hidden sm:block" />
      )}
    </div>
  );
}
