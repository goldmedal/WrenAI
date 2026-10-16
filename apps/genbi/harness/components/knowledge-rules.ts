import { z } from "zod";

/**
 * A project's business rules (`knowledge/rules/*.md`, or the legacy root `instructions.md`): canonical
 * metric definitions, default filters, units, enum meanings. The context loader reads them into its
 * capability catalog (`knowledge_rules`); they are project data the host injects next to the semantic
 * context, never text of a Hub prompt.
 */
export const knowledgeRuleFile = z.object({ path: z.string(), content: z.string() });
export type KnowledgeRuleFile = z.infer<typeof knowledgeRuleFile>;
export const knowledgeRuleFiles = z.array(knowledgeRuleFile).default([]);

/** The rules of a raw catalog document; empty when the document carries none or a malformed list. */
export function knowledgeRulesOfCatalog(catalog: unknown): KnowledgeRuleFile[] {
  if (typeof catalog !== "object" || catalog === null) return [];
  const parsed = knowledgeRuleFiles.safeParse((catalog as Record<string, unknown>)["knowledge_rules"]);
  return parsed.success ? parsed.data : [];
}

/** The `## Knowledge rules` section, each file verbatim under its path. Empty (no lines) when there are no rules. */
export function knowledgeRulesSection(files: readonly KnowledgeRuleFile[]): string {
  if (files.length === 0) return "";
  const intro = "Business rules of the bound project (canonical metric definitions, default filters, units, enum meanings). Follow them when choosing tables, filters and metric definitions.";
  return ["## Knowledge rules", intro, ...files.map((file) => `### ${file.path}\n${file.content}`)].join("\n\n");
}

/**
 * The host context one component carries into the broker. The rules key is present only when the
 * project has rules, so the identity digest over the contexts (`planDigest`) covers them and a project
 * without rules keeps the digest it had before rules existed.
 */
export function withKnowledgeRules<T extends object>(context: T, rules: readonly KnowledgeRuleFile[]): T & { rules?: readonly KnowledgeRuleFile[] } {
  return rules.length > 0 ? { ...context, rules } : context;
}
