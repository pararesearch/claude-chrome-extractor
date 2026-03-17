/**
 * Headless research server — spawns Claude CLI for each request.
 *
 * Flow:
 *   External request → ngrok → POST /search → spawn `claude --print` →
 *   Claude uses WebSearch + WebFetch to browse the internet → returns result
 *
 * No Chrome extension needed. Claude CLI handles all web browsing natively.
 *
 * Environment:
 *   PORT — server port (default 3456)
 */

import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';

const PORT = process.env.PORT || 3456;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);
const app = express();
app.use(express.json({ limit: '5mb' }));

// Active research jobs for status polling
const activeJobs = new Map(); // jobId → { status, result, error, startedAt, query }

// --- Concurrency limiter ---
let runningCount = 0;
const waitQueue = []; // array of resolve callbacks

function acquireSlot() {
  if (runningCount < MAX_CONCURRENT) {
    runningCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next(); // hand the slot to the next waiter
  } else {
    runningCount--;
  }
}

// --- Spawn Claude CLI and capture output ---
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
    console.log(`[Claude] Spawning: claude ${args.slice(0, 6).join(' ')} ...`);

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

    // Manual timeout since spawn doesn't support timeout option
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onProgress) {
        options.onProgress(text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Log stderr in real-time for debugging
      process.stderr.write(`[Claude stderr] ${text}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Claude] Finished in ${elapsed}s (exit code ${code}) | stdout: ${stdout.length} chars`);

      if (killed) {
        reject(new Error(`Claude timed out after ${timeoutMs / 1000}s. Partial output: ${stdout.slice(0, 500)}`));
      } else if (code === 0) {
        resolve({ output: stdout.trim(), elapsed: parseFloat(elapsed) });
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    // Close stdin
    child.stdin.end();
  });
}

// --- Shared research prompt ---
function buildResearchPrompt() {
  return `You are an elite people research agent. Your job is to find comprehensive information about a person, company, or topic using web search.

## CRITICAL FIRST STEP
Before doing anything, you MUST load your tools by calling ToolSearch:
1. ToolSearch with query "select:WebSearch,WebFetch"
2. ToolSearch with query "select:mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__computer"
These are deferred tools that must be loaded before use. Do this FIRST.

## Research Process
1. FIRST: Load all tools using ToolSearch (see above)
2. Use WebSearch to search for the target from multiple angles
3. For public pages: use WebFetch to visit and extract content
4. For auth-gated pages (LinkedIn, Twitter/X, etc.): use mcp__claude-in-chrome__computer to navigate in Chrome and mcp__claude-in-chrome__get_page_text to extract content — this uses the real Chrome browser with logged-in sessions
5. For each page, extract all useful data
6. If you find links to more relevant pages (e.g., a company website mentioned on LinkedIn, a personal blog, GitHub, speaking events), fetch those too
7. Keep searching and following leads until you have a comprehensive picture
8. Cross-reference information across sources for accuracy

## IMPORTANT: LinkedIn and Auth-Gated Sites
When you need to visit LinkedIn profiles or any site that requires login:
- Use the Chrome tools (mcp__claude-in-chrome__computer to navigate, mcp__claude-in-chrome__get_page_text to read)
- The Chrome browser has the user's logged-in sessions, so you can access full profiles
- Do NOT use WebFetch for LinkedIn — it will get blocked with 429 errors

## Be Thorough
- Search from multiple angles: name + company, name + LinkedIn, name + Twitter, company + team page, etc.
- Don't stop after one search — do at least 3-5 different searches
- Visit at LEAST 5-10 pages before concluding
- If a LinkedIn profile links to a personal website or blog, fetch that too
- If you find the person's company, visit the company's about/team page
- Look for conference talks, podcast appearances, blog posts, GitHub repos

## Output Format
Return ONLY a comprehensive JSON dossier with ALL information found:
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
  "phone": "if publicly available",
  "bio": "Professional summary",
  "experience": [{ "company": "", "title": "", "dates": "", "description": "" }],
  "education": [{ "school": "", "degree": "", "dates": "" }],
  "skills": ["skill1", "skill2"],
  "achievements": ["notable things"],
  "speaking": ["conferences/events"],
  "publications": ["articles/papers"],
  "social_profiles": [{ "platform": "", "url": "" }],
  "sources": ["URLs where each piece of info was found"],
  "confidence": "high/medium/low",
  "notes": "any caveats or uncertainties"
}

Only include fields where you found actual data. NEVER fabricate information.`;
}

