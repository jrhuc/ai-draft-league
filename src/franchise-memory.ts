import type { JsonObject, ToolDefinition } from './types.js';
import { isRecord } from './value.js';

export const NOTEBOOK_PAGE = 'notebook';

export const MEMORY_LIMITS = {
  pages: 16,
  nameChars: 48,
  pageChars: 8_000,
  totalChars: 48_000,
} as const;

export type FranchiseMemory = Record<string, string>;

export function emptyMemory(notebook = ''): FranchiseMemory {
  return { [NOTEBOOK_PAGE]: notebook };
}

export function canonicalMemory(memory: FranchiseMemory): FranchiseMemory {
  const ordered: FranchiseMemory = { [NOTEBOOK_PAGE]: memory[NOTEBOOK_PAGE] ?? '' };
  for (const name of Object.keys(memory).sort()) {
    if (name !== NOTEBOOK_PAGE) ordered[name] = memory[name]!;
  }
  return ordered;
}

export function cloneMemory(memory: FranchiseMemory): FranchiseMemory {
  return { ...canonicalMemory(memory) };
}

const PAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateMemory(memory: FranchiseMemory): string | undefined {
  const names = Object.keys(memory);
  if (typeof memory[NOTEBOOK_PAGE] !== 'string') return `the "${NOTEBOOK_PAGE}" page must be a string`;
  if (names.length > MEMORY_LIMITS.pages)
    return `memory holds ${names.length} pages; the limit is ${MEMORY_LIMITS.pages}`;
  let total = 0;
  for (const name of names) {
    const text = memory[name];
    if (typeof text !== 'string') return `page ${JSON.stringify(name)} must be a string`;
    if (name.length > MEMORY_LIMITS.nameChars || !PAGE_NAME.test(name)) {
      return `page name ${JSON.stringify(name)} must be 1-${MEMORY_LIMITS.nameChars} lowercase letters, digits, ".", "_" or "-"`;
    }
    if (text.length > MEMORY_LIMITS.pageChars) {
      return `page ${JSON.stringify(name)} is ${text.length} characters; the limit is ${MEMORY_LIMITS.pageChars}`;
    }
    total += text.length;
  }
  if (total > MEMORY_LIMITS.totalChars) {
    return `memory totals ${total} characters across its pages; the limit is ${MEMORY_LIMITS.totalChars}`;
  }
  return undefined;
}

export interface MemoryReply {
  memory: FranchiseMemory;
}

/** Every field is optional and every omission keeps what exists: `notebook` replaces the notebook page,
 * `set_pages` writes the named pages and leaves the rest alone, and only `delete_pages` removes a page. */
export function parseMemoryReply(record: Record<string, unknown>, current: FranchiseMemory): MemoryReply | string {
  if (record.pages !== undefined) {
    return '"pages" is not a field; write pages with "set_pages" and remove them with "delete_pages"';
  }
  if (record.notebook !== undefined && typeof record.notebook !== 'string') {
    return '"notebook" must be a string holding the complete replacement notebook';
  }
  const next: FranchiseMemory = { ...current };
  if (typeof record.notebook === 'string') next[NOTEBOOK_PAGE] = record.notebook.trim();
  const deleted = new Set<string>();
  if (record.delete_pages !== undefined) {
    if (!Array.isArray(record.delete_pages) || record.delete_pages.some((name) => typeof name !== 'string')) {
      return '"delete_pages" must be an array of page names';
    }
    for (const name of record.delete_pages as string[]) {
      if (name === NOTEBOOK_PAGE) return `the "${NOTEBOOK_PAGE}" page cannot be deleted; replace it with "notebook"`;
      deleted.add(name);
      delete next[name];
    }
  }
  if (record.set_pages !== undefined) {
    if (!isRecord(record.set_pages)) return '"set_pages" must be an object mapping page names to their complete text';
    for (const [name, text] of Object.entries(record.set_pages)) {
      if (name === NOTEBOOK_PAGE)
        return `"set_pages" may not contain "${NOTEBOOK_PAGE}"; that page is the "notebook" field`;
      if (typeof text !== 'string') return `page ${JSON.stringify(name)} must be a string`;
      if (deleted.has(name)) return `page ${JSON.stringify(name)} is both set and deleted`;
      next[name] = text.trim();
    }
  }
  const problem = validateMemory(next);
  if (problem) return problem;
  return { memory: canonicalMemory(next) };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export const MEMORY_TOOL_NOTICE =
  'read_memory_page returns one of your memory pages in full; the index below lists them.';

export function renderMemory(memory: FranchiseMemory, mode: 'index' | 'full' = 'index'): string[] {
  const lines = ['YOUR NOTEBOOK:', memory[NOTEBOOK_PAGE] || '(empty)'];
  const pages = Object.keys(canonicalMemory(memory)).filter((name) => name !== NOTEBOOK_PAGE);
  if (!pages.length) return lines;
  if (mode === 'full') {
    for (const name of pages) lines.push('', `YOUR MEMORY PAGE ${name}:`, memory[name] || '(empty)');
    return lines;
  }
  lines.push('', 'YOUR MEMORY PAGES (name | characters | first line):');
  for (const name of pages) lines.push(`- ${name} | ${memory[name]!.length} | ${firstLine(memory[name]!)}`);
  return lines;
}

export const READ_MEMORY_PAGE: ToolDefinition = {
  name: 'read_memory_page',
  description: 'One of your own memory pages in full. Page names are listed in your prompt.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The page name.' } },
    required: ['name'],
    additionalProperties: false,
  },
};

export function readMemoryPage(memory: FranchiseMemory, args: JsonObject): string {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!Object.hasOwn(memory, name)) {
    const names = Object.keys(canonicalMemory(memory));
    return `You have no page named ${JSON.stringify(name)}. Your pages: ${names.join(', ')}.`;
  }
  return memory[name] || '(empty)';
}

export function memoryPageTool(memory: () => FranchiseMemory): {
  definition: ToolDefinition;
  run: (args: JsonObject) => string;
} {
  return { definition: READ_MEMORY_PAGE, run: (args) => readMemoryPage(memory(), args) };
}
