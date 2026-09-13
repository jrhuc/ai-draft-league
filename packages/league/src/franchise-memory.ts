import { z } from "zod";

import type { JsonObject, ToolDefinition } from "./types.js";

export const NOTEBOOK_PAGE = "notebook";

export const MEMORY_LIMITS = {
  pages: 16,
  nameChars: 48,
  pageChars: 8_000,
  totalChars: 48_000,
} as const;

export type FranchiseMemory = Record<string, string>;

export function emptyMemory(notebook = "") {
  return Object.fromEntries([[NOTEBOOK_PAGE, notebook]]);
}

export function canonicalMemory(memory: FranchiseMemory) {
  const entries: Array<[string, string]> = [[NOTEBOOK_PAGE, memory[NOTEBOOK_PAGE] ?? ""]];
  for (const name of Object.keys(memory).sort()) {
    if (name !== NOTEBOOK_PAGE) entries.push([name, memory[name]!]);
  }
  return Object.fromEntries(entries);
}

export function cloneMemory(memory: FranchiseMemory) {
  return { ...canonicalMemory(memory) };
}

const PAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateMemory(memory: FranchiseMemory): string | undefined {
  const names = Object.keys(memory);
  if (!z.string().safeParse(memory[NOTEBOOK_PAGE]).success)
    return `the "${NOTEBOOK_PAGE}" page must be a string`;
  if (names.length > MEMORY_LIMITS.pages)
    return `memory holds ${names.length} pages; the limit is ${MEMORY_LIMITS.pages}`;
  let total = 0;
  for (const name of names) {
    const textResult = z.string().safeParse(memory[name]);
    if (!textResult.success) return `page ${JSON.stringify(name)} must be a string`;
    const text = textResult.data;
    if (name.length > MEMORY_LIMITS.nameChars || !PAGE_NAME.test(name)) {
      return `page name ${JSON.stringify(name)} must be 1-${MEMORY_LIMITS.nameChars} lowercase letters, digits, ".", "_" or "-"`;
    }
    if (text.length > MEMORY_LIMITS.pageChars) {
      return `page ${JSON.stringify(name)} is ${text.length} characters; the limit is ${MEMORY_LIMITS.pageChars}`;
    }
    total += text.length;
  }
  if (total > MEMORY_LIMITS.totalChars) {
    const sizes = names.map((name) => `${name} ${z.string().parse(memory[name]).length}`).join(", ");
    return `memory totals ${total} characters across its pages; the limit is ${MEMORY_LIMITS.totalChars}, so remove at least ${total - MEMORY_LIMITS.totalChars} characters. Unchanged pages count too: ${sizes}`;
  }
  return undefined;
}

interface MemoryReply {
  memory: FranchiseMemory;
}

/** Carries the memory with every page that fit already applied, so a retry only has to resend the rest. */
export class MemoryRejection extends Error {
  constructor(
    message: string,
    readonly memory: FranchiseMemory,
  ) {
    super(message);
  }
}

interface PageWrite {
  name: string;
  label: string;
  text: string;
}

function label(name: string, notebookField: string): string {
  return name === NOTEBOOK_PAGE ? notebookField : `page ${JSON.stringify(name)}`;
}

/** Every field is optional and every omission keeps what exists: `notebook` replaces the notebook page,
 * `set_pages` writes the named pages and leaves the rest alone, and only `delete_pages` removes a page.
 * A page that breaks a size limit is the only thing not saved; the rejection names it and carries the
 * memory as saved so far. */
