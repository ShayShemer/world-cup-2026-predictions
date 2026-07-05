'use strict';

const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");
const { syncAll, liveStatusCache } = require("./live-sync");

const app  = express();
const PORT = 3001;
const STATS_SERVICE_URL = process.env.STATS_SERVICE_URL || "http://stats-service:8001";
const MATCH_DURATION_MS = 130 * 60 * 1000; // 90 min + 40 min buffer

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://wcuser:wcpass@db:5432/worldcup",
});

// ─── Status from ESPN live cache (falls back to kickoff time) ────────────────
function computeStatus(kickoffUtc, fixtureId) {
  // Prefer ESPN real game clock when available
  const live = liveStatusCache.get(fixtureId);
  if (live) {
    if (live.is_ft)   return { status: "FT",       elapsed_min: null };
    if (live.is_live) return { status: "LIVE",      elapsed_min: live.elapsed_min };
    // upcoming according to ESPN
    return { status: "upcoming", elapsed_min: null };
  }
  // Fallback: estimate from kickoff time until first ESPN sync
  const elapsed = Date.now() - new Date(kickoffUtc).getTime();
  if (elapsed < 0) return { status: "upcoming", elapsed_min: null };
  if (elapsed < MATCH_DURATION_MS) return { status: "LIVE", elapsed_min: Math.floor(elapsed / 60000) };
  return { status: "FT", elapsed_min: null };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/fixtures", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.id, f.external_id, f.round, f.round_order,
             f.team1, f.team2, f.kickoff_utc, f.date_label, f.time_label, f.venue,
             ar.score1 AS actual_score1, ar.score2 AS actual_score2
      FROM   fixtures f
      LEFT JOIN actual_results ar ON ar.fixture_id = f.id
      ORDER  BY f.round_order, f.kickoff_utc
    `);

    const fixtures = rows.map(f => {
      const { status, elapsed_min } = computeStatus(f.kickoff_utc, f.id);
      const result = (status === 'FT' && f.actual_score1 !== null)
        ? `${f.actual_score1}-${f.actual_score2}` : null;
      const liveEntry = liveStatusCache.get(f.id);
      const live_score = (status === 'LIVE' && liveEntry?.live_s1 != null && liveEntry?.live_s2 != null)
        ? `${liveEntry.live_s1}-${liveEntry.live_s2}` : null;
      return {
        id: f.id, external_id: f.external_id,
        round: f.round, round_order: f.round_order,
        team1: f.team1, team2: f.team2,
        kickoff_utc: f.kickoff_utc,
        date: f.date_label  || new Date(f.kickoff_utc).toDateString(),
        time: f.time_label  || '',
        venue: f.venue || '',
        status, elapsed_min, result, live_score,
      };
    });

    res.json({ fixtures, server_time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/teams", async (req, res) => {
  try {
    const r = await fetch(`${STATS_SERVICE_URL}/teams`);
    res.json(await r.json());
  } catch {
    res.status(503).json({ error: "Stats service unavailable" });
  }
});

app.post("/fixtures/:id/prediction", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM fixtures WHERE id=$1", [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: "Fixture not found" });
    const f = rows[0];

    const r = await fetch(`${STATS_SERVICE_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team1: f.team1, team2: f.team2,
        team1_missing: req.body.team1_missing || [],
        team2_missing: req.body.team2_missing || [],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.detail || "Stats error" });
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: "Stats service unavailable", details: err.message });
  }
});

app.post("/predictions", async (req, res) => {
  const { username, fixtureId, score1, score2 } = req.body;
  if (!username || fixtureId == null || score1 == null || score2 == null)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const { rows } = await pool.query("SELECT * FROM fixtures WHERE id=$1", [Number(fixtureId)]);
    if (!rows[0]) return res.status(404).json({ error: "Fixture not found" });
    const f = rows[0];

    await pool.query(
      `INSERT INTO predictions (username, fixture_id, team1, team2, score1, score2)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [username, Number(fixtureId), f.team1, f.team2, Number(score1), Number(score2)]
    );
    res.status(201).json({ message: "Prediction saved!" });
  } catch (err) {
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

app.get("/predictions", async (req, res) => {
  const { fixtureId } = req.query;
  try {
    const q = fixtureId
      ? ["SELECT * FROM predictions WHERE fixture_id=$1 ORDER BY created_at DESC", [Number(fixtureId)]]
      : ["SELECT * FROM predictions ORDER BY created_at DESC", []];
    const { rows } = await pool.query(...q);
    res.json({ predictions: rows.map(r => ({
      id: r.id, username: r.username, fixtureId: r.fixture_id,
      team1: r.team1, team2: r.team2, score1: r.score1, score2: r.score2,
      timestamp: r.created_at,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/results", async (req, res) => {
  const { fixtureId, score1, score2 } = req.body;
  if (fixtureId == null || score1 == null || score2 == null)
    return res.status(400).json({ error: "Missing fields" });
  try {
    await pool.query(
      `INSERT INTO actual_results (fixture_id, score1, score2) VALUES ($1,$2,$3)
       ON CONFLICT (fixture_id) DO UPDATE SET score1=$2, score2=$3, updated_at=NOW()`,
      [Number(fixtureId), Number(score1), Number(score2)]
    );
    res.json({ message: "Result saved!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.username,
        SUM(CASE WHEN p.score1=r.score1 AND p.score2=r.score2 THEN 3
                 WHEN SIGN(p.score1-p.score2)=SIGN(r.score1-r.score2) THEN 1
                 ELSE 0 END) AS points,
        SUM(CASE WHEN p.score1=r.score1 AND p.score2=r.score2 THEN 1 ELSE 0 END) AS exact,
        SUM(CASE WHEN (p.score1!=r.score1 OR p.score2!=r.score2)
                      AND SIGN(p.score1-p.score2)=SIGN(r.score1-r.score2) THEN 1 ELSE 0 END) AS correct
      FROM predictions p
      JOIN actual_results r ON p.fixture_id=r.fixture_id
      GROUP BY p.username ORDER BY points DESC, exact DESC
    `);
    res.json({ leaderboard: rows.map(r => ({
      username: r.username, points: Number(r.points),
      exact: Number(r.exact), correct: Number(r.correct),
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  // Short delay so DB is ready, then start live sync
  setTimeout(async () => {
    await syncAll(pool).catch(() => {});
    setInterval(() => syncAll(pool).catch(() => {}), 60_000);
  }, 3000);

  // Clear visual signal so you know exactly when the app is ready
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  ✅  ALL SYSTEMS READY                               ║");
  console.log("║  👉  Open http://localhost:8080 in your browser      ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");
});
