import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface ElementRef {
  ref: number;
  role: string;   // link, button, textbox, checkbox, etc.
  name: string;   // visible text / description
  tag: string;    // original HTML tag (a, button, input, etc.)
  value?: string; // current value for inputs/selects/checkboxes
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

const MAX_ELEMENTS = 150;
const MAX_TEXT_LENGTH = 4000;

// === DOM extraction script (injected into browser via page.evaluate) ===

interface DomExtractionResult {
  elements: RawElement[];
  pageText: string;
  error: string;
}

async function runDomExtraction(page: Page): Promise<DomExtractionResult> {
  return page.evaluate((maxEl: number) => {
    try {
      // --- Clean up previous refs ---
      document.querySelectorAll('[data-agent-ref]').forEach(function(el) {
        el.removeAttribute('data-agent-ref');
      });

      // --- Interactive element detection ---
      var INTERACTIVE_TAGS = ['a', 'button', 'input', 'select', 'textarea', 'summary'];
      var INTERACTIVE_ROLES = [
        'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
        'listbox', 'option', 'menuitem', 'menu', 'tab', 'switch',
        'slider', 'spinbutton', 'searchbox', 'treeitem',
        'menuitemcheckbox', 'menuitemradio',
      ];

      // --- Phase 1: Find interactive elements ---
      var elements: any[] = [];
      var refCounter = 1;

      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if (refCounter > maxEl) break;
        var el = allEls[i];
        var tag = el.tagName.toLowerCase();

        // === isInteractive ===
        var interactive = false;
        if (INTERACTIVE_TAGS.indexOf(tag) !== -1) {
          if (tag === 'a' && !el.hasAttribute('href')) { /* skip */ }
          else if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') { /* skip */ }
          else interactive = true;
        }
        if (!interactive) {
          var role = el.getAttribute('role');
          if (role && INTERACTIVE_ROLES.indexOf(role) !== -1) interactive = true;
          if (el.hasAttribute('onclick')) interactive = true;
          if (el.getAttribute('tabindex') === '0') interactive = true;
          if (el.getAttribute('contenteditable') === 'true') interactive = true;
        }
        if (!interactive) continue;

        // === isVisible ===
        var visible = true;
        try {
          var rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) visible = false;
          if (rect.bottom < -500 || rect.top > window.innerHeight + 2000) visible = false;
          if (visible) {
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') visible = false;
            if (style.opacity === '0') visible = false;
          }
        } catch (e) {
          visible = false;
        }
        if (!visible) continue;

        // === getElementText ===
        var name = '';
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) {
          name = ariaLabel.trim();
        } else {
          var titleAttr = el.getAttribute('title');
          if (titleAttr && titleAttr.trim()) {
            name = titleAttr.trim();
          } else if (tag === 'input' || tag === 'textarea') {
            name = (el as HTMLInputElement).placeholder || '';
          } else if (tag === 'img') {
            name = (el as HTMLImageElement).alt || '';
          } else if (tag === 'select') {
            var selEl = el as HTMLSelectElement;
            var selOpt = selEl.options && selEl.options[selEl.selectedIndex];
            name = selOpt ? selOpt.text : '';
          } else {
            name = (el.textContent || '').replace(/\s+/g, ' ').trim();
            // If element has no text (e.g. overlay <a> in Yandex Mail), get text from parent
            if (!name && el.parentElement) {
              // Try parent's title children first (more specific)
              var parentTitle = el.parentElement.querySelector('[title]');
              if (parentTitle) {
                name = (parentTitle.getAttribute('title') || '').trim();
              }
              // Fallback: parent's full text content
              if (!name) {
                name = (el.parentElement.textContent || '').replace(/\s+/g, ' ').trim();
              }
            }
            if (!name) {
              var ct = el.querySelector('[title]');
              if (ct) name = (ct.getAttribute('title') || '').trim();
              if (!name) {
                var imgEl = el.querySelector('img[alt]');
                if (imgEl) name = (imgEl.getAttribute('alt') || '').trim();
              }
            }
          }
        }
        name = name.slice(0, 150);

        // === getElementRole ===
        var elRole = el.getAttribute('role');
        if (!elRole || INTERACTIVE_ROLES.indexOf(elRole) === -1) {
          if (tag === 'a') elRole = 'link';
          else if (tag === 'button') elRole = 'button';
          else if (tag === 'input') {
            var inputType = (el as HTMLInputElement).type;
            if (inputType === 'checkbox') elRole = 'checkbox';
            else if (inputType === 'radio') elRole = 'radio';
            else if (inputType === 'submit' || inputType === 'button') elRole = 'button';
            else elRole = 'textbox';
          }
          else if (tag === 'select') elRole = 'combobox';
          else if (tag === 'textarea') elRole = 'textbox';
          else if (tag === 'summary') elRole = 'button';
          else elRole = elRole || tag;
        }

        // === getElementValue ===
        var value: string | null = null;
        if (tag === 'input') {
          var inp = el as HTMLInputElement;
          if (inp.type === 'checkbox' || inp.type === 'radio') {
            value = inp.checked ? 'checked' : 'unchecked';
          } else {
            value = inp.value || null;
          }
        } else if (tag === 'textarea') {
          value = (el as HTMLTextAreaElement).value || null;
        } else if (tag === 'select') {
          var sEl = el as HTMLSelectElement;
          var sOpt = sEl.options && sEl.options[sEl.selectedIndex];
          value = sOpt ? sOpt.text : null;
        } else {
          var ac = el.getAttribute('aria-checked');
          if (ac) value = ac === 'true' ? 'checked' : 'unchecked';
        }

        // Mark element for clicking
        el.setAttribute('data-agent-ref', String(refCounter));

        var entry: any = { ref: refCounter, role: elRole, name: name, tag: tag };
        if (value !== null) entry.value = value;
        elements.push(entry);
        refCounter++;
      }

      // --- Phase 2: Extract page text for context ---
      var textParts: string[] = [];

      // Try to find main content area (email body, article, etc.)
      var mainContent = document.querySelector('main, article, [role="main"], .mail-Message-Body, .message-body, #readmsg, .article-body, .post-content');
      var contentRoot = mainContent || document.body;

      // Extract headings
      var headings = contentRoot.querySelectorAll('h1, h2, h3, h4');
      for (var j = 0; j < headings.length; j++) {
        var hText = (headings[j].textContent || '').replace(/\s+/g, ' ').trim();
        if (hText && hText.length > 1) {
          textParts.push('[' + headings[j].tagName + '] ' + hText);
        }
      }

      // Extract structured text blocks (paragraphs, list items, table cells)
      var contentBlocks = contentRoot.querySelectorAll('p, li, td, th, blockquote, pre, dd, dt, figcaption');
      var seenTexts = new Set<string>();

      for (var cb = 0; cb < contentBlocks.length && textParts.length < 80; cb++) {
        var blockText = (contentBlocks[cb].textContent || '').replace(/\s+/g, ' ').trim();
        if (blockText && blockText.length > 10 && !seenTexts.has(blockText.slice(0, 50))) {
          seenTexts.add(blockText.slice(0, 50));
          textParts.push(blockText.slice(0, 500));
        }
      }

      // If no structured content found, fall back to full text
      if (textParts.length < 3) {
        var bodyText = (contentRoot.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3500);
        if (bodyText) {
          textParts.push(bodyText);
        }
      }

      return { elements: elements, pageText: textParts.join('\n'), error: '' };
    } catch (err: any) {
      return { elements: [], pageText: '', error: String(err) };
    }
  }, MAX_ELEMENTS);
}

