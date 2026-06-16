# Satellite Tracker

Interactive 3D Earth dashboard for live satellite tracking from TLE/2LE data.
The frontend is built with Three.js and Vite. The backend uses Python, Flask,
and SGP4 to propagate satellite positions into Earth-fixed coordinates.

## Features

- Live 3D Earth view with active satellite markers
- 2D latitude/longitude map view
- Optional projected orbital paths
- SGP4 propagation from CelesTrak TLE data
- Search by satellite name, NORAD ID, or international designator
- Filter by country/owner metadata, altitude region, inclination,
  eccentricity, and mean motion
- Hover tooltip with satellite name, latitude, longitude, and altitude
- Updated CelesTrak cache in `python/data/updated data.txt`
- Offline fallback catalog in `python/data/active_2le.txt`

## Requirements

| Tool | Version |
| ---- | ------- |
| Node.js | 20.19 or newer; 24 LTS recommended |
| npm | 10 or newer |
| Python | 3.10 or newer recommended |
| pip | Latest available for your Python |

The Python API intentionally avoids NumPy and other compiled scientific
dependencies. A normal Windows Python install should be enough; GCC/C++ build
tools are not required for this project. `sgp4` is pinned to a release with
prebuilt wheels available through pip.

## Clone And Run

```bash
git clone https://github.com/ShreyaTrivedi2209/satellite-tracker.git
cd satellite-tracker
```

Install frontend dependencies from the lockfile:

```bash
npm ci
```

Install backend dependencies:

```bash
python -m pip install -r python/requirements.txt
```

Start the Python API in terminal 1:

```bash
npm run api
```

On Windows, if `python` is not on your PATH, use:

```bash
npm run api:windows
```

Start the Vite frontend in terminal 2:

```bash
npm run dev
```

`npm start` does the same thing as `npm run dev`.

Open the dashboard:

```text
http://127.0.0.1:5173/
```

The API runs at:

```text
http://127.0.0.1:5000/api/satellites
```

## Validate Before Pushing

```bash
npm run check
python -m pip download --only-binary=:all: --dest wheels-check -r python/requirements.txt
python -m py_compile python/server.py
```

Optional API smoke test after `npm run api` is running:

```bash
curl http://127.0.0.1:5000/api/satellites
```

## Project Structure

```text
.
  index.html              Browser shell
  main.js                 Three.js scene entry point
  style.css               Dashboard styles
  vite.config.js          Vite dev server and API proxy config
  package.json            Frontend scripts and dependencies
  package-lock.json       Locked frontend dependency versions
  public/textures/        Earth texture assets
  src/
    earth.js              Earth mesh and atmosphere
    satellites.js         Satellite fetch, filtering, plotting, hover logic
    getStarfield.js       Background starfield
    getFresnelMat.js      Atmosphere shader material
  python/
    server.py             Flask API for propagated satellite positions
    tracker.py            CLI tracker utility
    requirements.txt      Python dependencies
    data/updated data.txt Most recent CelesTrak TLE catalog cached by the app
    data/active_2le.txt   Older offline fallback TLE catalog
```

Generated folders and local runtime files are intentionally ignored by Git:
`node_modules/`, `dist/`, Python caches, virtual environments, `.env*`, and
local logs.

## Notes On Accuracy

The backend propagates TLE data with SGP4 and returns ECEF positions. The
frontend maps those Earth-fixed coordinates onto the globe with a shared
coordinate transform so marker positions stay aligned with the Earth texture.
Country/owner is not stored in TLE lines, so the app uses CelesTrak SATCAT
metadata when available and shows `Unknown` when that metadata cannot be
fetched.

## Troubleshooting
- If `npm run dev` fails on Windows PowerShell because scripts are disabled,
  run `npm.cmd run dev` instead.
- If `npm run api` cannot find Python on Windows, run `npm run api:windows`.
- If the dashboard loads but no satellites appear, confirm the API is running
  with `npm run api`.
- If CelesTrak is unreachable, the app uses `python/data/updated data.txt`
  first, then falls back to `python/data/active_2le.txt`.
- If port `5173` is busy, Vite prints the alternate local URL in the terminal.
- If port `5000` is busy, stop the other process or change the Flask port in
  `python/server.py` and the proxy target in `vite.config.js`.