// --- Concurrency-limited Claude runner ---
async function runClaudeWithLimit(prompt, options = {}) {
  await acquireSlot();
  try {
    return await runClaude(prompt, options);
  } finally {
    releaseSlot();
  }
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    activeJobs: activeJobs.size,
    runningProcesses: runningCount,
    queuedRequests: waitQueue.length,
    maxConcurrent: MAX_CONCURRENT,
    uptime: process.uptime(),
  });
});

// --- Deep research endpoint (synchronous — waits for result) ---
app.post('/search', async (req, res) => {
  const { query, model, maxBudget, timeoutMs } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  const jobId = crypto.randomUUID();

  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Search] Job ${jobId.slice(0, 8)}`);
    console.log(`[Search] Query: "${query}"`);
    console.log(`${'='.repeat(60)}`);

    activeJobs.set(jobId, { status: 'running', query, startedAt: Date.now() });

    const result = await runClaudeWithLimit(query, {
      model: model || 'claude-sonnet-4-6',
      systemPrompt: buildResearchPrompt(),
      maxBudget: maxBudget || 1.0,
      timeoutMs: timeoutMs || 300_000,
      onProgress: (text) => {
        const job = activeJobs.get(jobId);
        if (job) job.partialOutput = (job.partialOutput || '') + text;
      },
    });

    activeJobs.set(jobId, { status: 'complete', result: result.output, elapsed: result.elapsed });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Search] COMPLETE — ${result.elapsed}s`);
    console.log(`[Search] Result preview: ${result.output.slice(0, 200)}...`);
    console.log(`${'='.repeat(60)}\n`);

    res.json({
      ok: true,
      jobId,
      result: result.output,
      metadata: {
        elapsed: result.elapsed,
        model: model || 'claude-sonnet-4-6',
      },
    });
  } catch (err) {
    console.error(`[Search] Error: ${err.message}`);
    activeJobs.set(jobId, { status: 'failed', error: err.message });
    res.status(500).json({ error: err.message, jobId });
  }
});

// --- Async research endpoint (returns jobId immediately, poll for results) ---
app.post('/search/async', async (req, res) => {
  const { query, model, maxBudget, timeoutMs } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  const jobId = crypto.randomUUID();

  console.log(`\n[AsyncSearch] Job ${jobId.slice(0, 8)} — "${query}"`);
  activeJobs.set(jobId, { status: 'running', query, startedAt: Date.now() });

  // Fire and forget — client polls /search/status/:jobId
  runClaudeWithLimit(query, {
    model: model || 'claude-sonnet-4-6',
    systemPrompt: buildResearchPrompt(),
    maxBudget: maxBudget || 1.0,
    timeoutMs: timeoutMs || 300_000,
    onProgress: (text) => {
      const job = activeJobs.get(jobId);
      if (job) job.partialOutput = (job.partialOutput || '') + text;
    },
  })
    .then((result) => {
      activeJobs.set(jobId, { status: 'complete', result: result.output, elapsed: result.elapsed, query });
      console.log(`[AsyncSearch] Job ${jobId.slice(0, 8)} complete — ${result.elapsed}s`);
    })
    .catch((err) => {
      activeJobs.set(jobId, { status: 'failed', error: err.message, query });
      console.error(`[AsyncSearch] Job ${jobId.slice(0, 8)} failed: ${err.message}`);
    });

  res.json({ ok: true, jobId, status: 'running' });
});

// --- Poll job status ---
app.get('/search/status/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
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

  if (job.status === 'complete') {
    response.result = job.result;
  } else if (job.status === 'failed') {
    response.error = job.error;
  } else if (job.partialOutput) {
    response.partialOutput = job.partialOutput.slice(-2000); // last 2k chars of progress
  }

  res.json(response);
});

