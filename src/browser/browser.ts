import { chromium, type Page, type BrowserContext } from 'playwright';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

let context: BrowserContext | null = null;
let activePage: Page | null = null;

export function getActivePage(): Page {
  if (!activePage) throw new Error('Browser not launched. Call launchBrowser() first.');
  return activePage;
}

export function setActivePage(page: Page): void {
  activePage = page;
}

export async function launchBrowser(): Promise<Page> {
  logger.info('Запуск браузера (Chromium)...');

  context = await chromium.launchPersistentContext(config.browserDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Handle new tabs/popups — auto-switch focus
  context.on('page', (newPage) => {
    logger.info(`Новая вкладка: ${newPage.url()}`);
    activePage = newPage;
    setupPageListeners(newPage);
  });

  // Get or create the first page
  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();
  setupPageListeners(activePage);

  logger.info('Браузер запущен.');
  return activePage;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
    activePage = null;
    logger.info('Браузер закрыт.');
  }
}

export async function takeScreenshot(): Promise<Buffer> {
  const page = getActivePage();
  return await page.screenshot({ type: 'png' });
}

// === Visual overlay: colored border + label ===

const OVERLAY_ID = '__agent_overlay__';

export async function showAgentOverlay(page: Page): Promise<void> {
  try {
    await page.evaluate((id) => {
      if (document.getElementById(id)) return;

      // Border frame
      const frame = document.createElement('div');
      frame.id = id;
      frame.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483647;
        pointer-events: none;
        border: 3px solid #00bcd4;
        box-shadow: inset 0 0 20px rgba(0,188,212,0.15);
        animation: agentPulse 2s ease-in-out infinite;
      `;

      // Label
      const label = document.createElement('div');
      label.style.cssText = `
        position: absolute; top: 8px; right: 8px;
        background: #00bcd4; color: #fff;
        padding: 4px 14px; border-radius: 4px;
        font: bold 13px/1 system-ui, sans-serif;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      `;
      label.textContent = 'АГЕНТ РАБОТАЕТ';
      frame.appendChild(label);

      // Pulse animation
      const style = document.createElement('style');
      style.textContent = `
        @keyframes agentPulse {
          0%, 100% { border-color: #00bcd4; }
          50% { border-color: #0097a7; }
        }
      `;
      frame.appendChild(style);
      document.body.appendChild(frame);
    }, OVERLAY_ID);
  } catch { /* page might not be ready */ }
}

export async function hideAgentOverlay(page: Page): Promise<void> {
  try {
    await page.evaluate((id) => {
      document.getElementById(id)?.remove();
    }, OVERLAY_ID);
  } catch { /* ignore */ }
}

function setupPageListeners(page: Page): void {
  // Auto-accept dialogs (alert, confirm, prompt)
  page.on('dialog', async (dialog) => {
    logger.info(`Диалог [${dialog.type()}]: "${dialog.message()}"`);
    await dialog.accept();
  });

  // Log navigation
  page.on('load', () => {
    logger.info(`Страница загружена: ${page.url()}`);
  });

  // Handle page close — switch to another open tab
  page.on('close', () => {
    if (activePage === page && context) {
      const pages = context.pages();
      activePage = pages.length > 0 ? pages[pages.length - 1] : null;
      if (activePage) {
        logger.info(`Вкладка закрыта. Переключение на: ${activePage.url()}`);
      }
    }
  });
}