export function parseMemoryReply(
  record: JsonObject,
  current: FranchiseMemory,
  options: { notebookField?: string } = {},
): MemoryReply {
  const notebookField = options.notebookField ?? "notebook";
  if (record.pages !== undefined) {
    throw new Error(
      '"pages" is not a field; write pages with "set_pages" and remove them with "delete_pages"',
    );
  }
  const notebook = z.string().safeParse(record.notebook);
  if (record.notebook !== undefined && !notebook.success) {
    throw new Error(`"${notebookField}" must be a string holding the complete replacement text`);
  }
  const next = { ...current };
  const writes: PageWrite[] = [];
  if (notebook.success)
    writes.push({ name: NOTEBOOK_PAGE, label: notebookField, text: notebook.data.trim() });
  const deleted = new Set<string>();
  if (record.delete_pages !== undefined) {
    const deletePages = z.array(z.string()).safeParse(record.delete_pages);
    if (!deletePages.success) throw new Error('"delete_pages" must be an array of page names');
    for (const name of deletePages.data) {
      if (name === NOTEBOOK_PAGE)
        throw new Error(
          `the "${NOTEBOOK_PAGE}" page cannot be deleted; replace it with "${notebookField}"`,
        );
      deleted.add(name);
      delete next[name];
    }
  }
  if (record.set_pages !== undefined) {
    const setPages = z.object({}).passthrough().safeParse(record.set_pages);
    if (!setPages.success)
      throw new Error('"set_pages" must be an object mapping page names to their complete text');
    for (const [name, candidate] of Object.entries(setPages.data)) {
      if (name === NOTEBOOK_PAGE)
        throw new Error(
          `"set_pages" may not contain "${NOTEBOOK_PAGE}"; that page is the "${notebookField}" field`,
        );
      const text = z.string().safeParse(candidate);
      if (!text.success) throw new Error(`page ${JSON.stringify(name)} must be a string`);
      if (deleted.has(name))
        throw new Error(`page ${JSON.stringify(name)} is both set and deleted`);
      if (name.length > MEMORY_LIMITS.nameChars || !PAGE_NAME.test(name))
        throw new Error(
          `page name ${JSON.stringify(name)} must be 1-${MEMORY_LIMITS.nameChars} lowercase letters, digits, ".", "_" or "-"`,
        );
      writes.push({ name, label: label(name, notebookField), text: text.data.trim() });
    }
  }
  const rejected: string[] = [];
  const saved: string[] = [];
  const size = (name: string) => next[name]?.length ?? 0;
  let total = Object.values(next).reduce((sum, text) => sum + text.length, 0);
  const growth = (write: PageWrite) => write.text.length - size(write.name);
  const ordered = [
    ...writes.filter((write) => growth(write) <= 0),
    ...writes.filter((write) => growth(write) > 0),
  ];
  for (const write of ordered) {
    if (write.text.length > MEMORY_LIMITS.pageChars) {
      rejected.push(
        `${write.label} is ${write.text.length} characters; the limit is ${MEMORY_LIMITS.pageChars}, so cut at least ${write.text.length - MEMORY_LIMITS.pageChars}`,
      );
      continue;
    }
    if (!(write.name in next) && Object.keys(next).length >= MEMORY_LIMITS.pages) {
      rejected.push(
        `${write.label} would be page ${MEMORY_LIMITS.pages + 1}; the limit is ${MEMORY_LIMITS.pages}, so delete a page first`,
      );
      continue;
    }
    const after = total + growth(write);
    if (after > MEMORY_LIMITS.totalChars) {
      rejected.push(
        `${write.label} would take the memory to ${after} characters; the limit is ${MEMORY_LIMITS.totalChars}, so it needs to be at least ${after - MEMORY_LIMITS.totalChars} characters shorter`,
      );
      continue;
    }
    next[write.name] = write.text;
    total = after;
    saved.push(write.label);
  }
  const problem = validateMemory(next);
  if (problem) throw new Error(problem);
  const memory = canonicalMemory(next);
  if (rejected.length) {
    const sizes = Object.entries(memory)
      .map(([name, text]) => `${label(name, notebookField)} ${text.length}`)
      .join(", ");
    throw new MemoryRejection(
      [
        `Not saved: ${rejected.join("; ")}.`,
        `Saved: ${saved.length ? saved.join(", ") : "nothing new"}; every other page is kept. Resubmit only what was not saved.`,
        `Memory now: ${sizes} (${total} of ${MEMORY_LIMITS.totalChars} characters).`,
      ].join(" "),
      memory,
    );
  }
  return { memory };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export const MEMORY_TOOL_NOTICE =
  "read_memory_page returns one of your memory pages in full; the index below lists them.";

export function renderMemory(memory: FranchiseMemory, mode: "index" | "full" = "index"): string[] {
  const lines = ["YOUR NOTEBOOK:", memory[NOTEBOOK_PAGE] || "(empty)"];
  const pages = Object.keys(canonicalMemory(memory)).filter((name) => name !== NOTEBOOK_PAGE);
  if (!pages.length) return lines;
  if (mode === "full") {
    for (const name of pages)
      lines.push("", `YOUR MEMORY PAGE ${name}:`, memory[name] || "(empty)");
    return lines;
  }
  lines.push("", "YOUR MEMORY PAGES (name | characters | first line):");
  for (const name of pages)
    lines.push(`- ${name} | ${memory[name]!.length} | ${firstLine(memory[name]!)}`);
  return lines;
}

export const READ_MEMORY_PAGE: ToolDefinition = {
  name: "read_memory_page",
  description: "One of your own memory pages in full. Page names are listed in your prompt.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The page name." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export function readMemoryPage(memory: FranchiseMemory, args: JsonObject): string {
  const parsedName = z.string().safeParse(args.name);
  const name = parsedName.success ? parsedName.data.trim() : "";
  if (!Object.hasOwn(memory, name)) {
    const names = Object.keys(canonicalMemory(memory));
    return `You have no page named ${JSON.stringify(name)}. Your pages: ${names.join(", ")}.`;
  }
  return memory[name] || "(empty)";
}

export function memoryPageTool(memory: () => FranchiseMemory) {
  return {
    definition: READ_MEMORY_PAGE,
    run: (args: JsonObject) => readMemoryPage(memory(), args),
  };
}
