# Python SGP4 Satellite Tracker

This folder contains the Flask API used by the 3D dashboard and a standalone
CLI utility for inspecting one satellite at a time.

## Install

From the repository root:

```bash
python -m pip install -r python/requirements.txt
```

## Start The API

From the repository root:

```bash
npm run api
```

Or directly from this folder:

```bash
python server.py
```

API endpoints:

```text
GET  http://127.0.0.1:5000/api/satellites
POST http://127.0.0.1:5000/api/satellites
GET  http://127.0.0.1:5000/api/iss
```

`GET /api/satellites` returns active satellite positions and metadata. `POST
/api/satellites` accepts raw TLE/2LE text and updates the active catalog.

## CLI Usage

```bash
cd python

# Track the ISS
python tracker.py

# Track a satellite by partial name
python tracker.py "hubble"
python tracker.py "NOAA 19"

# List available satellites
python tracker.py --list
```

## Pipeline

1. Download or load TLE data.
2. Parse TLE pairs with `sgp4`.
3. Propagate satellite state with SGP4 into TEME/ECI position and velocity.
4. Rotate into ECEF using GMST.
5. Convert ECEF to geodetic latitude, longitude, and altitude.
6. Return compact JSON for the Three.js frontend.
