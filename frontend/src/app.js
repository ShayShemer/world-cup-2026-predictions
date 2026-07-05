const API_BASE = "/api";
let teamProfiles = {};

// Cache AI predictions in localStorage so they survive page refresh
const aiCache = JSON.parse(localStorage.getItem("wc_ai_cache") || "{}");
function saveAiCache() {
  try { localStorage.setItem("wc_ai_cache", JSON.stringify(aiCache)); } catch {}
}

// Track which fixture predictions are currently visible (survives fixture re-render)
const predictionVisible = new Set();

// ─── Side Panel ───────────────────────────────────────────────────────────────
function togglePanel() {
  document.getElementById("results-panel").classList.toggle("open");
}

function renderResultsPanel(fixtures) {
  const el = document.getElementById("panel-content");
  if (!el || !fixtures) return;
  el.innerHTML = fixtures.map(f => {
    const ai = aiCache[f.id];
    const cls = f.status === "FT" ? "pm-ft" : f.status === "LIVE" ? "pm-live" : "pm-upcoming";
    const statusLabel = f.status === "FT" ? "FT" : f.status === "LIVE" ? "🔴 LIVE" : "Upcoming";
    const actualRow = f.result
      ? `<div class="pm-row"><span class="pm-label">Result</span><span class="pm-score">${f.result.replace("-", " – ")}</span></div>`
      : `<div class="pm-row"><span class="pm-label">Result</span><span class="pm-no-result">${statusLabel}</span></div>`;
    const aiRow = ai
      ? `<div class="pm-row"><span class="pm-label">AI pred.</span><span class="pm-ai-score">${ai.s1} – ${ai.s2}</span></div>`
      : `<div class="pm-row"><span class="pm-label">AI pred.</span><span class="pm-no-result">not requested</span></div>`;
    return `
      <div class="panel-match ${cls}" onclick="scrollToFixture(${f.id})">
        <div class="pm-teams">${f.team1} <span class="vs">vs</span> ${f.team2}</div>
        ${actualRow}${aiRow}
        <div class="pm-date">${f.date} · ${f.time}</div>
      </div>`;
  }).join("");
}

function scrollToFixture(id) {
  const card = document.querySelector(`[data-fixture-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (window.innerWidth < 768) togglePanel();
}

// Silently fetch AI prediction for a finished match and update its card
async function autoFetchPrediction(fixture) {
  try {
    const res = await fetch(`${API_BASE}/fixtures/${fixture.id}/prediction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team1_missing: [], team2_missing: [] }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.prediction) return;

    aiCache[fixture.id] = { s1: data.prediction.team1_score, s2: data.prediction.team2_score };
    saveAiCache();

    // Update just the FT block in the card (no full re-render needed)
    const block = document.querySelector(`[data-fixture-id="${fixture.id}"] .ft-result-block`);
    if (block) block.innerHTML = buildFtBlock(fixture);

    renderResultsPanel(window._lastFixtures || []);
  } catch { /* silently ignore network errors */ }
}

async function init() {
  await loadTeamProfiles();
  await loadFixtures();
  loadAllPredictions();
  // Refresh fixtures every 60 seconds so statuses update automatically
  setInterval(loadFixtures, 60000);
  setInterval(loadAllPredictions, 15000);
}

async function loadTeamProfiles() {
  try {
    const res = await fetch(`${API_BASE}/teams`);
    teamProfiles = (await res.json()).profiles || {};
  } catch (e) {}
}

