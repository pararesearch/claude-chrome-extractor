const SERVER_BASE = 'http://localhost:3456';

const statusDot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const askBtn = document.getElementById('ask');
const queryInput = document.getElementById('query');
const resultDiv = document.getElementById('result');

// Check server health
async function checkHealth() {
  try {
    const res = await fetch(`${SERVER_BASE}/health`);
    const data = await res.json();
    if (data.ok && data.extensionConnected) {
      statusDot.className = 'dot on';
      statusText.textContent = 'Connected';
      askBtn.disabled = false;
    } else {
      statusDot.className = 'dot on';
      statusText.textContent = 'Server up, extension reconnecting...';
      askBtn.disabled = false;
    }
  } catch {
    statusDot.className = 'dot off';
    statusText.textContent = 'Server offline';
    askBtn.disabled = true;
  }
}

// Ask Claude about current page
askBtn.addEventListener('click', async () => {
  const query = queryInput.value.trim();
  if (!query) return;

  askBtn.disabled = true;
  askBtn.textContent = 'Extracting...';
  resultDiv.style.display = 'block';
  resultDiv.textContent = 'Grabbing page content...';
  resultDiv.className = 'result';

  try {
    const res = await fetch(`${SERVER_BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.ok) {
      resultDiv.textContent = data.result;
    } else {
      resultDiv.textContent = data.error || 'Unknown error';
      resultDiv.className = 'result error';
    }
  } catch (err) {
    resultDiv.textContent = err.message;
    resultDiv.className = 'result error';
  } finally {
    askBtn.disabled = false;
    askBtn.textContent = 'Extract';
  }
});

// Enter to submit
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askBtn.click();
  }
});

checkHealth();
setInterval(checkHealth, 5000);
