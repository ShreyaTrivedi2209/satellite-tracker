"""
Satellite Position Server
=========================
  1. Fetches active TLE catalog from CelesTrak (2-line format)
  2. TLE → twoline2rv → sgp4 → eci_to_ecef for each satellite
  3. GET /api/satellites — all active satellites (ECEF state)
  4. GET /api/iss       — ISS detail (geodetic + ECI)

Run with:
    pip install -r requirements.txt
    python server.py
"""

import math
import datetime
import threading
import csv
import io
from math import pi, pow
from pathlib import Path

import requests
from flask import Flask, jsonify, redirect, request
from flask_cors import CORS
from sgp4.api import Satrec, WGS72, jday
from sgp4.ext import days2mdhms

# ─────────────────────────────────────────────
# Flask app setup
# ─────────────────────────────────────────────

app = Flask(__name__)
CORS(app)  # Allow requests from the Vite dev server

# ─────────────────────────────────────────────
# TLE sources
# ─────────────────────────────────────────────

ACTIVE_TLE_URLS = [
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
    "http://www.celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=2le",
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=2le",
    "http://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=2le",
]

SATCAT_URLS = [
    "https://celestrak.org/pub/satcat.csv",
    "https://www.celestrak.org/pub/satcat.csv",
]

LOCAL_ACTIVE_TLE = Path(__file__).parent / "data" / "active_2le.txt"
LOCAL_SATCAT_CSV = Path(__file__).parent / "data" / "satcat.csv"

_XPDOTP = 1440.0 / (2.0 * pi)

ISS_TLE_URLS = [
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle",
    "https://celestrak.org/NORAD/elements/stations.txt",
    "https://celestrak.org/pub/TLE/stations.txt",
]

# Used when CelesTrak is unreachable (offline / firewall)
FALLBACK_ISS_TLE = (
    "1 25544U 98067A   25295.51782528 -.00000086  00000-0  67964-4 0  9998",
    "2 25544  51.6346 114.1063 0001012 238.1718 121.9038 15.50274552  5775",
)

_tle_cache = {"line1": None, "line2": None, "fetched_at": None, "refreshing": False}
_active_cache = {
    "tles": None,
    "fetched_at": None,
    "loaded_at": None,
    "refreshing": False,
    "source": None,
    "source_status": "unknown",
}
_satcat_cache = {"meta": None, "fetched_at": None, "refreshing": False}
_prop_cache = {"payload": None, "fetched_at": None}
_cache_lock = threading.Lock()
TLE_REFRESH_SECONDS = 600  # 10 minutes
PROP_CACHE_SECONDS = 1
TLE_REQUEST_TIMEOUT = 15


def utc_now() -> datetime.datetime:
    """Return a timezone-aware UTC timestamp."""
    return datetime.datetime.now(datetime.timezone.utc)


def iso_or_none(value: datetime.datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def tle_epoch_to_utc(epoch: str) -> datetime.datetime | None:
    """Convert a TLE epoch like 26166.12345678 to a UTC datetime."""
    try:
      year2 = int(epoch[:2])
      year = year2 + 2000 if year2 < 57 else year2 + 1900
      day_of_year = float(epoch[2:])
      return (
          datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc)
          + datetime.timedelta(days=day_of_year - 1)
      )
    except Exception:
      return None


def fetch_iss_tle() -> tuple[str, str]:
    """
    Download the ISS TLE from CelesTrak.
    Returns (line1, line2).
    """
    last_err = None
    for url in ISS_TLE_URLS:
        try:
            print(f"[TLE] Fetching from {url}")
            r = requests.get(url, timeout=TLE_REQUEST_TIMEOUT)
            r.raise_for_status()
            lines = [l.strip() for l in r.text.strip().splitlines() if l.strip()]

            # Find the ISS block
            for i, line in enumerate(lines):
                if "ISS" in line.upper() or "ZARYA" in line.upper():
                    if i + 2 < len(lines):
                        l1, l2 = lines[i + 1], lines[i + 2]
                        if l1.startswith("1") and l2.startswith("2"):
                            print(f"[TLE] Found ISS: {line}")
                            return l1, l2

                # Also handle files that start directly with TLE lines
                if line.startswith("1 25544"):
                    if i + 1 < len(lines) and lines[i + 1].startswith("2 25544"):
                        return line, lines[i + 1]

            # If no name header, try first 3-line set
            if len(lines) >= 3 and lines[1].startswith("1") and lines[2].startswith("2"):
                return lines[1], lines[2]

        except Exception as e:
            print(f"[TLE] Failed ({url}): {e}")
            last_err = e

    local_iss = _load_local_iss_tle()
    if local_iss != FALLBACK_ISS_TLE:
        print(f"[TLE] All ISS sources failed, using local active catalog: {last_err}")
        return local_iss

    print(f"[TLE] All ISS sources failed, using embedded fallback: {last_err}")
    return FALLBACK_ISS_TLE


