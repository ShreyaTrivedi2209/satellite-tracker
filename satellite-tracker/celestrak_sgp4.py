# celestrak_sgp4.py
# This script downloads TLE data from CelesTrak, parses it, and uses the SGP4 
# algorithm (via the Skyfield library, which wraps the official sgp4 C++ library)
# to compute satellite positions in ECEF and Geodetic (Lat/Lon/Alt) formats.

# Requirements:
# pip install skyfield

from skyfield.api import load
from skyfield.positionlib import ICRF
from datetime import datetime, timezone

def fetch_and_compute():
    print("Downloading active TLEs from CelesTrak...")
    stations_url = 'https://celestrak.org/CAPI/query?GROUP=active&FORMAT=tle'
    
    # Skyfield handles downloading and parsing TLEs
    # reload=True ensures we always fetch the latest live data instead of using a cached file
    satellites = load.tle_file(stations_url, reload=True)
    print(f"Downloaded {len(satellites)} satellites.\n")

    # Let's take the first satellite (usually a prominent one or just the top of the list)
    # Alternatively, you can search by name: 
    # sat = by_name['ISS (ZARYA)']
    sat = satellites[0]
    print(f"--- Analyzing Satellite: {sat.name} ---")

    # Define the current time using Skyfield's timescale
    ts = load.timescale()
    t = ts.now()

    # 1. PROPAGATION (SGP4)
    # The .at(t) method runs the SGP4 algorithm under the hood to calculate 
    # the position and velocity at the specified time.
    geocentric = sat.at(t)

    # 2. TEME to ECEF (Earth-Centered, Earth-Fixed)
    # Geocentric positions are typically in an inertial frame (TEME/ICRF).
    # We convert it to the ITRS frame, which represents ECEF coordinates.
    ecef_pos = geocentric.itrs_xyz.km
    ecef_vel = geocentric.itrs_velocity.km_per_s

    print("\n[ ECEF Coordinates (Earth-Centered, Earth-Fixed) ]")
    print(f"Position (km):   X: {ecef_pos[0]:.3f}, Y: {ecef_pos[1]:.3f}, Z: {ecef_pos[2]:.3f}")
    print(f"Velocity (km/s): X: {ecef_vel[0]:.3f}, Y: {ecef_vel[1]:.3f}, Z: {ecef_vel[2]:.3f}")

    # 3. Geodetic Coordinates (Latitude, Longitude, Altitude)
    # We extract the subpoint mapping the satellite directly down to the WGS84 ellipsoid.
    subpoint = geocentric.subpoint()
    lat = subpoint.latitude.degrees
    lon = subpoint.longitude.degrees
    elevation = subpoint.elevation.km

    print("\n[ Geodetic Coordinates ]")
    print(f"Latitude:  {lat:.4f} degrees")
    print(f"Longitude: {lon:.4f} degrees")
    print(f"Altitude:  {elevation:.3f} km")

if __name__ == '__main__':
    fetch_and_compute()