// --- Simple single-page fetch + extract ---
app.post('/extract', async (req, res) => {
  const { url, query, model } = req.body;

  if (!url || !query) {
    return res.status(400).json({ error: 'url and query are required' });
  }

  try {
    console.log(`[Extract] URL: ${url} | Query: "${query.slice(0, 80)}"`);

    const prompt = `Extract data from this URL: ${url}

## CRITICAL FIRST STEP
Load your tools first:
1. ToolSearch with query "select:WebSearch,WebFetch"
2. ToolSearch with query "select:mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__computer"

## Extraction
First try WebFetch to get the page. If it fails (429, 999, blocked), use Chrome tools instead:
- mcp__claude-in-chrome__computer to navigate to the URL in the browser
- mcp__claude-in-chrome__get_page_text to read the page content
Chrome has the user's logged-in sessions so it can access LinkedIn, Twitter, etc.

## Query
${query}

Return the extracted data as structured JSON. Only include facts found on the page.`;

    const result = await runClaudeWithLimit(prompt, {
      model: model || 'claude-sonnet-4-6',
      maxBudget: 0.25,
      timeoutMs: 60_000,
    });

    res.json({
      ok: true,
      result: result.output,
      metadata: { url, elapsed: result.elapsed },
    });
  } catch (err) {
    console.error(`[Extract] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// --- Batch search: fire multiple queries in parallel ---
app.post('/search/batch', async (req, res) => {
  const { queries, model, maxBudget, timeoutMs } = req.body;

  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'queries (array of strings) is required' });
  }

  if (queries.length > 20) {
    return res.status(400).json({ error: 'Max 20 queries per batch' });
  }

  const jobIds = [];
  const systemPrompt = buildResearchPrompt();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Batch] ${queries.length} queries firing in parallel`);
  console.log(`${'='.repeat(60)}`);

  for (const query of queries) {
    const jobId = crypto.randomUUID();
    jobIds.push(jobId);

    console.log(`[Batch] Job ${jobId.slice(0, 8)} — "${query}"`);
    activeJobs.set(jobId, { status: 'queued', query, startedAt: Date.now() });

    runClaudeWithLimit(query, {
      model: model || 'claude-sonnet-4-6',
      systemPrompt,
      maxBudget: maxBudget || 1.0,
      timeoutMs: timeoutMs || 300_000,
      onProgress: (text) => {
        const job = activeJobs.get(jobId);
        if (job) {
          job.status = 'running';
          job.partialOutput = (job.partialOutput || '') + text;
        }
      },
    })
      .then((result) => {
        activeJobs.set(jobId, { status: 'complete', result: result.output, elapsed: result.elapsed, query });
        console.log(`[Batch] Job ${jobId.slice(0, 8)} complete — ${result.elapsed}s`);
      })
      .catch((err) => {
        activeJobs.set(jobId, { status: 'failed', error: err.message, query });
        console.error(`[Batch] Job ${jobId.slice(0, 8)} failed: ${err.message}`);
      });
  }

  res.json({
    ok: true,
    jobIds,
    total: queries.length,
    message: `${queries.length} jobs queued. Poll /search/status/:jobId for results.`,
  });
});

// --- List active jobs ---
app.get('/jobs', (req, res) => {
  const jobs = [];
  for (const [id, job] of activeJobs) {
    jobs.push({
      jobId: id,
      status: job.status,
      query: job.query,
      elapsed: job.elapsed || ((Date.now() - (job.startedAt || Date.now())) / 1000),
    });
  }
  res.json({ ok: true, jobs });
});

// Cleanup completed jobs after 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600_000;
  for (const [id, job] of activeJobs) {
    if ((job.status === 'complete' || job.status === 'failed') && (job.startedAt || 0) < oneHourAgo) {
      activeJobs.delete(id);
    }
  }
}, 300_000);

app.listen(PORT, () => {
  console.log(`\n  Claude Research Server (Headless CLI)`);
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  Concurrency: max ${MAX_CONCURRENT} parallel Claude processes`);
  console.log(`\n  Endpoints:`);
  console.log(`    POST /search        — sync deep research (waits for result)`);
  console.log(`    POST /search/async  — async research (returns jobId, poll /search/status/:jobId)`);
  console.log(`    POST /search/batch  — batch: fire multiple queries in parallel`);
  console.log(`    POST /extract       — fetch single URL + extract data`);
  console.log(`    GET  /search/status/:jobId — poll job result`);
  console.log(`    GET  /jobs          — list all active research jobs`);
  console.log(`\n  To expose via ngrok: ngrok http ${PORT}\n`);
});
