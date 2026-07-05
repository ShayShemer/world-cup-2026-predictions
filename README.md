# World Cup 2026 Predictions App

A microservices-based web application where users predict match scores for the 2026 FIFA World Cup Round of 32. An AI model recommends outcomes based on historical data, team form, and player availability.

---

## How to Run (Quick Start)

### Prerequisites

1. Install **Docker Desktop**: https://www.docker.com/products/docker-desktop/
2. After installation, open Docker Desktop and wait for the green "Engine running" indicator at the bottom.

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/ShayShemer/world-cup-2026-predictions.git

# 2. Enter the project folder
cd world-cup-2026-predictions

# 3. Build and start all services
docker compose up --build
```

Wait for this message in the terminal:

```
✅  ALL SYSTEMS READY — Open http://localhost:8080
```

**4. Open your browser at: http://localhost:8080**

> The first build downloads Docker images and installs dependencies — it may take 2–5 minutes. Subsequent starts are much faster.

### Stop the app

```bash
docker compose down
```

### Fresh start (wipe all data)

```bash
docker compose down -v
docker compose up --build
```

---

## Troubleshooting

**Port already in use?**
Make sure nothing else is running on ports `8080`, `3001`, or `8001`. Stop conflicting processes, then retry.

**Docker not starting?**
Open Docker Desktop manually and wait for the green status indicator before running `docker compose`.

**Build fails?**
Run `docker compose down -v` first to clear any corrupted state, then `docker compose up --build` again.

**App loads but no fixtures?**
The app fetches live data from the ESPN API. Wait 10–15 seconds and refresh the page.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                             │
│                    http://localhost:8080                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Service 3: frontend (Nginx)                     │
│  Serves static HTML/CSS/JS                                  │
│  Proxies /api/* → api-service:3001                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ /api/* (internal Docker network)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Service 2: api-service (Node.js / Express)     │
│  - Manages fixtures & live status (LIVE / FT / Upcoming)   │
│  - Saves/retrieves predictions via PostgreSQL               │
│  - Calculates leaderboard with SQL                          │
│  - Routes prediction requests to stats-service              │
└────────────┬──────────────────────────┬─────────────────────┘
             │ SQL queries              │ HTTP /predict
             ▼                          ▼
┌────────────────────────┐  ┌──────────────────────────────────┐
│ Service 4: db          │  │ Service 1: stats-service         │
│ (PostgreSQL 16)        │  │ (Python / FastAPI)               │
│                        │  │                                  │
│ Tables:                │  │ - Poisson distribution model     │
│  predictions           │  │ - 5-factor weighted analysis:    │
│  actual_results        │  │   H2H, form, strength,           │
│                        │  │   FIFA ranking, missing players  │
│ Data persists across   │  │ - Extra time + penalties model   │
│ container restarts     │  │ - Score probability grid         │
└────────────────────────┘  └──────────────────────────────────┘
```

All four services run on a shared Docker bridge network (`app-network`). Services communicate using their service name as hostname (e.g., `http://stats-service:8001`).

---

## Services

### Service 1: stats-service (Python / FastAPI) — port 8001

The AI prediction engine. Uses a Poisson distribution model with 5 weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Head-to-head | 20% | Historical match results between the two teams |
| Recent form | 30% | Last 5 match results (W/D/L) with exponential decay |
| Team strength | 25% | Attack and defense ratings |
| FIFA ranking | 15% | Ranking difference between teams |
| Missing players | 10% | Impact score of absent key players |

Returns: predicted score, expected goals (xG), confidence %, score probability grid, extra time prediction, and penalty shootout prediction.

### Service 2: api-service (Node.js / Express) — port 3001

The application backend. Responsibilities:
- Serves all Round of 32 fixtures with dynamic live status (LIVE / FT / Upcoming) based on real UTC kickoff times
- Saves and retrieves user predictions via PostgreSQL
- Calculates leaderboard in SQL (3 pts exact score, 1 pt correct outcome)
- Syncs live match data from ESPN API every 60 seconds
- Proxies AI prediction requests to stats-service

### Service 3: frontend (Nginx) — port 8080

Serves the single-page UI as static files. Nginx proxies all `/api/*` requests to `api-service:3001`, so the browser only ever talks to one address.

### Service 4: db (PostgreSQL 16) — internal only

Stores all user data persistently. Initialized automatically on first run via `database/init.sql`. Data survives container restarts via a named Docker volume (`pgdata`).

Tables:
- `predictions` — one row per user prediction (username, fixture, score)
- `actual_results` — one row per completed match

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/fixtures | All fixtures with live status |
| GET | /api/teams | Team profiles and key players |
| POST | /api/fixtures/:id/prediction | Get AI prediction for a fixture |
| POST | /api/predictions | Submit a user prediction |
| GET | /api/predictions | Get all predictions |
| POST | /api/results | Save an actual match result |
| GET | /api/leaderboard | Ranked leaderboard |

---

## Project Structure

```
world-cup-2026-predictions/
├── docker-compose.yml          # Defines all 4 services
├── README.md
├── database/
│   └── init.sql                # Creates tables on first run
├── stats-service/              # Service 1 — Python / FastAPI
│   ├── Dockerfile
│   ├── main.py
│   ├── requirements.txt
│   └── data/
│       ├── team_profiles.json
│       └── historical_data.json
├── api-service/                # Service 2 — Node.js / Express
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js
└── frontend/                   # Service 3 — Nginx
    ├── Dockerfile
    ├── nginx.conf
    └── src/
        ├── index.html
        ├── app.js
        └── style.css
```
