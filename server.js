/**
 * Claude Research Server — single endpoint, Claude decides how to research.
 *
 * Flow:
 *   POST /research { query, async, ... }
 *   → spawn `claude --print --chrome` with research prompt
 *   → Claude uses WebSearch, WebFetch, Chrome browser tools as needed
 *   → returns structured JSON result
 *
 * Environment:
 *   PORT           — server port (default 3456)
 *   MAX_CONCURRENT — max parallel Claude processes (default 5)
 */

import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';

const PORT = process.env.PORT || 3456;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);
const app = express();
app.use(express.json({ limit: '5mb' }));

// Active jobs for status polling
const jobs = new Map();

// --- Concurrency limiter ---
let runningCount = 0;
const waitQueue = [];

function acquireSlot() {
  if (runningCount < MAX_CONCURRENT) {
    runningCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    waitQueue.shift()();
  } else {
    runningCount--;
  }
}

// --- Spawn Claude CLI ---
function runClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--chrome',
      '--model', options.model || 'claude-sonnet-4-6',
      '--output-format', 'text',
      '--no-session-persistence',
    ];

    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }
    if (options.maxBudget) {
      args.push('--max-budget-usd', String(options.maxBudget));
    }

    args.push(prompt);

    const startTime = Date.now();
    console.log(`[Claude] Spawning: model=${options.model || 'claude-sonnet-4-6'}, budget=$${options.maxBudget || 2}`);

    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SESSION;

    const timeoutMs = options.timeoutMs || 300_000;
    const child = spawn('claude', args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onProgress) options.onProgress(text);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Claude] Done in ${elapsed}s (code ${code}) | ${stdout.length} chars`);

      if (killed) {
        reject(new Error(`Timed out after ${timeoutMs / 1000}s. Partial: ${stdout.slice(0, 500)}`));
      } else if (code === 0) {
        resolve({ output: stdout.trim(), elapsed: parseFloat(elapsed) });
      } else {
        reject(new Error(`Exit code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Spawn failed: ${err.message}`));
    });

    child.stdin.end();
  });
}

async function runClaudeWithLimit(prompt, options = {}) {
  await acquireSlot();
  try {
    return await runClaude(prompt, options);
  } finally {
    releaseSlot();
  }
}

// --- System prompt ---
const SYSTEM_PROMPT = `You are an elite research agent. You find comprehensive information about people, companies, or topics using every tool available to you.

## CRITICAL FIRST STEP
Before doing anything, you MUST load your tools by calling ToolSearch:
1. ToolSearch with query "select:WebSearch,WebFetch"
2. ToolSearch with query "select:mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__computer"
Do this FIRST before any research.

## How to Decide What to Do

Analyze the user's query and automatically decide the best approach:

- **If given a URL** (LinkedIn, Twitter, any website): Navigate to it and extract all data. For LinkedIn/auth-gated sites, use Chrome tools. For public sites, try WebFetch first.
- **If given a person's name + context**: Do a deep web search from multiple angles (LinkedIn, Twitter, company pages, news, GitHub, Crunchbase, etc.), visit all relevant pages, and compile a dossier.
- **If given a company name**: Research the company, its founders, team, funding, products, news.
- **If given a general query**: Search the web thoroughly and return structured findings.

## Tool Selection (automatic)
- **WebSearch**: For Google searches
- **WebFetch**: For fetching public web pages
- **Chrome tools** (mcp__claude-in-chrome__computer + mcp__claude-in-chrome__get_page_text): For auth-gated pages like LinkedIn, Twitter/X, or any site that blocks bots. Chrome has the user's logged-in sessions.
- **NEVER use WebFetch for LinkedIn** — it gets 429/999 errors. Always use Chrome for LinkedIn.

## Be Thorough
- Search from multiple angles: name + company, name + LinkedIn, name + Twitter, company + team page
- Don't stop after one search — do at least 3-5 different searches
- Visit at LEAST 5-10 pages before concluding
- Follow links discovered in pages (personal blogs, company sites, GitHub repos, etc.)
- Cross-reference information across sources

## Output Format
Return a comprehensive JSON dossier with ALL information found. For people:
{
  "name": "Full Name",
  "title": "Current Job Title",
  "company": "Current Company",
  "location": "City, Country",
  "linkedin": "URL",
  "twitter": "URL",
  "github": "URL",
  "website": "URL",
  "email": "if publicly available",
  "bio": "Professional summary",
  "experience": [{ "company": "", "title": "", "dates": "", "description": "" }],
  "education": [{ "school": "", "degree": "", "dates": "" }],
  "skills": ["skill1", "skill2"],
  "achievements": ["notable things"],
  "social_profiles": [{ "platform": "", "url": "" }],
  "sources": ["URLs where info was found"],
  "confidence": "high/medium/low",
  "notes": "caveats or uncertainties"
}

