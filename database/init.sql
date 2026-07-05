-- World Cup 2026 Predictions DB

-- ─── Fixtures (all rounds — auto-populated by live-sync from ESPN) ────────────
CREATE TABLE IF NOT EXISTS fixtures (
    id          SERIAL        PRIMARY KEY,
    external_id VARCHAR(100)  UNIQUE,
    round       VARCHAR(40)   NOT NULL DEFAULT 'Round of 32',
    round_order INTEGER       NOT NULL DEFAULT 1,
    team1       VARCHAR(60)   NOT NULL,
    team2       VARCHAR(60)   NOT NULL,
    kickoff_utc TIMESTAMPTZ   NOT NULL,
    date_label  VARCHAR(30),
    time_label  VARCHAR(30),
    venue       VARCHAR(100),
    created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- Seed Round of 32 (real 2026 World Cup schedule)
INSERT INTO fixtures (external_id, round, round_order, team1, team2, kickoff_utc, date_label, time_label, venue) VALUES
  ('wc26-r32-01', 'Round of 32', 1, 'Canada',         'South Africa',         '2026-06-28T19:00:00Z', 'Sun Jun 28', '3:00 PM ET',  'SoFi Stadium, Los Angeles'),
  ('wc26-r32-02', 'Round of 32', 1, 'Brazil',          'Japan',                '2026-06-29T17:00:00Z', 'Mon Jun 29', '1:00 PM ET',  'NRG Stadium, Houston'),
  ('wc26-r32-03', 'Round of 32', 1, 'Germany',         'Paraguay',             '2026-06-29T20:30:00Z', 'Mon Jun 29', '4:30 PM ET',  'Gillette Stadium, Boston'),
  ('wc26-r32-04', 'Round of 32', 1, 'Netherlands',     'Morocco',              '2026-06-30T01:00:00Z', 'Mon Jun 29', '9:00 PM ET',  'Estadio BBVA, Monterrey'),
  ('wc26-r32-05', 'Round of 32', 1, 'Ivory Coast',     'Norway',               '2026-06-30T17:00:00Z', 'Tue Jun 30', '1:00 PM ET',  'AT&T Stadium, Dallas'),
  ('wc26-r32-06', 'Round of 32', 1, 'France',          'Sweden',               '2026-06-30T21:00:00Z', 'Tue Jun 30', '5:00 PM ET',  'MetLife Stadium, New York'),
  ('wc26-r32-07', 'Round of 32', 1, 'Mexico',          'Ecuador',              '2026-07-01T01:00:00Z', 'Tue Jun 30', '9:00 PM ET',  'Estadio Azteca, Mexico City'),
  ('wc26-r32-08', 'Round of 32', 1, 'England',         'DR Congo',             '2026-07-01T16:00:00Z', 'Wed Jul 1',  '12:00 PM ET', 'Mercedes-Benz Stadium, Atlanta'),
  ('wc26-r32-09', 'Round of 32', 1, 'Belgium',         'Senegal',              '2026-07-01T20:00:00Z', 'Wed Jul 1',  '4:00 PM ET',  'Lumen Field, Seattle'),
  ('wc26-r32-10', 'Round of 32', 1, 'United States',   'Bosnia & Herzegovina', '2026-07-02T00:00:00Z', 'Wed Jul 1',  '8:00 PM ET',  'Levi''s Stadium, San Francisco'),
  ('wc26-r32-11', 'Round of 32', 1, 'Spain',           'Austria',              '2026-07-02T19:00:00Z', 'Thu Jul 2',  '3:00 PM ET',  'SoFi Stadium, Los Angeles'),
  ('wc26-r32-12', 'Round of 32', 1, 'Portugal',        'Croatia',              '2026-07-02T23:00:00Z', 'Thu Jul 2',  '7:00 PM ET',  'BMO Field, Toronto'),
  ('wc26-r32-13', 'Round of 32', 1, 'Switzerland',     'Algeria',              '2026-07-03T03:00:00Z', 'Thu Jul 2',  '11:00 PM ET', 'BC Place, Vancouver'),
  ('wc26-r32-14', 'Round of 32', 1, 'Australia',       'Egypt',                '2026-07-03T18:00:00Z', 'Fri Jul 3',  '2:00 PM ET',  'AT&T Stadium, Dallas'),
  ('wc26-r32-15', 'Round of 32', 1, 'Argentina',       'Cape Verde',           '2026-07-03T22:00:00Z', 'Fri Jul 3',  '6:00 PM ET',  'Hard Rock Stadium, Miami'),
  ('wc26-r32-16', 'Round of 32', 1, 'Colombia',        'Ghana',                '2026-07-04T01:30:00Z', 'Fri Jul 3',  '9:30 PM ET',  'Arrowhead Stadium, Kansas City')
ON CONFLICT (external_id) DO NOTHING;

-- ─── User predictions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
    id          SERIAL      PRIMARY KEY,
    username    VARCHAR(50) NOT NULL,
    fixture_id  INTEGER     NOT NULL,
    team1       VARCHAR(60) NOT NULL,
    team2       VARCHAR(60) NOT NULL,
    score1      INTEGER     NOT NULL,
    score2      INTEGER     NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Actual match results ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actual_results (
    fixture_id  INTEGER     PRIMARY KEY,
    score1      INTEGER     NOT NULL,
    score2      INTEGER     NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