def _refresh_tle_background():
    try:
        line1, line2 = fetch_iss_tle()
        with _cache_lock:
            _tle_cache["line1"] = line1
            _tle_cache["line2"] = line2
            _tle_cache["fetched_at"] = utc_now()
            print(f"[TLE] Cache refreshed at {_tle_cache['fetched_at'].isoformat()}Z")
    finally:
        with _cache_lock:
            _tle_cache["refreshing"] = False


def _schedule_tle_refresh_if_stale():
    now = utc_now()
    stale = (
        _tle_cache["fetched_at"] is None
        or (now - _tle_cache["fetched_at"]).total_seconds() > TLE_REFRESH_SECONDS
    )
    if stale and not _tle_cache["refreshing"]:
        _tle_cache["refreshing"] = True
        threading.Thread(target=_refresh_tle_background, daemon=True).start()


def get_cached_tle() -> tuple[str, str]:
    """Return cached TLE immediately; refresh in background when stale."""
    with _cache_lock:
        cached_line1 = _tle_cache["line1"]
        cached_line2 = _tle_cache["line2"]

    if cached_line1 is not None and cached_line2 is not None:
        _schedule_tle_refresh_if_stale()
        return cached_line1, cached_line2

    try:
        line1, line2 = fetch_iss_tle()
        fetched_at = utc_now()
    except Exception as e:
        print(f"[TLE] Initial ISS fetch failed, using embedded fallback: {e}")
        line1, line2 = FALLBACK_ISS_TLE
        fetched_at = None

    with _cache_lock:
        _tle_cache["line1"] = line1
        _tle_cache["line2"] = line2
        _tle_cache["fetched_at"] = fetched_at
        _schedule_tle_refresh_if_stale()
        return _tle_cache["line1"], _tle_cache["line2"]


def parse_tle_fields(line1: str, line2: str) -> dict:
    """Parse stable orbital/filter fields from a 2LE pair."""
    p1, p2 = line1.split(), line2.split()
    norad = p1[1][:-1].zfill(5)
    int_designator = p1[2] if len(p1) > 2 else ""
    bstar_m, bstar_e = _parse_gp_sci(p1[6]) if len(p1) > 6 else (0.0, 0)

    return {
        "norad": norad,
        "object_id": int_designator,
        "epoch": p1[3] if len(p1) > 3 else "",
        "bstar": bstar_m * pow(10, bstar_e),
        "inclination": float(p2[2]),
        "raan": float(p2[3]),
        "eccentricity": int(p2[4]) * 1e-7,
        "arg_perigee": float(p2[5]),
        "mean_anomaly": float(p2[6]),
        "mean_motion": float(p2[7]),
    }