// === Main extraction function ===

export async function extractPageState(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title();

  let rawElements: RawElement[] = [];
  let pageText = '';
  let extractionError = '';

  try {
    const result = await runDomExtraction(page);
    rawElements = result.elements;
    pageText = result.pageText;
    extractionError = result.error;
  } catch (err) {
    extractionError = err instanceof Error ? err.message : String(err);
  }

  // If extraction failed, retry once after a delay
  if (extractionError) {
    logger.error(`DOM extraction error: ${extractionError}`);
    logger.info('Retrying extraction after 1.5s...');
    await page.waitForTimeout(1500);
    try {
      const retryResult = await runDomExtraction(page);
      rawElements = retryResult.elements;
      pageText = retryResult.pageText;
      if (!retryResult.error) {
        extractionError = '';
        logger.info(`Extraction retry succeeded (${rawElements.length} elements)`);
      }
    } catch { /* second failure — proceed with empty results */ }
  }

  // Build ref map
  currentRefMap = new Map();
  const elements: ElementRef[] = [];

  for (const raw of rawElements) {
    const el: ElementRef = {
      ref: raw.ref,
      role: raw.role,
      name: raw.name,
      tag: raw.tag,
    };
    if (raw.value !== undefined) el.value = raw.value;

    elements.push(el);
    currentRefMap.set(el.ref, el);
  }

  logger.info(`Найдено ${elements.length} интерактивных элементов`);

  if (pageText.length > MAX_TEXT_LENGTH) {
    pageText = pageText.slice(0, MAX_TEXT_LENGTH) + '\n... (text truncated)';
  }

  const formatted = formatSnapshot(url, title, elements, pageText, extractionError);
  return { url, title, elements, text: pageText, formatted };
}

// === Types ===

interface RawElement {
  ref: number;
  role: string;
  name: string;
  tag: string;
  value?: string;
}

// === Formatting ===

function formatSnapshot(
  url: string,
  title: string,
  elements: ElementRef[],
  text: string,
  extractionError?: string,
): string {
  const lines: string[] = [];

  lines.push(`Page: ${url}`);
  lines.push(`Title: ${title}`);
  lines.push('');

  if (extractionError) {
    lines.push(`ERROR: Page extraction failed (${extractionError}). Try navigate() to reload or wait(3) for the page to load.`);
    lines.push('');
  }

  if (elements.length > 0) {
    lines.push('Interactive elements:');
    for (const el of elements) {
      let line = `  [${el.ref}] ${el.role} "${el.name}"`;
      if (el.value) line += ` [value="${el.value}"]`;
      lines.push(line);
    }
    if (elements.length >= MAX_ELEMENTS) {
      lines.push(`  ... (truncated at ${MAX_ELEMENTS} elements. Use scroll("down") to see more.)`);
    }
  } else if (!extractionError) {
    lines.push('No interactive elements found. The page may still be loading — try wait(2) then retry.');
  }

  if (text.trim()) {
    lines.push('');
    lines.push('Page text:');
    lines.push(text);
  }

  return lines.join('\n');
}