function getUsername() {
  return document.getElementById("username").value.trim() || "Anonymous";
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function loadFixtures() {
  const container = document.getElementById("fixtures-container");
  try {
    const res = await fetch(`${API_BASE}/fixtures`);
    const { fixtures } = await res.json();
    const byDate = {}; // unused after round-grouping below
    for (const f of fixtures) {
      if (!byDate[f.date]) byDate[f.date] = [];
      byDate[f.date].push(f);
    }
    container.innerHTML = "";
    // Group by round (in order), then by date within each round
    const byRound = {};
    for (const f of fixtures) {
      const key = `${String(f.round_order || 1).padStart(2,'0')}:${f.round}`;
      if (!byRound[key]) byRound[key] = [];
      byRound[key].push(f);
    }
    const ROUND_ICONS = {
      'Round of 32': '⚽', 'Round of 16': '🎯',
      'Quarterfinal': '⚔️', 'Quarter-final': '⚔️',
      'Semifinal': '🔥', 'Semi-final': '🔥',
      'Third-Place Playoff': '🥉', '3rd Place': '🥉',
      'Final': '🏆',
    };
    for (const [key, matches] of Object.entries(byRound).sort()) {
      const round = key.slice(3);
      const icon  = ROUND_ICONS[round] || '⚽';
      const section = document.createElement("div");
      section.className = "round-section";
      section.innerHTML = `<h2 class="round-title">${icon} ${round}</h2>`;
      for (const fixture of matches) section.appendChild(createFixtureCard(fixture));
      container.appendChild(section);
    }
    window._lastFixtures = fixtures;
    renderResultsPanel(fixtures);

    // Auto-fetch AI predictions for finished matches that have no cached prediction
    fixtures
      .filter(f => f.status === "FT" && f.result && !aiCache[f.id])
      .forEach(f => autoFetchPrediction(f));
  } catch (err) {
    container.innerHTML = `<p class="empty">Could not load fixtures. (${err.message})</p>`;
  }
}

function statusBadge(status, result, elapsed_min, live_score) {
  if (status === "FT") {
    const score = result ? ` ${result.replace("-", " – ")}` : "";
    return `<span class="badge badge-ft">FT${score}</span>`;
  }
  if (status === "LIVE") {
    const min   = elapsed_min != null ? ` ${elapsed_min}'` : "";
    const score = live_score  != null ? ` · ${live_score.replace("-", " – ")}` : "";
    return `<span class="badge badge-live">🔴 LIVE${min}${score}</span>`;
  }
  return `<span class="badge badge-upcoming">Upcoming</span>`;
}

function buildFtBlock(fixture) {
  if (!fixture.result) return `<span class="ft-pending">Result pending...</span>`;

  const [a1, a2] = fixture.result.split("-").map(Number);
  const actualWin = Math.sign(a1 - a2);

  const resultRow = `
    <div class="ft-row">
      <span class="ft-row-label">Full Time</span>
      <span class="ft-score">${a1} – ${a2}</span>
    </div>`;

  const ai = aiCache[fixture.id];
  let aiRow = "";
  if (ai) {
    const correct = Math.sign(ai.s1 - ai.s2) === actualWin;
    const cls  = correct ? "ai-verdict-correct" : "ai-verdict-wrong";
    const badge = correct ? "CORRECT" : "WRONG";
    aiRow = `
      <div class="ft-row">
        <span class="ft-row-label">AI Predicted</span>
        <span class="ai-verdict ${cls}">${ai.s1} – ${ai.s2}<span class="ai-verdict-badge">${badge}</span></span>
      </div>`;
  }

  return resultRow + aiRow;
}

function createFixtureCard(fixture) {
  const card = document.createElement("div");
  card.className = `fixture-card ${fixture.status}`;
  card.setAttribute("data-fixture-id", fixture.id);
  const p1 = teamProfiles[fixture.team1] || {};
  const p2 = teamProfiles[fixture.team2] || {};
  const isPlayable = fixture.status !== "FT";

  // After card is in the DOM, restore prediction if it was visible before the refresh
  if (isPlayable) {
    setTimeout(() => {
      if (predictionVisible.has(fixture.id) && aiCache[fixture.id]?.fullData) {
        const recDiv = document.getElementById(`rec-${fixture.id}`);
        const btn    = document.querySelector(`[data-pred-btn="${fixture.id}"]`);
        if (recDiv) {
          recDiv.style.display = "block";
          renderPrediction(recDiv, aiCache[fixture.id].fullData, fixture.team1, fixture.team2);
        }
        if (btn) btn.textContent = "🙈 Hide Prediction";
      }
    }, 0);
  }

  card.innerHTML = `
    <div class="fixture-header">
      <div class="teams">
        <span class="team-name">${fixture.team1}</span>
        <span class="vs">vs</span>
        <span class="team-name">${fixture.team2}</span>
      </div>
      <div class="fixture-meta">
        ${statusBadge(fixture.status, fixture.result, fixture.elapsed_min, fixture.live_score)}
        <span class="fixture-time">${fixture.time}</span>
      </div>
    </div>
    <div class="fixture-venue">📍 ${fixture.venue}</div>

    ${isPlayable ? `
      <div class="missing-section">
        <div class="missing-col">
          <div class="missing-label">${fixture.team1} — missing:</div>
          <div class="player-toggles" id="missing-t1-${fixture.id}">
            ${renderPlayerToggles(p1.key_players || [], "t1", fixture.id)}
          </div>
        </div>
        <div class="missing-col">
          <div class="missing-label">${fixture.team2} — missing:</div>
          <div class="player-toggles" id="missing-t2-${fixture.id}">
            ${renderPlayerToggles(p2.key_players || [], "t2", fixture.id)}
          </div>
        </div>
      </div>

      <button class="analyze-btn" data-pred-btn="${fixture.id}" onclick="requestPrediction(${fixture.id}, '${fixture.team1}', '${fixture.team2}')">
        🤖 Get AI Prediction
      </button>
      <div class="recommendation" id="rec-${fixture.id}" style="display:none"></div>

      <div class="user-prediction">
        <label>Your prediction:</label>
        <div class="score-inputs">
          <input type="number" min="0" max="20" value="0" id="s1-${fixture.id}" />
          <span class="score-dash">–</span>
          <input type="number" min="0" max="20" value="0" id="s2-${fixture.id}" />
        </div>
        <button class="submit-btn" onclick="submitPrediction(${fixture.id}, '${fixture.team1}', '${fixture.team2}')">Submit</button>
        <span id="msg-${fixture.id}"></span>
      </div>
    ` : `<div class="ft-result-block">${buildFtBlock(fixture)}</div>`}
  `;
  return card;
}

function renderPlayerToggles(players, teamKey, fixtureId) {
  if (!players.length) return `<span style="color:#4b5563;font-size:0.8rem">No data</span>`;
  return players.map(p => `
    <label class="player-toggle">
      <input type="checkbox" value="${p.name}" />
      <span class="player-name">${p.name}</span>
      <span class="player-pos ${p.position.toLowerCase()}">${p.position}</span>
    </label>
  `).join("");
}

function getCheckedPlayers(teamKey, fixtureId) {
  const container = document.getElementById(`missing-${teamKey}-${fixtureId}`);
  if (!container) return [];
  return [...container.querySelectorAll("input:checked")].map(cb => cb.value);
}

// ─── AI Prediction (toggle show/hide, persists across fixture refreshes) ─────

async function requestPrediction(fixtureId, team1, team2) {
  const recDiv = document.getElementById(`rec-${fixtureId}`);
  const btn    = document.querySelector(`[data-pred-btn="${fixtureId}"]`);

  // ── HIDE if currently visible ─────────────────────────────────────────────
  if (predictionVisible.has(fixtureId)) {
    recDiv.style.display = "none";
    predictionVisible.delete(fixtureId);
    if (btn) btn.textContent = "🤖 Show AI Prediction";
    return;
  }

  // ── SHOW from cache (instant, no network call) ────────────────────────────
  if (aiCache[fixtureId]?.fullData) {
    recDiv.style.display = "block";
    renderPrediction(recDiv, aiCache[fixtureId].fullData, team1, team2, fixtureId);
    predictionVisible.add(fixtureId);
    if (btn) btn.textContent = "🙈 Hide Prediction";
    return;
  }

  // ── FETCH from stats-service ──────────────────────────────────────────────
  predictionVisible.add(fixtureId);
  recDiv.style.display = "block";
  recDiv.className = "recommendation loading-rec";
  recDiv.innerHTML = "⏳ Running Poisson model with 5-factor analysis...";
  if (btn) btn.textContent = "🙈 Hide Prediction";

  try {
    const res = await fetch(`${API_BASE}/fixtures/${fixtureId}/prediction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team1_missing: getCheckedPlayers("t1", fixtureId),
        team2_missing: getCheckedPlayers("t2", fixtureId),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      recDiv.className = "recommendation";
      recDiv.innerHTML = `<span style="color:#ef4444">${data.error || "Prediction failed"}</span>`;
      return;
    }
    renderPrediction(recDiv, data, team1, team2, fixtureId);
  } catch {
    recDiv.className = "recommendation";
    recDiv.innerHTML = `<span style="color:#6b7280">Prediction unavailable.</span>`;
  }
}

function renderPrediction(el, data, team1, team2, fixtureId) {
  const { prediction, expected_goals, confidence, explanation, score_grid, extra_time, factors } = data;
  // Cache the full prediction so the panel + card can restore it after refresh
  if (fixtureId != null && prediction) {
    aiCache[fixtureId] = {
      s1: prediction.team1_score,
      s2: prediction.team2_score,
      fullData: data,
    };
    saveAiCache();
    renderResultsPanel(window._lastFixtures || []);
  }
  const form1 = factors?.form?.[team1]?.recent || [];
  const form2 = factors?.form?.[team2]?.recent || [];
  const mi1 = factors?.missing_players?.[team1] || [];
  const mi2 = factors?.missing_players?.[team2] || [];
  const recentMatches = factors?.h2h?.recent_matches || [];

  const formDots = form => form.map(r => {
    const c = r === "W" ? "#4ade80" : r === "D" ? "#f5c518" : "#ef4444";
    return `<span style="color:${c};font-weight:700">${r}</span>`;
  }).join(" ");

  // Extra time / penalties block
  let etHtml = "";
  if (extra_time && extra_time.goes_to_et) {
    const et = extra_time;
    const etScore1 = prediction.team1_score + et.et_goals_added.team1;
    const etScore2 = prediction.team2_score + et.et_goals_added.team2;

    if (!et.goes_to_penalties) {
      etHtml = `
        <div class="et-block">
          <div class="et-label">⏱️ After Extra Time</div>
          <div class="et-score">${team1} <strong>${etScore1}</strong> – <strong>${etScore2}</strong> ${team2}</div>
          <div class="et-note">Model predicts a decisive goal in extra time.</div>
        </div>`;
    } else {
      const pen = et.penalties;
      etHtml = `
        <div class="et-block">
          <div class="et-label">⏱️ Extra Time: Still ${prediction.team1_score}-${prediction.team2_score}</div>
          <div class="et-label" style="margin-top:0.5rem">🎯 Penalty Shootout</div>
          <div class="et-score">🏆 ${pen.predicted_winner} (${(pen.probability*100).toFixed(0)}% probability)</div>
          <div class="et-note">${pen.explanation}</div>
        </div>`;
    }
  }

  // H2H recent matches
  let h2hHtml = "";
  if (recentMatches.length > 0) {
    h2hHtml = `
      <div class="h2h-block">
        <div class="h2h-title">🕘 Recent Meetings (last 5 years)</div>
        ${recentMatches.map(m => `
          <div class="h2h-row">
            <span class="h2h-year">${m.year}</span>
            <span class="h2h-comp">${m.comp}</span>
            <span class="h2h-score">${team1} ${m.g1} – ${m.g2} ${team2}</span>
          </div>
        `).join("")}
      </div>`;
  } else {
    h2hHtml = `<div class="h2h-block"><div class="h2h-title">🕘 No recent meetings in the last 5 years</div></div>`;
  }

  // Probability chart (top 8 scores as bars)
  const top8 = (score_grid || []).slice(0, 8);
  const maxProb = top8[0]?.probability || 1;
  const chartHtml = top8.length ? `
    <div class="prob-chart">
      <div class="prob-title">📊 Score Probability Distribution</div>
      ${top8.map(s => `
        <div class="prob-row">
          <span class="prob-score">${s.score}</span>
          <div class="prob-bar-wrap">
            <div class="prob-bar" style="width:${(s.probability/maxProb*100).toFixed(1)}%"></div>
          </div>
          <span class="prob-pct">${(s.probability*100).toFixed(1)}%</span>
        </div>
      `).join("")}
    </div>` : "";

  const missingNote = [...mi1, ...mi2].length
    ? `<div class="missing-note">⚠️ Missing: ${[...mi1, ...mi2].join(", ")}</div>` : "";

  el.className = "recommendation";
  el.innerHTML = `
    <div class="recommendation-header"><span>🤖</span> AI Recommendation — 90 Minutes</div>
    <div class="predicted-score">${team1} ${prediction.team1_score} – ${prediction.team2_score} ${team2}</div>
    <div class="explanation">${explanation}</div>

    <div class="factors-row">
      <div class="factor-item"><span class="factor-label">xG</span><span>${expected_goals.team1} – ${expected_goals.team2}</span></div>
      <div class="factor-item"><span class="factor-label">${team1} form</span><span>${formDots(form1)}</span></div>
      <div class="factor-item"><span class="factor-label">${team2} form</span><span>${formDots(form2)}</span></div>
      <div class="factor-item"><span class="factor-label">Confidence</span><span>${(confidence*100).toFixed(1)}%</span></div>
    </div>
    ${missingNote}
    ${etHtml}
    ${chartHtml}
    ${h2hHtml}
  `;
}

// ─── Submit prediction ────────────────────────────────────────────────────────

async function submitPrediction(fixtureId, team1, team2) {
  const username = getUsername();
  const score1 = Number(document.getElementById(`s1-${fixtureId}`).value);
  const score2 = Number(document.getElementById(`s2-${fixtureId}`).value);
  const msgEl = document.getElementById(`msg-${fixtureId}`);

  try {
    const res = await fetch(`${API_BASE}/predictions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, fixtureId, score1, score2 }),
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = "✅ Saved!";
      msgEl.className = "prediction-success";
      setTimeout(() => (msgEl.textContent = ""), 2500);
      loadAllPredictions();
    } else {
      msgEl.textContent = data.error || "Error";
      msgEl.style.color = "#ef4444";
    }
  } catch {
    msgEl.textContent = "Network error";
    msgEl.style.color = "#ef4444";
  }
}

// ─── All predictions ──────────────────────────────────────────────────────────

async function loadAllPredictions() {
  const el = document.getElementById("predictions-table");
  try {
    const { predictions } = await (await fetch(`${API_BASE}/predictions`)).json();
    if (!predictions.length) { el.innerHTML = `<p class="empty">No predictions yet.</p>`; return; }
    el.innerHTML = `<div class="predictions-grid"></div>`;
    const grid = el.querySelector(".predictions-grid");
    for (const p of predictions) {
      const item = document.createElement("div");
      item.className = "pred-item";
      item.innerHTML = `
        <div class="pred-user">${p.username}</div>
        <div class="pred-match">${p.team1} vs ${p.team2}</div>
        <div class="pred-score">${p.score1} – ${p.score2}</div>`;
      grid.appendChild(item);
    }
  } catch { el.innerHTML = `<p class="empty">Could not load predictions.</p>`; }
}

init();
