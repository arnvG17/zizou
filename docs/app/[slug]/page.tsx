import fs from "fs";
import path from "path";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { DocsLayout } from "@/components/docs-layout";
import { mdxComponents } from "@/components/mdx-components";
import { PaginationFooter } from "@/components/pagination-footer";
import { navItems } from "@/lib/nav-config";
import rehypePrettyCode from "rehype-pretty-code";

export async function generateStaticParams() {
  // Extract unique slugs to prevent duplicates in static exports
  const uniqueSlugs = Array.from(new Set(navItems.map((item) => item.slug)));
  return uniqueSlugs.map((slug) => ({
    slug,
  }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function DocPage({ params }: PageProps) {
  const { slug } = await params;

  // Validate slug exists in nav configuration
  const hasSlug = navItems.some((item) => item.slug === slug);
  if (!hasSlug) {
    notFound();
  }

  const filePath = path.join(process.cwd(), "content", `${slug}.mdx`);
  
  if (!fs.existsSync(filePath)) {
    notFound();
  }

  const source = fs.readFileSync(filePath, "utf8");

  return (
    <DocsLayout currentSlug={slug}>
      <article className="prose dark:prose-invert max-w-none">
        <MDXRemote
          source={source}
          components={mdxComponents}
          options={{
            mdxOptions: {
              rehypePlugins: [
                [
                  rehypePrettyCode,
                  {
                    theme: "github-dark",
                  },
                ],
              ],
            },
          }}
        />
      </article>
      <PaginationFooter currentSlug={slug} />
    </DocsLayout>
  );
}
