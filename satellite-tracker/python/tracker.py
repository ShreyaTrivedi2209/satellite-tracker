"""
SGP4 Satellite Tracker
======================
Fetches TLE data from CelesTrak and computes live position + velocity
for any satellite in ECI, ECEF, and Geodetic (Lat/Lon/Alt) formats.

Usage:
    python tracker.py                        # tracks ISS by default
    python tracker.py "STARLINK-1234"        # track by exact name
    python tracker.py --list                 # list all available satellites
"""

import sys
import math
import datetime
import requests
import numpy as np
from sgp4.api import Satrec, jday


# ─────────────────────────────────────────────
# STEP 1: Fetch TLE data from CelesTrak
# ─────────────────────────────────────────────

# Primary and fallback URLs for CelesTrak TLE data
CELESTRAK_URLS = [
    "https://celestrak.org/CAPI/query?GROUP=active&FORMAT=tle",
    "https://celestrak.com/CAPI/query?GROUP=active&FORMAT=tle",
    "https://celestrak.org/pub/TLE/catalog.txt",              # legacy fallback
]

def fetch_tles() -> dict[str, tuple[str, str]]:
    """
    Downloads active TLEs from CelesTrak (tries multiple URLs).
    Returns a dict:  { satellite_name: (line1, line2) }
    """
    last_error = None
    for url in CELESTRAK_URLS:
        try:
            print(f"Fetching TLE data from {url} ...")
            response = requests.get(url, timeout=20)
            response.raise_for_status()

            lines = response.text.strip().splitlines()
            satellites = {}

            for i in range(0, len(lines) - 2, 3):
                name  = lines[i].strip()
                line1 = lines[i + 1].strip()
                line2 = lines[i + 2].strip()
                # Basic sanity check: TLE lines start with '1' and '2'
                if line1.startswith('1') and line2.startswith('2'):
                    satellites[name] = (line1, line2)

            print(f"Loaded {len(satellites)} satellites.\n")
            return satellites

        except Exception as e:
            print(f"  ✗ Failed: {e}")
            last_error = e
            continue

    raise ConnectionError(
        f"Could not reach CelesTrak after trying {len(CELESTRAK_URLS)} URLs.\n"
        f"Last error: {last_error}\n"
        f"Check your internet connection and try again."
    )


# ─────────────────────────────────────────────
# STEP 2: SGP4 Propagation → ECI position
# ─────────────────────────────────────────────

def propagate_sgp4(line1: str, line2: str, t: datetime.datetime) -> tuple:
    """
    Runs the SGP4 algorithm for the given TLE at time t.

    Returns:
        pos_eci  — (x, y, z) in km  in the ECI (TEME) frame
        vel_eci  — (vx, vy, vz) in km/s in the ECI (TEME) frame
    """
    # Parse TLE into an SGP4 satellite record
    satrec = Satrec.twoline2rv(line1, line2)

    # Convert Python datetime to Julian date parts
    # jday() returns (julian_date_integer, julian_date_fraction)
    jd, fr = jday(
        t.year, t.month, t.day,
        t.hour, t.minute, t.second + t.microsecond / 1e6
    )

    # Run SGP4 — returns error code, position (km), velocity (km/s)
    error, pos_eci, vel_eci = satrec.sgp4(jd, fr)

    if error != 0:
        raise RuntimeError(f"SGP4 error code {error}. Satellite may have decayed.")

    return pos_eci, vel_eci


# ─────────────────────────────────────────────
# STEP 3: ECI (TEME) → ECEF via GMST rotation
# ─────────────────────────────────────────────

def gmst_angle(t: datetime.datetime) -> float:
    """
    Computes Greenwich Mean Sidereal Time (GMST) in radians for time t (UTC).
    GMST is Earth's rotation angle — this is what links the inertial ECI frame
    to the Earth-fixed ECEF frame.
    """
    # Julian date of J2000 epoch (noon, Jan 1 2000)
    J2000 = 2451545.0

    jd, fr = jday(
        t.year, t.month, t.day,
        t.hour, t.minute, t.second + t.microsecond / 1e6
    )
    julian_date = jd + fr

    # Days since J2000
    T = (julian_date - J2000) / 36525.0

    # IAU formula for GMST in seconds of arc, converted to radians
    theta_gmst_deg = (
        100.4606184
        + 36000.77004 * T
        + 0.000387933 * T**2
        - T**3 / 38710000.0
    ) % 360.0

    return math.radians(theta_gmst_deg)


def eci_to_ecef(pos_eci: tuple, vel_eci: tuple, gmst: float) -> tuple:
    """
    Rotates a position and velocity from ECI (TEME) frame to ECEF frame
    using a simple Rz rotation by the GMST angle.

    ECEF = Rz(-GMST) * ECI

    The velocity also needs the Earth's rotation rate subtracted out:
        vel_ecef = Rz(-GMST) * vel_eci - ω × pos_ecef
    where ω = 7.2921150e-5 rad/s (Earth's rotation rate)
    """
    cos_g = math.cos(gmst)
    sin_g = math.sin(gmst)

    # Rotation matrix Rz(-GMST)
    Rz = np.array([
        [ cos_g,  sin_g,  0],
        [-sin_g,  cos_g,  0],
        [     0,       0, 1]
    ])

    pos_eci_vec = np.array(pos_eci)
    vel_eci_vec = np.array(vel_eci)

    pos_ecef = Rz @ pos_eci_vec

    # Earth's rotation rate (rad/s)
    omega_earth = 7.2921150e-5

    # Velocity: rotate + subtract Earth's rotation contribution
    vel_ecef = Rz @ vel_eci_vec - np.cross([0, 0, omega_earth], pos_ecef)

    return tuple(pos_ecef), tuple(vel_ecef)


