import type { Page } from 'playwright';

export interface ElementRef {
  ref: number;
  role: string;
  name: string;
  value?: string;
  nth: number;       // 0-based index among elements with same role+name
  totalSame: number; // total count of elements with same role+name
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
  // Standard form/navigation elements
  'link', 'button', 'textbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menu',
  'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
  'menuitemcheckbox', 'menuitemradio', 'treeitem',
  // List/table items (email lists, search results, etc.)
  'listitem', 'row', 'gridcell', 'article',
]);

const MAX_ELEMENTS = 120;
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
    // First pass: collect interactive elements + count duplicates
    const rawElements: { role: string; name: string; value?: string }[] = [];
    const dupCount: Map<string, number> = new Map();

    const lines = ariaYaml.split('\n');
    for (const line of lines) {
      const parsed = parseAriaLine(line);
      if (!parsed) continue;

      if (INTERACTIVE_ROLES.has(parsed.role)) {
        if (rawElements.length < MAX_ELEMENTS) {
          rawElements.push(parsed);
          const key = `${parsed.role}|||${parsed.name}`;
          dupCount.set(key, (dupCount.get(key) || 0) + 1);
        }
      } else if (parsed.name && parsed.role !== '') {
        textParts.push(parsed.name);
      }
    }

    // Second pass: assign nth indices
    const nthTracker: Map<string, number> = new Map();
    for (const raw of rawElements) {
      const key = `${raw.role}|||${raw.name}`;
      const nth = nthTracker.get(key) || 0;
      nthTracker.set(key, nth + 1);

      const el: ElementRef = {
        ref: refCounter,
        role: raw.role,
        name: raw.name,
        nth,
        totalSame: dupCount.get(key) || 1,
      };
      if (raw.value) el.value = raw.value;

      elements.push(el);
      currentRefMap.set(refCounter, el);
      refCounter++;
    }
  }

  // Fallback: if ARIA snapshot found very few interactive elements,
  // scan the DOM for clickable elements that might have been missed
  if (elements.length < 10) {
    try {
      const clickableItems = await page.evaluate(() => {
        const items: { tag: string; text: string; role: string }[] = [];
        // Find elements with click handlers or cursor:pointer that are not already ARIA-detected
        const candidates = document.querySelectorAll(
          '[onclick], [role="listitem"], [role="row"], [role="article"], ' +
          'a[href], [data-click-action], [tabindex="0"]'
        );
        for (const el of candidates) {
          if (items.length >= 30) break;
          const text = (el.textContent || '').trim().slice(0, 100);
          if (!text || text.length < 3) continue;
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          items.push({ tag: el.tagName.toLowerCase(), text, role });
        }
        return items;
      });

      for (const item of clickableItems) {
        if (refCounter > MAX_ELEMENTS) break;
        // Skip if we already have this element from ARIA
        const alreadyExists = elements.some(e => e.name === item.text);
        if (alreadyExists) continue;

        const role = item.role || 'button';
        const el: ElementRef = {
          ref: refCounter,
          role,
          name: item.text,
          nth: 0,
          totalSame: 1,
        };
        elements.push(el);
        currentRefMap.set(refCounter, el);
        refCounter++;
      }
    } catch { /* page might not be ready */ }
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
