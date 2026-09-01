// ============================================================================
// 1min-bridge — Visual Analytics Dashboard & Stats Routes
// ============================================================================

import { Hono } from "hono";
import { statsTracker } from "../stats.js";
import { getModelData } from "../model-registry.js";
import type { Env } from "../types.js";

const app = new Hono<Env>();

/** JSON API endpoint returning aggregated stats */
app.get("/api/stats", async (c) => {
  const summary = statsTracker.getSummary();
  const modelData = await getModelData().catch(() => null);

  return c.json({
    ...summary,
    modelsCount: {
      chat: modelData?.chatModelIds.length ?? 0,
      image: modelData?.imageModelIds.length ?? 0,
      speech: modelData?.speechModelIds.length ?? 0,
      total: modelData?.entries.length ?? 0,
    },
  });
});

/** Interactive HTML Dashboard */
const renderDashboardHtml = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>1min-bridge — Metrics & Check-in Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f2937;
      --card-hover: #1e293b;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.15);
      --warning: #f59e0b;
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.15);
      --accent: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: var(--bg); color: var(--text-main); min-height: 100vh; padding: 24px; }
    .container { max-width: 1380px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
    
    /* Header */
    header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid var(--card-border); padding-bottom: 18px; }
    .logo-group { display: flex; align-items: center; gap: 12px; }
    .logo-badge { background: linear-gradient(135deg, var(--primary), var(--accent)); color: #fff; font-weight: 800; font-size: 16px; padding: 6px 12px; border-radius: 8px; }
    .title-group h1 { font-size: 20px; font-weight: 700; }
    .title-group p { font-size: 13px; color: var(--text-muted); }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .status-pill { display: flex; align-items: center; gap: 6px; font-size: 12px; background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); padding: 4px 10px; border-radius: 20px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background-color: var(--success); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }

    /* Buttons */
    .btn { background: var(--card-border); color: var(--text-main); border: 1px solid #374151; padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-weight: 500; transition: all 0.2s; }
    .btn:hover { background: #374151; }
    .btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Top Summary Cards */
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
    .metric-label { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; display: flex; justify-content: space-between; }
    .metric-val { font-size: 26px; font-weight: 700; color: #fff; }
    .metric-sub { font-size: 12px; color: var(--text-muted); }

    /* Toggle Switcher */
    .controls-bar { display: flex; justify-content: space-between; align-items: center; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 8px 16px; flex-wrap: wrap; gap: 12px; }
    .tab-group { display: flex; background: #0f172a; border-radius: 8px; padding: 3px; border: 1px solid var(--card-border); }
    .tab-btn { background: transparent; border: none; color: var(--text-muted); padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .tab-btn.active { background: var(--primary); color: #fff; }

    /* Main Grid Layout */
    .main-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; }
    @media (max-width: 1024px) { .main-grid { grid-template-columns: 1fr; } }

    /* Section Cards */
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 12px; }
    .card-title { font-size: 16px; font-weight: 600; }

    /* Progress Breakdown Bars */
    .bar-list { display: flex; flex-direction: column; gap: 14px; }
    .bar-item { display: flex; flex-direction: column; gap: 4px; }
    .bar-label-row { display: flex; justify-content: space-between; font-size: 13px; }
    .bar-name { font-weight: 600; color: #e5e7eb; }
    .bar-stats { color: var(--text-muted); font-size: 12px; }
    .bar-track { width: 100%; height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--primary), var(--accent)); transition: width 0.4s ease; }

    /* Tables */
    .table-container { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { color: var(--text-muted); font-weight: 600; padding: 10px; border-bottom: 1px solid var(--card-border); font-size: 12px; text-transform: uppercase; }
    td { padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-success { background: var(--success-bg); color: var(--success); }
    .badge-danger { background: var(--danger-bg); color: var(--danger); }
    .badge-info { background: rgba(59, 130, 246, 0.15); color: var(--primary); }
    .code-font { font-family: ui-monospace, monospace; font-size: 12px; }

    /* Checkin Banner */
    .checkin-hero { background: linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(139, 92, 246, 0.08)); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 10px; padding: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .checkin-balance-title { font-size: 12px; color: var(--text-muted); text-transform: uppercase; }
    .checkin-balance-value { font-size: 24px; font-weight: 800; color: #fff; }
    .credit-tag { color: var(--success); font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="logo-group">
        <div class="logo-badge">1MIN</div>
        <div class="title-group">
          <h1>1min-bridge Live Dashboard</h1>
          <p>Real-time analytics, model credit consumption, and daily check-in logs</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="status-pill">
          <span class="status-dot"></span>
          <span id="gateway-status">Gateway Online</span>
        </div>
        <button class="btn" id="refresh-btn" onclick="fetchStats()">↻ Refresh</button>
      </div>
    </header>

    <!-- Top Summary Metric Cards -->
    <div class="summary-grid">
      <div class="metric-card">
        <div class="metric-label">Total Requests <span>⚡</span></div>
        <div class="metric-val" id="total-requests">0</div>
        <div class="metric-sub" id="uptime-text">Uptime: 0s</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Credits Consumed <span>💳</span></div>
        <div class="metric-val" id="total-credits">0</div>
        <div class="metric-sub">Across all AI models & APIs</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">1min.ai Wallet Balance <span>🎁</span></div>
        <div class="metric-val credit-tag" id="current-balance">—</div>
        <div class="metric-sub" id="balance-sub">Daily reset: +15,000 credits</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Next Daily Check-in <span>⏰</span></div>
        <div class="metric-val" id="next-checkin" style="font-size: 18px; margin-top: 4px;">—</div>
        <div class="metric-sub" id="checkin-status-text">Status: Checking...</div>
      </div>
    </div>

    <!-- View Mode Switcher -->
    <div class="controls-bar">
      <div style="font-size: 14px; font-weight: 600;">Analytics View Breakdown:</div>
      <div class="tab-group">
        <button class="tab-btn active" id="tab-requests" onclick="setViewMode('requests')">🔢 Request Count</button>
        <button class="tab-btn" id="tab-credits" onclick="setViewMode('credits')">💳 Credits Consumed</button>
      </div>
    </div>

    <!-- Main Content Grid -->
    <div class="main-grid">
      <!-- Left Column: Model & Endpoint Analytics -->
      <div style="display: flex; flex-direction: column; gap: 24px;">
        <!-- Model Usage Card -->
        <div class="card">
          <div class="card-header">
            <div class="card-title" id="models-card-title">🤖 Model Breakdown</div>
            <div style="font-size: 12px; color: var(--text-muted);" id="active-models-count">0 models recorded</div>
          </div>
          <div class="bar-list" id="models-list">
            <div style="color: var(--text-muted); font-size: 13px;">No model requests recorded yet. Send a request to see analytics.</div>
          </div>
        </div>

        <!-- Endpoint Breakdown Card -->
        <div class="card">
          <div class="card-header">
            <div class="card-title" id="endpoints-card-title">📁 Endpoint Breakdown</div>
          </div>
          <div class="bar-list" id="endpoints-list">
            <div style="color: var(--text-muted); font-size: 13px;">No endpoint requests recorded yet.</div>
          </div>
        </div>

        <!-- Recent Requests Live Table -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">⚡ Recent Requests (Last 20)</div>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Method / Endpoint</th>
                  <th>Model</th>
                  <th>Latency</th>
                  <th>Credits</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody id="recent-requests-table">
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No recent requests</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Right Column: Check-in & Credit Changes -->
      <div style="display: flex; flex-direction: column; gap: 24px;">
        <!-- Check-in Action Card -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">🎁 Daily Check-in (+15,000 Credits)</div>
            <span class="badge badge-info" id="checkin-badge">Ready</span>
          </div>

          <div class="checkin-hero">
            <div>
              <div class="checkin-balance-title">Account Credit Balance</div>
              <div class="checkin-balance-value" id="hero-balance">—</div>
            </div>
            <button class="btn btn-primary" id="manual-checkin-btn" onclick="runCheckin()">▶ Run Check-in Now</button>
          </div>

          <div style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
            1min.ai grants <strong>15,000 free credits daily</strong> for logging in. 1min-bridge automatically simulates portal authentication daily at 08:00 UTC (00:00 PST) with randomized jitter.
          </div>
        </div>

        <!-- Last 10 Credit Changes Log -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">📜 Credit Changes & Daily Check-in Log</div>
            <span style="font-size: 12px; color: var(--text-muted);">Last 10 runs</span>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Reward Delta</th>
                  <th>Ending Balance</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody id="checkin-history-table">
                <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No check-in records yet</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentMode = 'requests'; // 'requests' | 'credits'
    let currentData = null;

    function setViewMode(mode) {
      currentMode = mode;
      document.getElementById('tab-requests').classList.toggle('active', mode === 'requests');
      document.getElementById('tab-credits').classList.toggle('active', mode === 'credits');
      if (currentData) {
        renderBreakdowns(currentData);
      }
    }

    async function fetchStats() {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) throw new Error('API returned ' + res.status);
        const data = await res.json();
        currentData = data;
        renderDashboard(data);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      }
    }

    function formatNumber(num) {
      if (num === undefined || num === null) return '0';
      return Number(num).toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    function formatTime(isoStr) {
      if (!isoStr) return '—';
      const d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function renderDashboard(data) {
      // 1. Top Metrics
      document.getElementById('total-requests').textContent = formatNumber(data.totalRequests);
      document.getElementById('total-credits').textContent = formatNumber(data.totalCreditsConsumed);
      
      const balance = data.checkin?.currentBalance ?? (data.checkin?.lastRun?.finalCredit);
      document.getElementById('current-balance').textContent = balance !== undefined ? formatNumber(balance) + ' credits' : '—';
      document.getElementById('hero-balance').textContent = balance !== undefined ? formatNumber(balance) : '—';

      const hours = Math.floor(data.uptimeSeconds / 3600);
      const mins = Math.floor((data.uptimeSeconds % 3600) / 60);
      document.getElementById('uptime-text').textContent = \`Uptime: \${hours}h \${mins}m \${data.uptimeSeconds % 60}s\`;

      // Next check-in
      if (data.checkin?.nextScheduledRun) {
        const nextDate = new Date(data.checkin.nextScheduledRun);
        const diffMs = nextDate.getTime() - Date.now();
        if (diffMs > 0) {
          const diffMins = Math.round(diffMs / 60000);
          document.getElementById('next-checkin').textContent = \`In \${Math.floor(diffMins/60)}h \${diffMins%60}m\`;
        } else {
          document.getElementById('next-checkin').textContent = 'Due now';
        }
        document.getElementById('checkin-status-text').textContent = \`Scheduled: \${nextDate.toUTCString().slice(17, 22)} UTC\`;
      } else {
        document.getElementById('next-checkin').textContent = data.checkin?.enabled ? 'Configured' : 'Disabled';
        document.getElementById('checkin-status-text').textContent = data.checkin?.enabled ? 'Waiting for scheduler' : 'Add CHECKIN_EMAIL & PASSWORD';
      }

      // Checkin badge
      const badge = document.getElementById('checkin-badge');
      if (data.checkin?.enabled) {
        badge.textContent = 'Active (Daily)';
        badge.className = 'badge badge-success';
      } else {
        badge.textContent = 'Disabled';
        badge.className = 'badge badge-danger';
      }

      // 2. Render Breakdowns
      renderBreakdowns(data);

      // 3. Render Checkin History (Last 10)
      renderCheckinHistory(data.checkin?.history || []);

      // 4. Render Recent Requests (Last 20)
      renderRecentRequests(data.recentRequests || []);
    }

    function renderBreakdowns(data) {
      const isCredits = currentMode === 'credits';

      // Model Breakdown
      document.getElementById('models-card-title').textContent = isCredits ? '💳 Model Breakdown (by Credits Consumed)' : '🤖 Model Breakdown (by Request Count)';
      const modelsList = document.getElementById('models-list');
      const models = data.models || [];
      document.getElementById('active-models-count').textContent = \`\${models.length} active models\`;

      if (models.length === 0) {
        modelsList.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No model requests recorded yet.</div>';
      } else {
        const totalBase = isCredits ? (data.totalCreditsConsumed || 1) : (data.totalRequests || 1);
        modelsList.innerHTML = models.map(m => {
          const val = isCredits ? m.credits : m.requests;
          const pct = Math.min(100, Math.max(1, ((val / totalBase) * 100))).toFixed(1);
          const statText = isCredits ? \`\${formatNumber(m.credits)} credits (\${pct}%)\` : \`\${formatNumber(m.requests)} reqs (\${pct}%)\`;
          return \`
            <div class="bar-item">
              <div class="bar-label-row">
                <span class="bar-name">\${m.model}</span>
                <span class="bar-stats">\${statText}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width: \${pct}%;"></div>
              </div>
            </div>
          \`;
        }).join('');
      }

      // Endpoint Breakdown
      document.getElementById('endpoints-card-title').textContent = isCredits ? '💳 Endpoint Breakdown (by Credits Consumed)' : '📁 Endpoint Breakdown (by Request Count)';
      const endpointsList = document.getElementById('endpoints-list');
      const endpoints = data.endpoints || [];

      if (endpoints.length === 0) {
        endpointsList.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No endpoint requests recorded yet.</div>';
      } else {
        const totalBase = isCredits ? (data.totalCreditsConsumed || 1) : (data.totalRequests || 1);
        endpointsList.innerHTML = endpoints.map(e => {
          const val = isCredits ? e.credits : e.requests;
          const pct = Math.min(100, Math.max(1, ((val / totalBase) * 100))).toFixed(1);
          const statText = isCredits ? \`\${formatNumber(e.credits)} credits | \${e.avgDurationMs}ms avg\` : \`\${formatNumber(e.requests)} reqs | \${e.avgDurationMs}ms avg\`;
          return \`
            <div class="bar-item">
              <div class="bar-label-row">
                <span class="bar-name code-font">\${e.method} \${e.path}</span>
                <span class="bar-stats">\${statText}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width: \${pct}%; background: linear-gradient(90deg, #10b981, #3b82f6);"></div>
              </div>
            </div>
          \`;
        }).join('');
      }
    }

    function renderCheckinHistory(history) {
      const tableBody = document.getElementById('checkin-history-table');
      if (history.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No check-in records yet</td></tr>';
        return;
      }

      tableBody.innerHTML = history.slice(0, 10).map(entry => {
        const badge = entry.success ? '<span class="badge badge-success">Success</span>' : '<span class="badge badge-danger">Failed</span>';
        const diff = entry.creditDiff !== undefined && entry.creditDiff > 0
          ? \`<span class="credit-tag">+ \${formatNumber(entry.creditDiff)}</span>\`
          : entry.creditDiff === 0 ? '<span style="color: var(--text-muted);">+0 (checked in)</span>' : '—';
        const balance = entry.finalCredit !== undefined ? formatNumber(entry.finalCredit) : '—';

        return \`
          <tr>
            <td>\${badge}</td>
            <td>\${diff}</td>
            <td style="font-weight: 600;">\${balance}</td>
            <td style="color: var(--text-muted); font-size: 12px;">\${formatTime(entry.timestamp)}</td>
          </tr>
        \`;
      }).join('');
    }

    function renderRecentRequests(requests) {
      const tableBody = document.getElementById('recent-requests-table');
      if (requests.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No recent requests</td></tr>';
        return;
      }

      tableBody.innerHTML = requests.slice(0, 20).map(req => {
        const statusBadge = req.status >= 200 && req.status < 300
          ? \`<span class="badge badge-success">\${req.status}</span>\`
          : req.status >= 400 && req.status < 500
            ? \`<span class="badge" style="background: rgba(245,158,11,0.15); color: var(--warning);">\${req.status}</span>\`
            : \`<span class="badge badge-danger">\${req.status}</span>\`;

        return \`
          <tr>
            <td>\${statusBadge}</td>
            <td class="code-font">\${req.method} \${req.path}</td>
            <td>\${req.model || '<span style="color: var(--text-muted);">—</span>'}</td>
            <td>\${req.durationMs}ms</td>
            <td>\${req.credits > 0 ? \`<span style="color: var(--primary); font-weight: 600;">\${req.credits}</span>\` : '<span style="color: var(--text-muted);">0</span>'}</td>
            <td style="color: var(--text-muted); font-size: 12px;">\${formatTime(req.timestamp)}</td>
          </tr>
        \`;
      }).join('');
    }

    async function runCheckin() {
      const btn = document.getElementById('manual-checkin-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Checking in...';

      try {
        const res = await fetch('/v1/checkin/run', { method: 'POST' });
        const result = await res.json();
        if (result.success) {
          alert('✅ Daily Check-in Succeeded! ' + (result.result?.creditDiff > 0 ? \`+\${result.result.creditDiff} credits awarded!\` : 'Already checked in today.'));
        } else {
          alert('❌ Check-in failed: ' + (result.result?.error || result.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error triggering check-in: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Run Check-in Now';
        fetchStats();
      }
    }

    // Auto-refresh stats every 5 seconds
    fetchStats();
    setInterval(fetchStats, 5000);
  </script>
</body>
</html>`;

app.get("/dashboard", (c) => c.html(renderDashboardHtml()));
app.get("/stats", (c) => c.html(renderDashboardHtml()));

export default app;
