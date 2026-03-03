import type { Page } from 'playwright';

export interface ElementRef {
  ref: number;
  role: string;
  name: string;
  value?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementRef[];
  text: string;
  formatted: string;
}

// Map from ref number to element info — used by actions.ts to resolve clicks
let currentRefMap: Map<number, ElementRef> = new Map();

export function getRefMap(): Map<number, ElementRef> {
  return currentRefMap;
}

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menu',
  'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
  'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

const MAX_ELEMENTS = 80;
const MAX_TEXT_LENGTH = 3000;

export async function extractPageState(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title();

  // Get ARIA snapshot using modern Playwright API (returns YAML string)
  let ariaYaml = '';
  try {
    ariaYaml = await page.locator('body').ariaSnapshot({ timeout: 5000 });
  } catch {
    // Fallback: page may not have a body yet
    ariaYaml = '';
  }

  // Parse YAML into elements
  const elements: ElementRef[] = [];
  currentRefMap = new Map();
  let refCounter = 1;

  const textParts: string[] = [];

  if (ariaYaml) {
    const lines = ariaYaml.split('\n');
    for (const line of lines) {
      if (refCounter > MAX_ELEMENTS) break;

      const parsed = parseAriaLine(line);
      if (!parsed) continue;

      if (INTERACTIVE_ROLES.has(parsed.role)) {
        const el: ElementRef = {
          ref: refCounter,
          role: parsed.role,
          name: parsed.name,
        };
        if (parsed.value) el.value = parsed.value;

        elements.push(el);
        currentRefMap.set(refCounter, el);
        refCounter++;
      } else if (parsed.name && parsed.role !== '') {
        // Non-interactive content — collect as page text
        textParts.push(parsed.name);
      }
    }
  }

  let text = textParts.join('\n');
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH) + '\n... (text truncated)';
  }

  const formatted = formatSnapshot(url, title, elements, text);
  return { url, title, elements, text, formatted };
}

// Parse a single ARIA YAML line like:
//   "- link \"Google\"" or "  - textbox \"Search\" [value=\"hello\"]"
function parseAriaLine(line: string): { role: string; name: string; value?: string } | null {
  // Match pattern: optional indent + "- role" + optional quoted name + optional attributes
  const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+\[(.+)\])?/);
  if (!match) return null;

  const role = match[1].toLowerCase();
  const name = match[2] || '';
  const attrs = match[3] || '';

  let value: string | undefined;
  if (attrs) {
    const valueMatch = attrs.match(/value="([^"]*)"/);
    if (valueMatch) value = valueMatch[1];
  }

  return { role, name, value };
}

function formatSnapshot(
  url: string,
  title: string,
  elements: ElementRef[],
  text: string,
): string {
  const lines: string[] = [];

  lines.push(`Page: ${url}`);
  lines.push(`Title: ${title}`);
  lines.push('');

  if (elements.length > 0) {
    lines.push('Interactive elements:');
    for (const el of elements) {
      let line = `  [${el.ref}] ${el.role} "${el.name}"`;
      if (el.value) line += ` value="${el.value}"`;
      lines.push(line);
    }
    if (elements.length >= MAX_ELEMENTS) {
      lines.push(`  ... (truncated at ${MAX_ELEMENTS} elements. Use scroll("down") to see more.)`);
    }
  } else {
    lines.push('No interactive elements found. The page may still be loading — try wait(2) then retry.');
  }

  if (text.trim()) {
    lines.push('');
    lines.push('Page text:');
    lines.push(text);
  }

  return lines.join('\n');
}
