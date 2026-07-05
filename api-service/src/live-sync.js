'use strict';

// Fetches live World Cup 2026 data from ESPN's unofficial API.
// Runs every 60 seconds and automatically:
//   - Updates actual results for completed matches
//   - Inserts new fixtures (Round of 16, QF, SF, Final) as ESPN publishes them

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

// Map ESPN team names -> our standardized names
const NAME_MAP = {
  'USA': 'United States',
  'U.S.': 'United States',
  "Côte d'Ivoire": 'Ivory Coast',
  "Cote d'Ivoire": 'Ivory Coast',
  'Cote dIvoire': 'Ivory Coast',
  'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
  'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
  'Bosnia Herzegovina': 'Bosnia & Herzegovina',
  'Congo DR': 'DR Congo',
  'Dem. Rep. Congo': 'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
  'Republic of Congo': 'DR Congo',
  'Cape Verde Islands': 'Cape Verde',
  'Cabo Verde': 'Cape Verde',
  'Korea Republic': 'South Korea',
  'South Korea': 'South Korea',
};

const ROUND_ORDER_MAP = {
  'Round of 32': 1,
  'Round of 16': 2,
  'Quarterfinal': 3,
  'Quarter-final': 3,
  'Quarter Final': 3,
  'Semifinal': 4,
  'Semi-final': 4,
  'Semi Final': 4,
  'Third-Place Playoff': 5,
  'Third Place Playoff': 5,
  '3rd Place': 5,
  'Final': 6,
};

function normName(name) {
  return NAME_MAP[name] || name;
}

// Live match status cache: fixtureId → { is_live, is_ft, elapsed_min }
// Updated every sync cycle so the frontend always shows the real ESPN clock.
const liveStatusCache = new Map();

function dateStr(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Jerusalem'
  });
}

function fmtTime(iso) {
  const t = new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Jerusalem'
  });
  return `${t} IL`;
}

// All dates of the 2026 World Cup knockout phase
function allDates() {
  const dates = [];
  const start = new Date('2026-06-28');
  const end   = new Date('2026-07-19');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(dateStr(new Date(d)));
  }
  return dates;
}

async function fetchDay(dateStr8) {
  const res = await fetch(`${ESPN_BASE}?dates=${dateStr8}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.events || [];
}

async function processEvent(pool, event) {
  const comp = event.competitions?.[0];
  if (!comp) return;

  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home?.team || !away?.team) return;

  const team1      = normName(home.team.displayName || '');
  const team2      = normName(away.team.displayName || '');
  const kickoff    = comp.date || event.date;
  const venue      = comp.venue?.fullName || '';
  const roundName  = event.notes?.[0]?.headline || 'Round of 32';
  const roundOrder = ROUND_ORDER_MAP[roundName] ?? 1;
  const extId      = `espn-${event.id}`;

  // Try to find existing fixture: by ESPN id, or by team names (order-insensitive)
  const found = await pool.query(
    `SELECT id FROM fixtures
     WHERE external_id = $1
        OR (LOWER(team1)=LOWER($2) AND LOWER(team2)=LOWER($3))
        OR (LOWER(team1)=LOWER($3) AND LOWER(team2)=LOWER($2))
     LIMIT 1`,
    [extId, team1, team2]
  );

  let fixtureId;
  if (found.rows.length > 0) {
    fixtureId = found.rows[0].id;
    // Stamp the ESPN id so future syncs are fast
    await pool.query(
      `UPDATE fixtures
       SET external_id=$1, round=$2, round_order=$3, venue=COALESCE(NULLIF($4,''), venue),
           date_label=$6, time_label=$7
       WHERE id=$5`,
      [extId, roundName, roundOrder, venue, fixtureId, fmtDate(kickoff), fmtTime(kickoff)]
    );
  } else {
    // New fixture — insert it (R16, QF, SF, Final appear here as the tournament progresses)
    const ins = await pool.query(
      `INSERT INTO fixtures
         (external_id, round, round_order, team1, team2, kickoff_utc, date_label, time_label, venue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (external_id) DO UPDATE
         SET round=$2, round_order=$3, team1=$4, team2=$5, kickoff_utc=$6,
             date_label=$7, time_label=$8, venue=$9
       RETURNING id`,
      [extId, roundName, roundOrder, team1, team2, kickoff,
       fmtDate(kickoff), fmtTime(kickoff), venue]
    );
    fixtureId = ins.rows[0]?.id;
  }

  if (!fixtureId) return;

  // Update live status cache with ESPN's real game clock
  const statusType  = event.status?.type;
  const isLive      = statusType?.state === 'in' && !statusType?.completed;
  const completed   = statusType?.completed === true || statusType?.name === 'STATUS_FINAL';
  const clockStr    = event.status?.displayClock || '';        // e.g. "77:00" or "45+2'"
  const elapsed_min = isLive ? (parseInt(clockStr) || null) : null;
  const live_s1     = isLive ? (parseInt(home.score ?? '') >= 0 ? parseInt(home.score) : null) : null;
  const live_s2     = isLive ? (parseInt(away.score ?? '') >= 0 ? parseInt(away.score) : null) : null;
  liveStatusCache.set(fixtureId, { is_live: isLive, is_ft: completed, elapsed_min, live_s1, live_s2 });

  // Save result if match is finished
  const completed2 = completed;

  if (completed2) {
    const s1 = parseInt(home.score ?? '');
    const s2 = parseInt(away.score ?? '');
    if (!isNaN(s1) && !isNaN(s2)) {
      await pool.query(
        `INSERT INTO actual_results (fixture_id, score1, score2)
         VALUES ($1,$2,$3)
         ON CONFLICT (fixture_id) DO UPDATE SET score1=$2, score2=$3, updated_at=NOW()`,
        [fixtureId, s1, s2]
      );
    }
  }
}

async function syncAll(pool) {
  const today    = new Date();
  const todayStr = dateStr(today);
  const all      = allDates();
  const todayIdx = all.indexOf(todayStr);

  // Prioritise today ± 2 days (live + upcoming matches)
  const priority = all.slice(Math.max(0, todayIdx - 1), todayIdx + 3);
  const rest     = all.filter(d => !priority.includes(d));

  let updated = 0;
  for (const day of [...priority, ...rest]) {
    try {
      const events = await fetchDay(day);
      for (const ev of events) {
        await processEvent(pool, ev);
        updated++;
      }
    } catch { /* network error — skip day, retry next cycle */ }
  }

  if (updated) console.log(`[live-sync] synced ${updated} events`);
}

module.exports = { syncAll, liveStatusCache };
