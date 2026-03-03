import { getActivePage, takeScreenshot, hideAgentOverlay, showAgentOverlay } from './browser.js';
import { getRefMap, type ElementRef } from './extraction.js';
import { logger } from '../utils/logger.js';


export interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
  suggestion?: string;
  screenshot?: Buffer; // attached on error or screenshot tool
}

export async function executeAction(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'navigate':      return await doNavigate(args);
      case 'click':         return await doClick(args);
      case 'type_text':     return await doTypeText(args);
      case 'select_option': return await doSelectOption(args);
      case 'scroll':        return await doScroll(args);
      case 'go_back':       return await doGoBack();
      case 'screenshot':    return await doScreenshot();
      case 'wait':          return await doWait(args);
      case 'press_key':     return await doPressKey(args);
      case 'wait_for_user': return await doWaitForUser(args);
      case 'done':          return doDone(args);
      default:
        return { success: false, error: `Unknown tool: ${toolName}`, suggestion: 'Use one of: navigate, click, type_text, select_option, scroll, go_back, screenshot, press_key, wait, wait_for_user, done.' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Tool "${toolName}" failed: ${message}`);

    // Auto-screenshot on error for visual debugging
    let screenshot: Buffer | undefined;
    try { screenshot = await takeScreenshot(); } catch { /* ignore */ }

    return {
      success: false,
      error: message,
      suggestion: 'An unexpected error occurred. Try a different approach or use screenshot to see the current page state.',
      screenshot,
    };
  }
}

// === Tool Implementations ===

async function doNavigate(args: Record<string, unknown>): Promise<ToolResult> {
  let url = args.url as string;
  if (!url) return { success: false, error: 'Missing "url" parameter.', suggestion: 'Provide a full URL like https://google.com' };

  // Auto-prepend https:// if no protocol specified
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  const page = getActivePage();
  logger.action('navigate', url);

  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  // Wait for network to settle (helps with SPAs), but don't block on long-polling
  try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* proceed */ }

  return { success: true, data: `Navigated to ${page.url()}` };
}

async function doClick(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number from the interactive elements list.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('click', `[${ref}] ${element.role} "${element.name}"`);

  const locator = buildLocator(page, element);
  const urlBefore = page.url();

  let clicked = false;

  try {
    // Normal click with actionability checks
    await locator.click({ timeout: 5000 });
    clicked = true;
  } catch {
    // Fallback 1: force click (bypasses pointer event interception)
    try {
      logger.info('Normal click blocked — trying force click...');
      await locator.click({ timeout: 3000, force: true });
      clicked = true;
    } catch {
      // Fallback 2: JavaScript click (bypasses all Playwright checks)
      logger.info('Force click failed — trying JS click...');
      clicked = await page.evaluate((r) => {
        const el = document.querySelector(`[data-agent-ref="${r}"]`);
        if (el) { (el as HTMLElement).click(); return true; }
        return false;
      }, ref);
    }
  }

  // Wait for page to settle: if click caused navigation, wait for load; otherwise short delay
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    try { await page.waitForLoadState('load', { timeout: 5000 }); } catch { /* proceed */ }
  } else {
    await page.waitForTimeout(300);
  }

  if (!clicked) {
    let screenshot: Buffer | undefined;
    try { screenshot = await takeScreenshot(); } catch { /* ignore */ }
    return {
      success: false,
      error: `All click attempts failed for [${ref}] ${element.role} "${element.name}". The element may be hidden, overlapped, or removed from the DOM.`,
      suggestion: 'Take a screenshot to see the page state. Try scrolling to the element, dismissing popups with press_key("Escape"), or using a different element.',
      screenshot,
    };
  }

  return { success: true, data: `Clicked [${ref}] ${element.role} "${element.name}"` };
}

async function doTypeText(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  const text = args.text as string;
  const pressEnter = args.press_enter as boolean ?? false;

  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number of the text input.' };
  if (!text) return { success: false, error: 'Missing "text" parameter.', suggestion: 'Provide the text to type.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('type_text', `[${ref}] "${text}"${pressEnter ? ' + Enter' : ''}`);

  const locator = buildLocator(page, element);
  await locator.click({ timeout: 5000 });
  await locator.fill(text);

  if (pressEnter) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  }

  return { success: true, data: `Typed "${text}" into [${ref}] ${element.role} "${element.name}"${pressEnter ? ' and pressed Enter' : ''}` };
}

async function doSelectOption(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  const option = args.option as string;

  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number of the select element.' };
  if (!option) return { success: false, error: 'Missing "option" parameter.', suggestion: 'Provide the visible text of the option to select.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('select_option', `[${ref}] option="${option}"`);

  const locator = buildLocator(page, element);
  await locator.selectOption({ label: option }, { timeout: 5000 });

  return { success: true, data: `Selected "${option}" in [${ref}] ${element.role} "${element.name}"` };
}

async function doScroll(args: Record<string, unknown>): Promise<ToolResult> {
  const direction = args.direction as string;
  if (!direction || !['up', 'down'].includes(direction)) {
    return { success: false, error: 'Invalid direction.', suggestion: 'Use "up" or "down".' };
  }

  const page = getActivePage();
  const delta = direction === 'down' ? 600 : -600;
  logger.action('scroll', direction);

  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(500);

  return { success: true, data: `Scrolled ${direction}` };
}

async function doGoBack(): Promise<ToolResult> {
  const page = getActivePage();
  logger.action('go_back', '');

  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(800);

  return { success: true, data: `Navigated back to ${page.url()}` };
}

async function doScreenshot(): Promise<ToolResult> {
  logger.action('screenshot', '');
  const screenshot = await takeScreenshot();

  return {
    success: true,
    data: 'Screenshot taken. See the attached image.',
    screenshot,
  };
}

async function doWait(args: Record<string, unknown>): Promise<ToolResult> {
  let seconds = args.seconds as number;
  if (!seconds || seconds < 1) seconds = 1;
  if (seconds > 10) seconds = 10;

  logger.action('wait', `${seconds}s`);

  const page = getActivePage();
  await page.waitForTimeout(seconds * 1000);

  return { success: true, data: `Waited ${seconds} seconds` };
}

async function doPressKey(args: Record<string, unknown>): Promise<ToolResult> {
  const key = args.key as string;
  if (!key) return { success: false, error: 'Missing "key" parameter.', suggestion: 'Provide a key like "Escape", "Tab", "Enter", "ArrowDown", or "Control+a".' };

  const page = getActivePage();
  logger.action('press_key', key);

  await page.keyboard.press(key);
  await page.waitForTimeout(500);

  return { success: true, data: `Pressed key: ${key}` };
}

async function doWaitForUser(args: Record<string, unknown>): Promise<ToolResult> {
  const reason = args.reason as string || 'Выполните действие в браузере.';

  const page = getActivePage();

  // Hide overlay — user takes control
  await hideAgentOverlay(page);
  logger.statusWaitingUser(reason);

  // Wait for Enter in terminal (use raw stdin listener to avoid conflicting with main readline)
  await new Promise<void>((resolve) => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      resolve();
    };
    process.stdin.on('data', onData);
  });

  // Restore overlay — agent takes control
  await showAgentOverlay(page);
  logger.statusWorking();

  return { success: true, data: `User completed action: ${reason}. Resuming.` };
}

function doDone(args: Record<string, unknown>): ToolResult {
  const result = args.result as string || 'Task completed.';
  logger.result(`Задача завершена: ${result}`);

  return { success: true, data: result };
}

// === Helpers ===

function resolveRef(ref: number): ElementRef | undefined {
  return getRefMap().get(ref);
}

function refNotFoundResult(ref: number): ToolResult {
  return {
    success: false,
    error: `Element ref=${ref} not found. The page may have changed since the last snapshot.`,
    suggestion: 'Review the updated element list in the current page state and retry with the correct ref number.',
  };
}

function buildLocator(page: ReturnType<typeof getActivePage>, element: ElementRef) {
  // Use data-agent-ref attribute set during DOM extraction — unique per element
  return page.locator(`[data-agent-ref="${element.ref}"]`);
}
