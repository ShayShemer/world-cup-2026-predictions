"""
stats-service v3 — Advanced match prediction engine.

Factors (weighted):
  1. Head-to-head history        20%
  2. Recent form (last 5 games)  30%
  3. Attack/defense strength     25%
  4. FIFA ranking                15%
  5. Missing key players         10%

Outputs:
  - 90-minute predicted score + probability grid
  - Extra time prediction (if draw)
  - Penalty shootout winner (if ET also draw)
  - Recent H2H matches (last 5 years)
"""

import json, os, math, logging
from datetime import datetime
from itertools import product
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Suppress /health endpoint from access logs (stops flooding the terminal)
class _HealthFilter(logging.Filter):
    def filter(self, record):
        return "GET /health" not in record.getMessage()

logging.getLogger("uvicorn.access").addFilter(_HealthFilter())

app = FastAPI(title="Stats Service v3", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BASE = os.path.dirname(__file__)

with open(os.path.join(BASE, "data", "historical_data.json"), encoding="utf-8") as f:
    HIST = json.load(f)

with open(os.path.join(BASE, "data", "team_profiles.json"), encoding="utf-8") as f:
    PROFILES = json.load(f)["teams"]

CURRENT_YEAR = datetime.now().year


# ─── Request model ────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    team1: str
    team2: str
    team1_missing: list[str] = []
    team2_missing: list[str] = []


# ─── Poisson ─────────────────────────────────────────────────────────────────

def poisson_pmf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def score_probability_grid(lam1: float, lam2: float, max_g: int = 6) -> list[dict]:
    """Return all (score, probability) pairs sorted by probability desc."""
    grid = []
    for g1, g2 in product(range(max_g + 1), repeat=2):
        p = poisson_pmf(g1, lam1) * poisson_pmf(g2, lam2)
        grid.append({"score": f"{g1}-{g2}", "team1_goals": g1, "team2_goals": g2, "probability": round(p, 4)})
    grid.sort(key=lambda x: x["probability"], reverse=True)
    return grid[:15]  # top 15 most likely scorelines


def most_likely_score(lam1: float, lam2: float, max_g: int = 8) -> tuple[int, int, float]:
    best_p, best = -1, (round(lam1), round(lam2))
    for g1, g2 in product(range(max_g + 1), repeat=2):
        p = poisson_pmf(g1, lam1) * poisson_pmf(g2, lam2)
        if p > best_p:
            best_p, best = p, (g1, g2)
    return best[0], best[1], best_p


# ─── Factor 1: Head-to-head ───────────────────────────────────────────────────

def h2h_factor(team1: str, team2: str) -> tuple[float, float, dict]:
    t1, t2 = team1.lower(), team2.lower()
    matches = []

    for m in HIST["matches"]:
        m1, m2 = m["team1"].lower(), m["team2"].lower()
        if m1 == t1 and m2 == t2:
            matches.append({"g1": m["score1"], "g2": m["score2"], "year": m["year"], "comp": m["competition"]})
        elif m1 == t2 and m2 == t1:
            matches.append({"g1": m["score2"], "g2": m["score1"], "year": m["year"], "comp": m["competition"]})

    if not matches:
        return 0.0, 0.0, {}

    matches.sort(key=lambda x: x["year"], reverse=True)

    wins1 = draws = wins2 = 0
    wg1 = wg2 = total_w = 0.0

    for i, m in enumerate(matches):
        w = math.exp(-0.2 * i)
        total_w += w
        wg1 += w * m["g1"]
        wg2 += w * m["g2"]
        if m["g1"] > m["g2"]: wins1 += 1
        elif m["g2"] > m["g1"]: wins2 += 1
        else: draws += 1

    # Recent matches = last 5 years only
    recent_5yr = [m for m in matches if m["year"] >= CURRENT_YEAR - 5][:3]

    return wg1 / total_w, wg2 / total_w, {
        "total": len(matches), "wins1": wins1, "draws": draws, "wins2": wins2,
        "avg_g1": round(wg1 / total_w, 2), "avg_g2": round(wg2 / total_w, 2),
        "recent_matches": recent_5yr,
    }


# ─── Factor 2: Form ───────────────────────────────────────────────────────────

FORM_PTS = {"W": 3, "D": 1, "L": 0}

def form_factor(team: str) -> float:
    form = PROFILES.get(team, {}).get("recent_form", [])
    if not form: return 0.5
    wpts = tw = 0.0
    for i, r in enumerate(form):
        w = math.exp(-0.3 * i)
        wpts += w * FORM_PTS.get(r, 1)
        tw += w
    return (wpts / tw) / 3.0


# ─── Factor 3: Attack / Defense strength ─────────────────────────────────────

def attack_defense_factor(team1: str, team2: str) -> tuple[float, float]:
    p1 = PROFILES.get(team1, {})
    p2 = PROFILES.get(team2, {})
    ratio1 = p1.get("attack_rating", 7.0) / p2.get("defense_rating", 7.0)
    ratio2 = p2.get("attack_rating", 7.0) / p1.get("defense_rating", 7.0)
    return p1.get("avg_goals_scored", 1.5) * ratio1, p2.get("avg_goals_scored", 1.5) * ratio2


# ─── Factor 4: FIFA ranking ───────────────────────────────────────────────────

def ranking_factor(team1: str, team2: str) -> tuple[float, float]:
    r1 = PROFILES.get(team1, {}).get("fifa_ranking", 50)
    r2 = PROFILES.get(team2, {}).get("fifa_ranking", 50)
    norm1 = max(0, (50 - r1) / 49)
    norm2 = max(0, (50 - r2) / 49)
    mod = (norm1 - norm2) * 0.4
    return mod, -mod


# ─── Factor 5: Missing players ────────────────────────────────────────────────

def missing_players_factor(team: str, missing_names: list[str]) -> tuple[float, float, list]:
    profile = PROFILES.get(team, {})
    player_map = {p["name"].lower(): p for p in profile.get("key_players", [])}
    atk_pen = def_pen = 0.0
    info = []

    for name in missing_names:
        p = player_map.get(name.lower())
        if not p: continue
        sev = (p["impact"] - 6.0) / 4.0
        if p["position"] == "FW":    atk_pen += sev * 0.5
        elif p["position"] in ("GK","DF"): def_pen += sev * 0.4
        elif p["position"] == "MF":  atk_pen += sev * 0.25; def_pen += sev * 0.15
        info.append(f"{p['name']} ({p['position']}, impact {p['impact']})")

    return atk_pen, def_pen, info


# ─── Combine all factors ─────────────────────────────────────────────────────

WEIGHTS = {"h2h": 0.20, "form": 0.30, "strength": 0.25, "ranking": 0.15, "players": 0.10}

def compute_xg(team1, team2, missing1, missing2):
    h2h_g1, h2h_g2, h2h_summary = h2h_factor(team1, team2)
    form1, form2 = form_factor(team1), form_factor(team2)
    fm1 = 0.7 + 0.6 * form1
    fm2 = 0.7 + 0.6 * form2
    str_g1, str_g2 = attack_defense_factor(team1, team2)
    rank_m1, rank_m2 = ranking_factor(team1, team2)
    ap1, dp1, mi1 = missing_players_factor(team1, missing1)
    ap2, dp2, mi2 = missing_players_factor(team2, missing2)

    if h2h_summary:
        xg1 = (WEIGHTS["strength"] * str_g1 + WEIGHTS["h2h"] * h2h_g1) / (WEIGHTS["strength"] + WEIGHTS["h2h"])
        xg2 = (WEIGHTS["strength"] * str_g2 + WEIGHTS["h2h"] * h2h_g2) / (WEIGHTS["strength"] + WEIGHTS["h2h"])
    else:
        xg1, xg2 = str_g1, str_g2

    xg1 = xg1 * (1 + WEIGHTS["form"] * (fm1 - 1))
    xg2 = xg2 * (1 + WEIGHTS["form"] * (fm2 - 1))
    xg1 += WEIGHTS["ranking"] * rank_m1
    xg2 += WEIGHTS["ranking"] * rank_m2
    xg1 = max(0.2, xg1 - WEIGHTS["players"] * ap1 * 10) + WEIGHTS["players"] * dp2 * 10
    xg2 = max(0.2, xg2 - WEIGHTS["players"] * ap2 * 10) + WEIGHTS["players"] * dp1 * 10

    factors = {
        "h2h": h2h_summary,
        "form": {
            team1: {"recent": PROFILES.get(team1, {}).get("recent_form", []), "score": round(form1, 2)},
            team2: {"recent": PROFILES.get(team2, {}).get("recent_form", []), "score": round(form2, 2)},
        },
        "strength": {"xg1_base": round(str_g1, 2), "xg2_base": round(str_g2, 2)},
        "ranking": {
            team1: PROFILES.get(team1, {}).get("fifa_ranking", "?"),
            team2: PROFILES.get(team2, {}).get("fifa_ranking", "?"),
        },
        "missing_players": {team1: mi1, team2: mi2},
    }
    return xg1, xg2, factors


# ─── Extra Time prediction ────────────────────────────────────────────────────

def predict_extra_time(team1: str, team2: str, xg1: float, xg2: float) -> dict:
    """
    Extra time = 30 minutes.
    Expected goals scale down (30/90 = 1/3) AND fatigue reduces scoring by ~30%.
    Both teams also become more defensive near the end.
    """
    ET_FACTOR = (30 / 90) * 0.65   # 0.217 — fatigue + defensive play

    et_xg1 = max(0.05, xg1 * ET_FACTOR)
    et_xg2 = max(0.05, xg2 * ET_FACTOR)

    et_s1, et_s2, et_conf = most_likely_score(et_xg1, et_xg2, max_g=4)

    if et_s1 != et_s2:
        # Decisive ET result
        return {
            "goes_to_et": True,
            "et_goals_added": {"team1": et_s1, "team2": et_s2},
            "goes_to_penalties": False,
            "penalties": None,
            "et_confidence": round(et_conf, 4),
        }
    else:
        # Still level after ET — penalties
        penalties = predict_penalties(team1, team2, xg1, xg2)
        return {
            "goes_to_et": True,
            "et_goals_added": {"team1": 0, "team2": 0},
            "goes_to_penalties": True,
            "penalties": penalties,
            "et_confidence": round(et_conf, 4),
        }


def predict_penalties(team1: str, team2: str, xg1: float, xg2: float) -> dict:
    """
    Penalty prediction: based on FIFA ranking + slight xG advantage.
    Penalties are close to 50/50, but small edges matter.
    """
    r1 = PROFILES.get(team1, {}).get("fifa_ranking", 50)
    r2 = PROFILES.get(team2, {}).get("fifa_ranking", 50)

    # Better ranked = slight edge
    rank_edge = (r2 - r1) / 100.0   # e.g. rank 5 vs rank 20 → 0.15 edge

    # xG edge — team that dominated more is slightly better under pressure
    xg_edge = (xg1 - xg2) / (xg1 + xg2 + 0.001) * 0.1

    # Base probability for team1 winning penalties
    p1_wins = 0.50 + rank_edge * 0.3 + xg_edge
    p1_wins = max(0.30, min(0.70, p1_wins))

    winner = team1 if p1_wins >= 0.50 else team2
    winner_prob = p1_wins if p1_wins >= 0.50 else 1 - p1_wins

    if winner_prob < 0.52:
        confidence_word = "too close to call"
    elif winner_prob < 0.58:
        confidence_word = "narrow edge"
    else:
        confidence_word = "slight favourite"

    return {
        "predicted_winner": winner,
        "probability": round(winner_prob, 2),
        "confidence_word": confidence_word,
        "explanation": (
            f"{winner} holds a {confidence_word} in a potential shootout "
            f"based on FIFA ranking (#{r1} vs #{r2}) and overall match dominance."
        ),
    }


# ─── Explanation builder ──────────────────────────────────────────────────────

def build_explanation(team1, team2, s1, s2, xg1, xg2, factors, confidence):
    h2h = factors["h2h"]
    form1 = factors["form"][team1]["score"]
    form2 = factors["form"][team2]["score"]
    mi1 = factors["missing_players"][team1]
    mi2 = factors["missing_players"][team2]

    if mi1 and any("FW" in m or "MF" in m for m in mi1):
        s1_txt = f"The absence of {', '.join(mi1[:2])} significantly weakens {team1}'s attack."
    elif mi2 and any("FW" in m or "MF" in m for m in mi2):
        s1_txt = f"The absence of {', '.join(mi2[:2])} significantly weakens {team2}'s attack."
    elif h2h and h2h.get("total", 0) >= 3:
        w1, w2, d = h2h["wins1"], h2h["wins2"], h2h["draws"]
        if w1 > w2:
            s1_txt = f"{team1} leads the historical head-to-head ({w1}W-{d}D-{w2}L), and their recent form score ({form1:.0%}) reinforces that advantage."
        elif w2 > w1:
            s1_txt = f"{team2} leads the historical head-to-head ({w2}W-{d}D-{w1}L), and their recent form score ({form2:.0%}) reinforces that edge."
        else:
            s1_txt = f"History is evenly split ({w1}W-{d}D-{w2}L), so current form becomes decisive: {team1} at {form1:.0%} vs {team2} at {form2:.0%}."
    elif abs(form1 - form2) > 0.15:
        better = team1 if form1 > form2 else team2
        s1_txt = f"{better} enters in noticeably better recent form ({max(form1,form2):.0%}), which is the main differentiator."
    else:
        r1 = factors["ranking"][team1]
        r2 = factors["ranking"][team2]
        s1_txt = f"With similar recent form, FIFA ranking ({team1} #{r1} vs {team2} #{r2}) and attack/defense ratings tip the scales."

    conf_word = "comfortably" if confidence > 0.12 else "narrowly"
    if s1 > s2:   s2_txt = f"The model predicts {team1} {conf_word} wins {s1}-{s2} (confidence: {confidence:.1%})."
    elif s2 > s1: s2_txt = f"The model predicts {team2} {conf_word} wins {s2}-{s1} (confidence: {confidence:.1%})."
    else:         s2_txt = f"The model expects a tight {s1}-{s2} draw (confidence: {confidence:.1%})."

    return f"{s1_txt} {s2_txt}"


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "stats-service", "version": "3.0"}


