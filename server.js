/**
 * Local server that bridges HTTP requests (via ngrok) to the Chrome extension.
 *
 * Flow:
 *   External request → ngrok → POST /extract → WebSocket → Chrome extension
 *   Chrome extension grabs page content → sends to Claude API → result back via WS
 *   Server returns the result as HTTP response.
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — Claude API key
 *   PORT               — server port (default 3456)
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const PORT = process.env.PORT || 3456;
const app = express();
app.use(express.json({ limit: '5mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Claude client ---
const anthropic = new Anthropic();

// --- Connected Chrome extension ---
let extensionSocket = null;
const pendingRequests = new Map(); // requestId → { resolve, reject, timer }

wss.on('connection', (ws) => {
  console.log('[WS] Chrome extension connected');
  extensionSocket = ws;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'page-content') {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pending.resolve(msg);
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
        }
      }

      if (msg.type === 'error') {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pending.reject(new Error(msg.error));
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
        }
      }
    } catch (err) {
      console.error('[WS] Bad message:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Chrome extension disconnected');
    if (extensionSocket === ws) extensionSocket = null;
  });
});

// --- Request page content from extension ---
function requestPageContent(query, options = {}) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      return reject(new Error('Chrome extension not connected'));
    }

    const requestId = crypto.randomUUID();
    const timeoutMs = options.timeoutMs || 30_000;

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Timed out waiting for Chrome extension response'));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    extensionSocket.send(JSON.stringify({
      type: 'extract',
      requestId,
      query,
      url: options.url || null, // optional: navigate to URL first
      selector: options.selector || null, // optional: target specific element
    }));
  });
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    extensionConnected: extensionSocket?.readyState === 1,
    pendingRequests: pendingRequests.size,
  });
});

// --- Main extraction endpoint ---
app.post('/extract', async (req, res) => {
  const { query, url, selector, model, maxTokens } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    // 1. Ask extension to grab page content
    console.log(`[Extract] Query: "${query.slice(0, 80)}..." | URL: ${url || '(current page)'}`);
    const pageData = await requestPageContent(query, { url, selector });

    // 2. Send page content + query to Claude
    const systemPrompt = `You are a data extraction assistant. The user will provide HTML/text content from a web page and a query. Extract the requested data accurately and return it in a clean, structured format (JSON when appropriate). Only return the extracted data — no explanations unless asked.`;

    const userPrompt = [
      `Page URL: ${pageData.url}`,
      `Page Title: ${pageData.title}`,
      '',
      '--- Page Content ---',
      pageData.content?.slice(0, 100_000) || '(empty)',
      '',
      '--- Query ---',
      query,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: maxTokens || 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const result = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    console.log(`[Extract] Done. Result: ${result.slice(0, 120)}...`);

    res.json({
      ok: true,
      result,
      metadata: {
        url: pageData.url,
        title: pageData.title,
        contentLength: pageData.content?.length || 0,
        model: response.model,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
    });
  } catch (err) {
    console.error('[Extract] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Navigate + extract (convenience) ---
app.post('/navigate-and-extract', async (req, res) => {
  const { url, query, selector, waitMs, model, maxTokens } = req.body;

  if (!url || !query) {
    return res.status(400).json({ error: 'url and query are required' });
  }

  try {
    console.log(`[Navigate] URL: ${url} | Query: "${query.slice(0, 80)}..."`);

    // Tell extension to navigate first, then extract
    const pageData = await requestPageContent(query, {
      url,
      selector,
      timeoutMs: (waitMs || 5000) + 30_000,
    });

    const systemPrompt = `You are a data extraction assistant. The user will provide HTML/text content from a web page and a query. Extract the requested data accurately and return it in a clean, structured format (JSON when appropriate). Only return the extracted data — no explanations unless asked.`;

    const userPrompt = [
      `Page URL: ${pageData.url}`,
      `Page Title: ${pageData.title}`,
      '',
      '--- Page Content ---',
      pageData.content?.slice(0, 100_000) || '(empty)',
      '',
      '--- Query ---',
      query,
    ].join('\n');

    const response = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: maxTokens || 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const result = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    res.json({
      ok: true,
      result,
      metadata: {
        url: pageData.url,
        title: pageData.title,
        contentLength: pageData.content?.length || 0,
        model: response.model,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
    });
  } catch (err) {
    console.error('[Navigate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- List open tabs (utility) ---
app.get('/tabs', (req, res) => {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return res.status(503).json({ error: 'Chrome extension not connected' });
  }

  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => {
    pendingRequests.delete(requestId);
    res.status(504).json({ error: 'Timed out' });
  }, 10_000);

  pendingRequests.set(requestId, {
    resolve: (msg) => res.json({ ok: true, tabs: msg.tabs }),
    reject: (err) => res.status(500).json({ error: err.message }),
    timer,
  });

  extensionSocket.send(JSON.stringify({ type: 'list-tabs', requestId }));
});

// --- Agent search: "find Akhil at Vyapar" → Google → LinkedIn → extract ---
app.post('/search', async (req, res) => {
  const { query, maxPages, model } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  const limit = Math.min(maxPages || 3, 5);

  try {
    console.log(`[Search] Agent query: "${query}"`);

    // Step 1: Ask Claude to generate search queries
    const planResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `You generate Google search queries to find information about people or companies. Return JSON only.`,
      messages: [{
        role: 'user',
        content: `Generate 1-2 Google search queries to find: "${query}"\n\nPrefer LinkedIn results. Return JSON: { "searches": ["query1", "query2"] }`,
      }],
    });

    let searches = [query + ' LinkedIn'];
    try {
      const parsed = JSON.parse(planResponse.content[0].text);
      if (parsed.searches?.length) searches = parsed.searches.slice(0, 2);
    } catch { /* use default */ }

    console.log(`[Search] Search queries: ${JSON.stringify(searches)}`);

    // Step 2: For each search, navigate to Google and extract results
    const allResults = [];

    for (const searchQuery of searches) {
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

      // Navigate to Google search
      const searchPage = await requestPageContent(searchQuery, {
        url: googleUrl,
        timeoutMs: 20_000,
      });

      // Ask Claude to extract relevant URLs from search results
      const urlResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Extract URLs from Google search results. Return JSON only.`,
        messages: [{
          role: 'user',
          content: `From this Google search results page, extract the top ${limit} most relevant URLs (prefer LinkedIn, Twitter/X, company pages).\n\nPage content:\n${searchPage.content?.slice(0, 30_000)}\n\nReturn JSON: { "urls": [{ "url": "...", "title": "..." }] }`,
        }],
      });

      let urls = [];
      try {
        const parsed = JSON.parse(urlResponse.content[0].text);
        urls = (parsed.urls || []).slice(0, limit);
      } catch { /* no urls extracted */ }

      console.log(`[Search] Found ${urls.length} URLs for "${searchQuery}"`);

      // Step 3: Visit each URL and extract data
      for (const { url, title } of urls) {
        try {
          const pageData = await requestPageContent(query, {
            url,
            timeoutMs: 25_000,
          });

          allResults.push({
            url: pageData.url,
            title: pageData.title || title,
            content: pageData.content?.slice(0, 50_000),
          });

          console.log(`[Search] Extracted: ${pageData.title} (${pageData.content?.length} chars)`);
        } catch (err) {
          console.warn(`[Search] Failed to extract ${url}: ${err.message}`);
        }
      }
    }

    if (allResults.length === 0) {
      return res.json({ ok: true, result: 'No relevant pages found.', pages: [] });
    }

    // Step 4: Send all extracted content to Claude for synthesis
    const pagesText = allResults
      .map((p, i) => `--- Page ${i + 1}: ${p.title} (${p.url}) ---\n${p.content}`)
      .join('\n\n');

    const synthesisResponse = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `You are a people research assistant. Extract and synthesize information about the person or topic from multiple web pages. Return structured data when possible (JSON with fields like name, title, company, linkedin, twitter, bio, etc). Be accurate — only include facts found in the pages.`,
      messages: [{
        role: 'user',
        content: `Original query: "${query}"\n\nExtracted pages:\n${pagesText.slice(0, 100_000)}\n\nSynthesize the findings. Return structured JSON if this is about a person.`,
      }],
    });

    const result = synthesisResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    console.log(`[Search] Done. Visited ${allResults.length} pages.`);

    res.json({
      ok: true,
      result,
      pages: allResults.map((p) => ({ url: p.url, title: p.title })),
      metadata: {
        searchQueries: searches,
        pagesVisited: allResults.length,
        model: synthesisResponse.model,
        inputTokens: synthesisResponse.usage?.input_tokens,
        outputTokens: synthesisResponse.usage?.output_tokens,
      },
    });
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Claude Chrome Extractor`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`\n  Waiting for Chrome extension to connect...\n`);
  console.log(`  To expose via ngrok: ngrok http ${PORT}\n`);
});