For companies or general queries, adapt the JSON structure appropriately.
Only include fields where you found actual data. NEVER fabricate information.`;

// --- Run a research job ---
function launchJob(jobId, query, options) {
  jobs.set(jobId, { status: 'running', query, startedAt: Date.now() });

  const promise = runClaudeWithLimit(query, {
    model: options.model || 'claude-sonnet-4-6',
    systemPrompt: SYSTEM_PROMPT,
    maxBudget: options.maxBudget || 2.0,
    timeoutMs: options.timeoutMs || 300_000,
    onProgress: (text) => {
      const job = jobs.get(jobId);
      if (job) job.partialOutput = (job.partialOutput || '') + text;
    },
  });

  promise
    .then((result) => {
      jobs.set(jobId, { status: 'complete', result: result.output, elapsed: result.elapsed, query });
      console.log(`[Job ${jobId.slice(0, 8)}] Complete — ${result.elapsed}s`);
    })
    .catch((err) => {
      jobs.set(jobId, { status: 'failed', error: err.message, query });
      console.error(`[Job ${jobId.slice(0, 8)}] Failed: ${err.message}`);
    });

  return promise;
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    activeJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
    queuedJobs: waitQueue.length,
    maxConcurrent: MAX_CONCURRENT,
    uptime: process.uptime(),
  });
});

// ============================================================
// SINGLE ENDPOINT: POST /research
// ============================================================
app.post('/research', async (req, res) => {
  const { query, queries, async: isAsync, model, maxBudget, timeoutMs } = req.body;

  // --- Batch mode: multiple queries in parallel ---
  if (queries && Array.isArray(queries) && queries.length > 0) {
    if (queries.length > 20) {
      return res.status(400).json({ error: 'Max 20 queries per batch' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Batch] ${queries.length} queries`);
    console.log(`${'='.repeat(60)}`);

    const jobIds = [];
    for (const q of queries) {
      const jobId = crypto.randomUUID();
      jobIds.push({ jobId, query: q });
      console.log(`[Batch] ${jobId.slice(0, 8)} — "${q}"`);
      launchJob(jobId, q, { model, maxBudget, timeoutMs });
    }

    return res.json({
      ok: true,
      jobs: jobIds,
      poll: '/research/:jobId',
    });
  }

  // --- Single query ---
  if (!query) {
    return res.status(400).json({ error: 'query (string) or queries (array) is required' });
  }

  const jobId = crypto.randomUUID();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Research] ${jobId.slice(0, 8)} — "${query}"`);
  console.log(`${'='.repeat(60)}`);

  // --- Async mode: return jobId immediately ---
  if (isAsync) {
    launchJob(jobId, query, { model, maxBudget, timeoutMs });
    return res.json({ ok: true, jobId, status: 'running', poll: `/research/${jobId}` });
  }

  // --- Sync mode: wait for result ---
  try {
    const promise = launchJob(jobId, query, { model, maxBudget, timeoutMs });
    const result = await promise;

    res.json({
      ok: true,
      jobId,
      result: result.output,
      metadata: { elapsed: result.elapsed, model: model || 'claude-sonnet-4-6' },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, jobId });
  }
});

// --- Poll job status ---
app.get('/research/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const response = {
    ok: true,
    jobId: req.params.jobId,
    status: job.status,
    query: job.query,
    elapsed: job.elapsed || ((Date.now() - (job.startedAt || Date.now())) / 1000),
  };

  if (job.status === 'complete') response.result = job.result;
  else if (job.status === 'failed') response.error = job.error;
  else if (job.partialOutput) response.partialOutput = job.partialOutput.slice(-2000);

  res.json(response);
});

// --- List all jobs ---
app.get('/jobs', (req, res) => {
  const list = [];
  for (const [id, job] of jobs) {
    list.push({
      jobId: id,
      status: job.status,
      query: job.query,
      elapsed: job.elapsed || ((Date.now() - (job.startedAt || Date.now())) / 1000),
    });
  }
  res.json({ ok: true, jobs: list });
});

// Cleanup completed jobs after 1 hour
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of jobs) {
    if ((job.status === 'complete' || job.status === 'failed') && (job.startedAt || 0) < cutoff) {
      jobs.delete(id);
    }
  }
}, 300_000);

app.listen(PORT, () => {
  console.log(`\n  Claude Research Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Max concurrent: ${MAX_CONCURRENT}\n`);
  console.log(`  POST /research          — single query (sync or async)`);
  console.log(`  POST /research          — batch queries (pass "queries" array)`);
  console.log(`  GET  /research/:jobId   — poll job result`);
  console.log(`  GET  /jobs              — list all jobs`);
  console.log(`  GET  /health            — server status\n`);
  console.log(`  Examples:`);
  console.log(`    {"query": "find Akhil at Vyapar"}`);
  console.log(`    {"query": "https://linkedin.com/in/someone"}`);
  console.log(`    {"query": "...", "async": true}`);
  console.log(`    {"queries": ["person 1", "person 2", "person 3"]}\n`);
});