@app.get("/teams")
def get_teams():
    return {
        "teams": list(PROFILES.keys()),
        "profiles": {
            name: {
                "fifa_ranking": p["fifa_ranking"],
                "recent_form": p["recent_form"],
                "key_players": p["key_players"],
            }
            for name, p in PROFILES.items()
        }
    }


@app.post("/predict")
def predict(req: PredictRequest):
    if req.team1 not in PROFILES or req.team2 not in PROFILES:
        unknown = [t for t in [req.team1, req.team2] if t not in PROFILES]
        raise HTTPException(status_code=404, detail=f"Unknown team(s): {unknown}")

    xg1, xg2, factors = compute_xg(req.team1, req.team2, req.team1_missing, req.team2_missing)
    s1, s2, confidence = most_likely_score(xg1, xg2)
    explanation = build_explanation(req.team1, req.team2, s1, s2, xg1, xg2, factors, confidence)
    grid = score_probability_grid(xg1, xg2)

    # Extra time only relevant if 90-min result is a draw (knockout stage)
    extra_time = None
    if s1 == s2:
        extra_time = predict_extra_time(req.team1, req.team2, xg1, xg2)

    return {
        "team1": req.team1,
        "team2": req.team2,
        "prediction": {"team1_score": s1, "team2_score": s2},
        "expected_goals": {"team1": round(xg1, 2), "team2": round(xg2, 2)},
        "confidence": round(confidence, 4),
        "explanation": explanation,
        "score_grid": grid,
        "extra_time": extra_time,
        "factors": factors,
    }


@app.get("/predict/{team1}/{team2}")
def predict_get(team1: str, team2: str):
    return predict(PredictRequest(team1=team1, team2=team2))