def parse_2le_catalog(text: str) -> dict[str, dict]:
    """Parse CelesTrak 2LE/3LE text into {norad_id: satellite metadata}."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    catalog = {}

    i = 0
    while i < len(lines) - 1:
        name = None
        if (
            i < len(lines) - 2
            and not lines[i].startswith(("1 ", "2 "))
            and lines[i + 1].startswith("1")
            and lines[i + 2].startswith("2")
        ):
            name = lines[i]
            i += 1

        line1, line2 = lines[i], lines[i + 1]
        if line1.startswith("1") and line2.startswith("2"):
            norad = line1[2:7].strip()
            fields = parse_tle_fields(line1, line2)
            catalog[norad] = {
                "line1": line1,
                "line2": line2,
                "name": name or f"NORAD {norad}",
                **fields,
            }
            i += 2
        else:
            i += 1

    return catalog


def parse_satcat_csv(text: str) -> dict[str, dict]:
    rows = csv.DictReader(io.StringIO(text))
    meta = {}
    for row in rows:
        norad = (row.get("NORAD_CAT_ID") or row.get("CATNR") or "").strip()
        if not norad:
            continue
        meta[norad.zfill(5)] = {
            "name": (row.get("OBJECT_NAME") or "").strip(),
            "country": (row.get("OWNER") or row.get("COUNTRY") or "").strip() or "Unknown",
            "object_type": (row.get("OBJECT_TYPE") or "").strip(),
            "launch_date": (row.get("LAUNCH_DATE") or "").strip(),
            "launch_site": (row.get("LAUNCH_SITE") or "").strip(),
        }
    return meta


def fetch_satcat_meta() -> dict[str, dict]:
    last_err = None
    for url in SATCAT_URLS:
        try:
            print(f"[SATCAT] Fetching satellite metadata from {url}")
            r = requests.get(url, timeout=TLE_REQUEST_TIMEOUT)
            r.raise_for_status()
            meta = parse_satcat_csv(r.text)
            if meta:
                LOCAL_SATCAT_CSV.parent.mkdir(parents=True, exist_ok=True)
                LOCAL_SATCAT_CSV.write_text(r.text, encoding="utf-8")
                return meta
        except Exception as e:
            print(f"[SATCAT] Failed ({url}): {e}")
            last_err = e

    if LOCAL_SATCAT_CSV.is_file():
        print(f"[SATCAT] Using local fallback {LOCAL_SATCAT_CSV}")
        meta = parse_satcat_csv(LOCAL_SATCAT_CSV.read_text(encoding="utf-8"))
        if meta:
            return meta

    print(f"[SATCAT] Metadata unavailable; country filters will use Unknown: {last_err}")
    return {}


def fetch_active_tles() -> tuple[dict[str, dict], str]:
    last_err = None
    for url in ACTIVE_TLE_URLS:
        try:
            print(f"[TLE] Fetching active catalog from {url}")
            r = requests.get(url, timeout=TLE_REQUEST_TIMEOUT)
            r.raise_for_status()
            catalog = parse_2le_catalog(r.text)
            if catalog:
                print(f"[TLE] Loaded {len(catalog)} active satellites")
                LOCAL_ACTIVE_TLE.parent.mkdir(parents=True, exist_ok=True)
                LOCAL_ACTIVE_TLE.write_text(r.text, encoding="utf-8")
                return catalog, url
        except Exception as e:
            print(f"[TLE] Failed ({url}): {e}")
            last_err = e

    if LOCAL_ACTIVE_TLE.is_file():
        print(f"[TLE] Using local fallback {LOCAL_ACTIVE_TLE}")
        catalog = parse_2le_catalog(LOCAL_ACTIVE_TLE.read_text(encoding="utf-8"))
        if catalog:
            return catalog, str(LOCAL_ACTIVE_TLE)

    raise ConnectionError(f"Could not fetch active TLE catalog: {last_err}")


def _refresh_satcat_background():
    try:
        meta = fetch_satcat_meta()
        with _cache_lock:
            _satcat_cache["meta"] = meta
            _satcat_cache["fetched_at"] = utc_now()
            _prop_cache["payload"] = None
    finally:
        with _cache_lock:
            _satcat_cache["refreshing"] = False


def _schedule_satcat_refresh_if_stale():
    now = utc_now()
    stale = (
        _satcat_cache["meta"] is None
        or _satcat_cache["fetched_at"] is None
        or (now - _satcat_cache["fetched_at"]).total_seconds() > TLE_REFRESH_SECONDS
    )
    if stale and not _satcat_cache["refreshing"]:
        _satcat_cache["refreshing"] = True
        threading.Thread(target=_refresh_satcat_background, daemon=True).start()


def get_satcat_meta() -> dict[str, dict]:
    with _cache_lock:
        if _satcat_cache["meta"] is None:
            _satcat_cache["meta"] = {}
            _satcat_cache["fetched_at"] = utc_now()
            _schedule_satcat_refresh_if_stale()
            return _satcat_cache["meta"]

        _schedule_satcat_refresh_if_stale()
        return _satcat_cache["meta"]


def _refresh_active_background():
    try:
        catalog, source = fetch_active_tles()
        with _cache_lock:
            _active_cache["tles"] = catalog
            _active_cache["fetched_at"] = utc_now()
            _active_cache["loaded_at"] = _active_cache["fetched_at"]
            _active_cache["source"] = source
            _active_cache["source_status"] = "celestrak" if source.startswith("http") else "local-fallback"
            _prop_cache["payload"] = None
    except Exception as e:
        print(f"[TLE] Active catalog refresh failed: {e}")
    finally:
        with _cache_lock:
            _active_cache["refreshing"] = False


def _schedule_active_refresh_if_stale():
    now = utc_now()
    stale = (
        _active_cache["tles"] is None
        or _active_cache["fetched_at"] is None
        or (now - _active_cache["fetched_at"]).total_seconds() > TLE_REFRESH_SECONDS
    )
    if stale and not _active_cache["refreshing"]:
        _active_cache["refreshing"] = True
        threading.Thread(target=_refresh_active_background, daemon=True).start()


def _load_local_active_catalog() -> dict[str, dict]:
    if LOCAL_ACTIVE_TLE.is_file():
        catalog = parse_2le_catalog(LOCAL_ACTIVE_TLE.read_text(encoding="utf-8"))
        if catalog:
            return catalog
    line1, line2 = FALLBACK_ISS_TLE
    return {
        "25544": {
            "line1": line1,
            "line2": line2,
            "name": "ISS (ZARYA)",
            **parse_tle_fields(line1, line2),
        }
    }


def _load_local_iss_tle() -> tuple[str, str]:
    if LOCAL_ACTIVE_TLE.is_file():
        try:
            catalog = parse_2le_catalog(LOCAL_ACTIVE_TLE.read_text(encoding="utf-8"))
            iss = catalog.get("25544")
            if iss:
                return iss["line1"], iss["line2"]
        except Exception as e:
            print(f"[TLE] Could not read local ISS TLE: {e}")
    return FALLBACK_ISS_TLE


def get_active_catalog() -> dict[str, dict]:
    with _cache_lock:
        cached_tles = _active_cache["tles"]
        if cached_tles is not None and _active_cache["source"] is None:
            _active_cache["source"] = str(LOCAL_ACTIVE_TLE) if LOCAL_ACTIVE_TLE.is_file() else "embedded ISS fallback"
            _active_cache["source_status"] = "local-fallback"
            _active_cache["loaded_at"] = utc_now()

    if cached_tles is not None:
        _schedule_active_refresh_if_stale()
        return cached_tles

    try:
        catalog, source = fetch_active_tles()
        fetched_at = utc_now()
        source_status = "celestrak" if source.startswith("http") else "local-fallback"
    except Exception as e:
        print(f"[TLE] Initial active catalog fetch failed, using local fallback: {e}")
        catalog = _load_local_active_catalog()
        fetched_at = None
        source = str(LOCAL_ACTIVE_TLE) if LOCAL_ACTIVE_TLE.is_file() else "embedded ISS fallback"
        source_status = "local-fallback"

    with _cache_lock:
        _active_cache["tles"] = catalog
        _active_cache["fetched_at"] = fetched_at
        _active_cache["loaded_at"] = fetched_at or utc_now()
        _active_cache["source"] = source
        _active_cache["source_status"] = source_status
        _prop_cache["payload"] = None
        _schedule_active_refresh_if_stale()
        return _active_cache["tles"]


def propagate_to_ecef(line1: str, line2: str, t_utc: datetime.datetime, gmst: float):
    pos_eci, vel_eci = propagate_sgp4(line1, line2, t_utc)
    pos_ecef, vel_ecef = eci_to_ecef(pos_eci, vel_eci, gmst)
    return pos_eci, vel_eci, pos_ecef, vel_ecef


# ─────────────────────────────────────────────
# STEP 2: SGP4 Propagation → ECI
# ─────────────────────────────────────────────

def _parse_gp_sci(field: str) -> tuple[float, int]:
    """Parse CelesTrak GP fields like 51824-3 or 00000+0."""
    field = field.strip()
    if field in ("0", "00000+0", "00000-0"):
        return 0.0, 0

    sign = 1
    if field.startswith("-"):
        sign = -1
        field = field[1:]
    elif field.startswith("+"):
        field = field[1:]

    for i in range(len(field) - 1, 0, -1):
        if field[i] in "+-":
            mantissa = sign * float("0." + field[:i])
            return mantissa, int(field[i:])

    return float(field), 0


def gp2le_to_satrec(line1: str, line2: str) -> Satrec:
    """
    Build a Satrec from CelesTrak GP 2LE (space-delimited, not punch-card strict).
    """
    p1, p2 = line1.split(), line2.split()
    satnum_str = p1[1][:-1].zfill(5)

    two_digit_year = int(p1[3][:2])
    epochdays = float(p1[3][2:])
    ndot = float(p1[4]) / (_XPDOTP * 1440.0)

    nddot_m, nddot_e = _parse_gp_sci(p1[5])
    bstar_m, bstar_e = _parse_gp_sci(p1[6])
    nddot = nddot_m * pow(10, nddot_e) / (_XPDOTP * 1440.0 * 1440.0)
    bstar = bstar_m * pow(10, bstar_e)

    inclo = float(p2[2]) * pi / 180.0
    nodeo = float(p2[3]) * pi / 180.0
    ecco = int(p2[4]) * 1e-7
    argpo = float(p2[5]) * pi / 180.0
    mo = float(p2[6]) * pi / 180.0
    no_kozai = float(p2[7]) / _XPDOTP

    year = two_digit_year + 2000 if two_digit_year < 57 else two_digit_year + 1900
    mon, day, hr, minute, sec = days2mdhms(year, epochdays)
    jd, fr = jday(year, mon, day, hr, minute, sec)
    epoch = jd + fr - 2433281.5

    satrec = Satrec()
    satrec.sgp4init(
        WGS72, "i", satnum_str, epoch,
        bstar, ndot, nddot, ecco, argpo, inclo, mo, no_kozai, nodeo,
    )
    return satrec


def propagate_sgp4(line1: str, line2: str, t: datetime.datetime):
    """
    Runs SGP4 for the given TLE at UTC time t.
    Returns: (pos_eci_km, vel_eci_km_s) — both are (x, y, z) tuples
    """
    try:
        satrec = Satrec.twoline2rv(line1, line2)
    except ValueError:
        satrec = gp2le_to_satrec(line1, line2)

    jd, fr = jday(
        t.year, t.month, t.day,
        t.hour, t.minute, t.second + t.microsecond / 1_000_000
    )

    error, pos_eci, vel_eci = satrec.sgp4(jd, fr)

    if error != 0:
        raise RuntimeError(f"SGP4 error code {error}")

    return pos_eci, vel_eci


# ─────────────────────────────────────────────
# STEP 3: ECI → ECEF via GMST rotation
# ─────────────────────────────────────────────

def gmst_angle(t: datetime.datetime) -> float:
    """
    Computes Greenwich Mean Sidereal Time in radians for UTC time t.
    """
    jd, fr = jday(t.year, t.month, t.day,
                  t.hour, t.minute, t.second + t.microsecond / 1_000_000)

    days_since_j2000 = jd + fr - 2451545.0
    T = days_since_j2000 / 36525.0
    theta = (
        280.46061837
        + 360.98564736629 * days_since_j2000
        + 0.000387933 * T ** 2
        - T ** 3 / 38710000.0
    ) % 360.0
    return math.radians(theta)


def eci_to_ecef(pos_eci: tuple, vel_eci: tuple, gmst: float):
    """
    Rotates position and velocity from ECI (TEME) to ECEF frame.
    ECEF = Rz(-GMST) × ECI_pos
    Vel_ECEF = Rz(-GMST) × ECI_vel  −  ω × ECEF_pos
    """
    cos_g, sin_g = math.cos(gmst), math.sin(gmst)
    x, y, z = pos_eci
    vx, vy, vz = vel_eci

    px = cos_g * x + sin_g * y
    py = -sin_g * x + cos_g * y
    pz = z

    rvx = cos_g * vx + sin_g * vy
    rvy = -sin_g * vx + cos_g * vy
    rvz = vz

    omega = 7.2921150e-5          # Earth rotation rate, rad/s
    v_ecef = (
        rvx + omega * py,
        rvy - omega * px,
        rvz,
    )

    return (float(px), float(py), float(pz)), tuple(float(value) for value in v_ecef)


# ─────────────────────────────────────────────
# STEP 4: ECEF → Geodetic (WGS84 Bowring)
# ─────────────────────────────────────────────

def ecef_to_geodetic(x: float, y: float, z: float):
    """
    Converts ECEF (km) to Geodetic (degrees lat, degrees lon, km altitude).
    Uses Bowring iterative method on WGS84 ellipsoid.
    """
    a   = 6378.137          # semi-major axis, km
    f   = 1 / 298.257223563
    b   = a * (1 - f)       # semi-minor axis
    e2  = 2 * f - f ** 2    # eccentricity²

    lon = math.atan2(y, x)

    p   = math.sqrt(x ** 2 + y ** 2)
    lat = math.atan2(z, p * (1 - e2))

    for _ in range(10):
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1 - e2 * sin_lat ** 2)
        lat_new = math.atan2(z + e2 * N * sin_lat, p)
        if abs(lat_new - lat) < 1e-12:
            break
        lat = lat_new

    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    N = a / math.sqrt(1 - e2 * sin_lat ** 2)

    if abs(cos_lat) > 1e-10:
        alt = p / cos_lat - N
    else:
        alt = abs(z) / abs(sin_lat) - N * (1 - e2)

    return math.degrees(lat), math.degrees(lon), alt


# ─────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────

def _propagate_catalog(catalog: dict[str, dict]):
    now = utc_now()
    satcat_meta = get_satcat_meta()
    with _cache_lock:
        tle_fetched_at = _active_cache["fetched_at"]
        catalog_loaded_at = _active_cache["loaded_at"]
        tle_source = _active_cache["source"]
        tle_source_status = _active_cache["source_status"]
        if (
            _prop_cache["payload"] is not None
            and _prop_cache["fetched_at"] is not None
            and (now - _prop_cache["fetched_at"]).total_seconds() < PROP_CACHE_SECONDS
            and _prop_cache["payload"]["catalog"] == len(catalog)
        ):
            return _prop_cache["payload"]

    t_utc = now
    gmst = gmst_angle(t_utc)

    ids = []
    names = []
    countries = []
    object_ids = []
    object_types = []
    launch_dates = []
    launch_sites = []
    inclinations = []
    raan = []
    eccentricities = []
    arg_perigee = []
    mean_anomaly = []
    mean_motion = []
    bstar = []
    epoch_utc = []
    eci = []
    ecef = []
    skipped = 0

    for norad, sat in catalog.items():
        line1, line2 = sat["line1"], sat["line2"]
        try:
            pos_eci, vel_eci, pos, vel = propagate_to_ecef(line1, line2, t_utc, gmst)
        except Exception:
            skipped += 1
            continue
        meta = satcat_meta.get(norad, {})
        tle_name = sat.get("name") or ""
        meta_name = meta.get("name") or ""
        display_name = tle_name if tle_name and not tle_name.startswith("NORAD ") else meta_name or tle_name or f"NORAD {norad}"
        ids.append(norad)
        names.append(display_name)
        countries.append(meta.get("country") or "Unknown")
        object_ids.append(sat.get("object_id") or "")
        object_types.append(meta.get("object_type") or "")
        launch_dates.append(meta.get("launch_date") or "")
        launch_sites.append(meta.get("launch_site") or "")
        inclinations.append(sat["inclination"])
        raan.append(sat["raan"])
        eccentricities.append(sat["eccentricity"])
        arg_perigee.append(sat["arg_perigee"])
        mean_anomaly.append(sat["mean_anomaly"])
        mean_motion.append(sat["mean_motion"])
        bstar.append(sat["bstar"])
        epoch_utc.append(iso_or_none(tle_epoch_to_utc(sat.get("epoch", ""))))
        eci.extend([*pos_eci, *vel_eci])
        ecef.extend([*pos, *vel])

    payload = {
        "timestamp_utc": t_utc.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "source": ACTIVE_TLE_URLS[0],
        "tle_source": tle_source,
        "tle_source_status": tle_source_status,
        "catalog_loaded_at_utc": iso_or_none(catalog_loaded_at),
        "celestrak_fetched_at_utc": iso_or_none(tle_fetched_at) if tle_source_status == "celestrak" else None,
        "gmst_rad": gmst,
        "catalog": len(catalog),
        "propagated": len(ids),
        "skipped": skipped,
        "ids": ids,
        "names": names,
        "countries": countries,
        "object_ids": object_ids,
        "object_types": object_types,
        "launch_dates": launch_dates,
        "launch_sites": launch_sites,
        "inclinations": inclinations,
        "raan": raan,
        "eccentricities": eccentricities,
        "arg_perigee": arg_perigee,
        "mean_anomaly": mean_anomaly,
        "mean_motion": mean_motion,
        "bstar": bstar,
        "epoch_utc": epoch_utc,
        "eci": eci,
        "ecef": ecef,
    }

    with _cache_lock:
        _prop_cache["payload"] = payload
        _prop_cache["fetched_at"] = now

    return payload


@app.route("/api/satellites", methods=["GET", "POST"])
def satellites_positions():
    """
    Propagate all active satellites from CelesTrak GP 2LE catalog.

    GET  — use cached / fetched catalog
    POST — body is raw 2LE text (e.g. from CelesTrak via browser proxy)
    """
    try:
        if request.method == "POST":
            text = request.get_data(as_text=True)
            catalog = parse_2le_catalog(text)
            if not catalog:
                return jsonify({"error": "No valid 2LE pairs in request body"}), 400
            with _cache_lock:
                _active_cache["tles"] = catalog
                _active_cache["fetched_at"] = utc_now()
                _active_cache["loaded_at"] = _active_cache["fetched_at"]
                _active_cache["source"] = "browser CelesTrak proxy"
                _active_cache["source_status"] = "celestrak"
                _prop_cache["payload"] = None
        else:
            catalog = get_active_catalog()

        return jsonify(_propagate_catalog(catalog))

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/", methods=["GET"])
def root():
    """Send humans to the frontend instead of showing a Flask 404."""
    return redirect("http://127.0.0.1:5180/", code=302)


@app.route("/api/iss", methods=["GET"])
def iss_position():
    """
    Returns current ISS position via the full SGP4 pipeline.

    JSON response:
    {
      "name": "ISS (ZARYA)",
      "timestamp_utc": "2026-06-11T10:58:00.000Z",
      "eci":  { "x": ..., "y": ..., "z": ..., "vx": ..., "vy": ..., "vz": ... },
      "ecef": { "x": ..., "y": ..., "z": ..., "vx": ..., "vy": ..., "vz": ... },
      "geodetic": { "lat": ..., "lon": ..., "alt_km": ... },
      "speed_km_s": ...
    }
    """
    try:
        # 1. Get TLE (from cache or fresh fetch)
        line1, line2 = get_cached_tle()

        # 2. Current UTC time
        t_utc = utc_now()

        # 3. SGP4 → ECI
        pos_eci, vel_eci = propagate_sgp4(line1, line2, t_utc)

        # 4. ECI → ECEF
        gmst = gmst_angle(t_utc)
        pos_ecef, vel_ecef = eci_to_ecef(pos_eci, vel_eci, gmst)

        # 5. ECEF → Geodetic
        lat, lon, alt = ecef_to_geodetic(*pos_ecef)

        speed = math.sqrt(sum(v ** 2 for v in vel_eci))

        return jsonify({
            "name": "ISS (ZARYA)",
            "timestamp_utc": t_utc.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "eci": {
                "x": pos_eci[0], "y": pos_eci[1], "z": pos_eci[2],
                "vx": vel_eci[0], "vy": vel_eci[1], "vz": vel_eci[2],
            },
            "ecef": {
                "x": pos_ecef[0], "y": pos_ecef[1], "z": pos_ecef[2],
                "vx": vel_ecef[0], "vy": vel_ecef[1], "vz": vel_ecef[2],
            },
            "geodetic": {
                "lat": lat,
                "lon": lon,
                "alt_km": alt,
            },
            "speed_km_s": speed,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  Satellite Position Server")
    print("  http://localhost:5000/api/satellites")
    print("  http://localhost:5000/api/iss")
    print("=" * 50)
    with _cache_lock:
        _active_cache["tles"] = _load_local_active_catalog()
        _active_cache["fetched_at"] = None
        _active_cache["loaded_at"] = utc_now()
        _active_cache["source"] = str(LOCAL_ACTIVE_TLE) if LOCAL_ACTIVE_TLE.is_file() else "embedded ISS fallback"
        _active_cache["source_status"] = "local-fallback"
        _tle_cache["line1"], _tle_cache["line2"] = _load_local_iss_tle()
        _tle_cache["fetched_at"] = None
    _schedule_active_refresh_if_stale()
    _schedule_tle_refresh_if_stale()
    _schedule_satcat_refresh_if_stale()

    app.run(host="0.0.0.0", port=5000, debug=False)