# ─────────────────────────────────────────────
# STEP 4: ECEF → Geodetic (Lat, Lon, Alt)
# ─────────────────────────────────────────────

def ecef_to_geodetic(x: float, y: float, z: float) -> tuple:
    """
    Converts ECEF (X, Y, Z) in km to Geodetic (latitude, longitude, altitude)
    using the Bowring iterative method on the WGS84 ellipsoid.

    Returns:
        lat_deg  — geodetic latitude in degrees  (-90 to +90)
        lon_deg  — longitude in degrees          (-180 to +180)
        alt_km   — altitude above WGS84 ellipsoid in km
    """
    # WGS84 ellipsoid parameters (in km)
    a  = 6378.137        # semi-major axis (equatorial radius)
    f  = 1 / 298.257223563
    b  = a * (1 - f)     # semi-minor axis (polar radius)
    e2 = 2*f - f**2      # eccentricity squared

    # Longitude — straightforward from X and Y
    lon = math.atan2(y, x)

    # Iterative latitude solve (Bowring's method)
    p   = math.sqrt(x**2 + y**2)   # distance from Z-axis
    lat = math.atan2(z, p * (1 - e2))  # initial estimate

    for _ in range(10):  # converges in ~3 iterations
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1 - e2 * sin_lat**2)  # radius of curvature
        lat_new = math.atan2(z + e2 * N * sin_lat, p)
        if abs(lat_new - lat) < 1e-12:
            break
        lat = lat_new

    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    N = a / math.sqrt(1 - e2 * sin_lat**2)

    if abs(cos_lat) > 1e-10:
        alt = p / cos_lat - N
    else:
        alt = abs(z) / abs(sin_lat) - N * (1 - e2)

    return math.degrees(lat), math.degrees(lon), alt


# ─────────────────────────────────────────────
# STEP 5: Pretty print results
# ─────────────────────────────────────────────

def print_results(name: str, t_utc: datetime.datetime,
                  pos_eci, vel_eci, pos_ecef, vel_ecef,
                  lat, lon, alt):
    """Prints a formatted summary of satellite state vectors."""
    # Convert UTC to IST for display
    IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    t_ist = t_utc.astimezone(IST)

    speed_eci  = math.sqrt(sum(v**2 for v in vel_eci))
    speed_ecef = math.sqrt(sum(v**2 for v in vel_ecef))

    print("=" * 60)
    print(f"  SATELLITE: {name}")
    print(f"  TIME (IST): {t_ist.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    print("=" * 60)

    print("\n📡  ECI Position & Velocity (TEME frame)")
    print(f"   Position (km): X={pos_eci[0]:>12.3f}  Y={pos_eci[1]:>12.3f}  Z={pos_eci[2]:>12.3f}")
    print(f"   Velocity(km/s): X={vel_eci[0]:>10.4f}  Y={vel_eci[1]:>10.4f}  Z={vel_eci[2]:>10.4f}")
    print(f"   Speed:  {speed_eci:.4f} km/s")

    print("\n🌍  ECEF Position & Velocity (Earth-Fixed frame)")
    print(f"   Position (km): X={pos_ecef[0]:>12.3f}  Y={pos_ecef[1]:>12.3f}  Z={pos_ecef[2]:>12.3f}")
    print(f"   Velocity(km/s): X={vel_ecef[0]:>10.4f}  Y={vel_ecef[1]:>10.4f}  Z={vel_ecef[2]:>10.4f}")
    print(f"   Speed:  {speed_ecef:.4f} km/s")

    print("\n📍  Geodetic Coordinates (WGS84)")
    print(f"   Latitude:   {lat:>10.5f} °  ({'N' if lat >= 0 else 'S'})")
    print(f"   Longitude:  {lon:>10.5f} °  ({'E' if lon >= 0 else 'W'})")
    print(f"   Altitude:   {alt:>10.3f} km")
    print()


# ─────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────

def main():
    # Parse command line arguments
    if "--list" in sys.argv:
        sats = fetch_tles()
        print("Available satellites:")
        for name in sorted(sats.keys()):
            print(f"  {name}")
        return

    # Default to ISS, or use name from argv
    target_name = "ISS (ZARYA)"
    if len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
        target_name = sys.argv[1].upper()

    # Fetch TLE data
    satellites = fetch_tles()

    # Find the satellite (case-insensitive partial match)
    match = None
    for name in satellites:
        if target_name.upper() in name.upper():
            match = name
            break

    if match is None:
        print(f"ERROR: Could not find satellite matching '{target_name}'")
        print("Tip: run with --list to see all available satellite names")
        sys.exit(1)

    line1, line2 = satellites[match]

    # Use current UTC time
    t_utc = datetime.datetime.now(datetime.timezone.utc)

    # Run the full pipeline
    pos_eci, vel_eci = propagate_sgp4(line1, line2, t_utc)
    gmst            = gmst_angle(t_utc)
    pos_ecef, vel_ecef = eci_to_ecef(pos_eci, vel_eci, gmst)
    lat, lon, alt   = ecef_to_geodetic(*pos_ecef)

    # Print results
    print_results(match, t_utc, pos_eci, vel_eci, pos_ecef, vel_ecef, lat, lon, alt)


if __name__ == "__main__":
    main()
