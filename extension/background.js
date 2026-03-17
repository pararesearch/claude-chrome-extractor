/**
 * Background service worker — maintains WebSocket connection to local server
 * and handles extraction requests.
 */

const SERVER_URL = 'ws://localhost:3456/ws';
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let connected = false;

// --- WebSocket connection ---

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log('[Extractor] Connecting to server...');
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    connected = true;
    console.log('[Extractor] Connected to server');
    updateBadge('ON', '#22c55e');
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleMessage(msg);
    } catch (err) {
      console.error('[Extractor] Error handling message:', err);
    }
  };

  ws.onclose = () => {
    connected = false;
    console.log('[Extractor] Disconnected. Reconnecting...');
    updateBadge('OFF', '#ef4444');
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = (err) => {
    console.error('[Extractor] WebSocket error:', err.message || err);
    ws.close();
  };
}

// --- Message handlers ---

async function handleMessage(msg) {
  if (msg.type === 'extract') {
    await handleExtract(msg);
  } else if (msg.type === 'list-tabs') {
    await handleListTabs(msg);
  }
}

async function handleExtract(msg) {
  const { requestId, query, url, selector } = msg;

  try {
    let tabId;

    if (url) {
      // Navigate to URL in active tab or create new tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url });
        tabId = activeTab.id;
        // Wait for page to load
        await waitForTabLoad(tabId);
        // Extra wait for dynamic content
        await sleep(2000);
      } else {
        const newTab = await chrome.tabs.create({ url });
        tabId = newTab.id;
        await waitForTabLoad(tabId);
        await sleep(2000);
      }
    } else {
      // Use active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) {
        return sendError(requestId, 'No active tab found');
      }
      tabId = activeTab.id;
    }

    // Inject content script to extract page data
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
      args: [selector],
    });

    const pageData = results?.[0]?.result;
    if (!pageData) {
      return sendError(requestId, 'Failed to extract page content');
    }

    const tab = await chrome.tabs.get(tabId);

    send({
      type: 'page-content',
      requestId,
      url: tab.url,
      title: tab.title,
      content: pageData.content,
      html: pageData.html,
    });

    console.log(`[Extractor] Sent page content for "${query?.slice(0, 50)}..." (${pageData.content.length} chars)`);
  } catch (err) {
    console.error('[Extractor] Extract error:', err);
    sendError(requestId, err.message);
  }
}

async function handleListTabs(msg) {
  const { requestId } = msg;
  try {
    const tabs = await chrome.tabs.query({});
    send({
      type: 'page-content', // reuse the handler
      requestId,
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    });
  } catch (err) {
    sendError(requestId, err.message);
  }
}

// --- Content extraction function (injected into page) ---

function extractPageContent(selector) {
  let target = document;
  if (selector) {
    const el = document.querySelector(selector);
    if (el) target = el;
  }

  // Get visible text content (skip scripts, styles, hidden elements)
  const walker = document.createTreeWalker(
    target === document ? document.body : target,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.textContent.trim() === '') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const texts = [];
  let node;
  while ((node = walker.nextNode())) {
    texts.push(node.textContent.trim());
  }

  // Also extract table data as structured text
  const tables = (target === document ? document.body : target).querySelectorAll('table');
  let tableText = '';
  tables.forEach((table, i) => {
    tableText += `\n[Table ${i + 1}]\n`;
    table.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td, th')).map((c) => c.textContent.trim());
      tableText += cells.join(' | ') + '\n';
    });
  });

  // Get links
  const links = Array.from((target === document ? document.body : target).querySelectorAll('a[href]'))
    .slice(0, 100)
    .map((a) => `${a.textContent.trim()} → ${a.href}`)
    .filter((l) => l.length > 5);

  const content = [
    texts.join('\n'),
    tableText ? `\n--- Tables ---${tableText}` : '',
    links.length > 0 ? `\n--- Links ---\n${links.join('\n')}` : '',
  ].join('\n');

  // Get outer HTML for selector targets (capped)
  const html = selector
    ? (document.querySelector(selector)?.outerHTML || '').slice(0, 50_000)
    : '';

  return { content, html };
}

// --- Helpers ---

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendError(requestId, error) {
  send({ type: 'error', requestId, error });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 15s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// --- Start ---
connect();

// Keep alive (MV3 service workers get killed after 30s of inactivity)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connect();
  }
}, 20_000);
