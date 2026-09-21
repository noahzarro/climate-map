"""
Export the weekly temperature climatology for web display with MapLibre GL JS.

For each of the 52 climatological weeks this produces:
  - web/data/week_XX.png  - RGBA image (colormapped, transparent over NaN/ocean),
                            used as a MapLibre `image` source overlay.
  - web/data/week_XX.bin  - raw grid values as little-endian Int16, fixed-point
                            at 0.01 degC (value = raw / 100), NaN encoded as
                            -32768. Used client-side to show the exact
                            temperature on hover.
  - web/data/meta.json    - bounds, grid shape, color scale, and per-week
                            metadata (dates relabeled to the year 2027).

Image / binary row order: row 0 = northernmost latitude (top of image),
col 0 = westernmost longitude (left of image). This matches normal raster
image conventions.
"""

import json
from datetime import date
from pathlib import Path

import matplotlib
import matplotlib.cm as cm
import matplotlib.colors as mcolors
import numpy as np
import xarray as xr
from PIL import Image

INPUT_FILE = "tg_weekly_climatology_2011-2025.nc"
OUTPUT_DIR = Path("web/data")

COLORMAP = "RdYlBu_r"  # blue = cold, red = hot
SCALE_MIN = -25.0
SCALE_MAX = 45.0

DISPLAY_YEAR = 2027  # year used only to generate human-readable week labels

NAN_SENTINEL = -32768
FIXED_POINT_SCALE = 100  # store temp * 100 as int16


def _mercator_y(lat_deg: np.ndarray) -> np.ndarray:
    """Unnormalized Web Mercator northing (radians) for latitude in degrees."""
    phi = np.radians(lat_deg)
    return np.log(np.tan(np.pi / 4 + phi / 2))


def _mercator_y_to_lat(y: np.ndarray) -> np.ndarray:
    """Inverse of `_mercator_y`: latitude in degrees for a given northing."""
    phi = 2 * np.arctan(np.exp(y)) - np.pi / 2
    return np.degrees(phi)


def build_row_resampler(lat: np.ndarray, n_rows: int):
    """
    Build a function that resamples a (lat, lon) array (lat ascending) into a
    new array with `n_rows` rows evenly spaced in Web Mercator Y (row 0 =
    north/top, last row = south/bottom), instead of evenly spaced in plain
    latitude degrees.

    This is needed because MapLibre's `image` source interpolates the image
    linearly across its quad in Mercator-projected space. An image whose rows
    are evenly spaced in latitude degrees (equirectangular) gets vertically
    warped/misaligned once stretched across a large latitude span, because
    Mercator Y is a nonlinear function of latitude. Pre-warping the rows here
    cancels that distortion out.

    Returns a function `resample(frame) -> frame_mercator` where `frame` has
    shape (len(lat), n_cols) with row 0 = lat.min() (south) ... last row =
    lat.max() (north), matching the ascending `lat` array.
    """
    lat_min, lat_max = float(lat.min()), float(lat.max())
    lat_step = float(lat[1] - lat[0])

    y_min, y_max = _mercator_y(np.array([lat_min, lat_max]))

    # Row 0 = north (top), so northing decreases as row index increases.
    row_frac = np.arange(n_rows) / (n_rows - 1)
    y_rows = y_max - row_frac * (y_max - y_min)
    lat_rows = _mercator_y_to_lat(y_rows)  # descending: north -> south

    # Fractional index into the original ascending `lat` array.
    idx_frac = np.clip((lat_rows - lat_min) / lat_step, 0, len(lat) - 1)
    idx0 = np.floor(idx_frac).astype(int)
    idx1 = np.minimum(idx0 + 1, len(lat) - 1)
    w = (idx_frac - idx0)[:, None]  # (n_rows, 1), broadcast over columns

    def resample(frame_ascending: np.ndarray) -> np.ndarray:
        return (1 - w) * frame_ascending[idx0, :] + w * frame_ascending[idx1, :]

    return resample


def main() -> None:
    ds = xr.open_dataset(INPUT_FILE)

    # Drop the 53rd week bucket (its Monday, 2020-12-28, is the last time
    # step) so we end up with a normal 52-week year, matching 2027's ISO
    # calendar (which has no week 53).
    ds = ds.isel(time=slice(0, -1))
    n_weeks = ds.sizes["time"]
    assert n_weeks == 52, f"expected 52 weeks, got {n_weeks}"

    lat = ds["latitude"].values
    lon = ds["longitude"].values
    lat_min, lat_max = float(lat.min()), float(lat.max())
    lon_min, lon_max = float(lon.min()), float(lon.max())

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    norm = mcolors.Normalize(vmin=SCALE_MIN, vmax=SCALE_MAX, clip=True)
    colormap = matplotlib.colormaps[COLORMAP]

    n_rows = lat.shape[0]
    resample_rows = build_row_resampler(lat, n_rows)

    weeks_meta = []

    for i in range(n_weeks):
        frame = ds["tg"].isel(time=i).values  # shape (lat, lon), lat ascending

        # --- PNG (colorized, transparent where NaN) ---
        # Resample rows so they're evenly spaced in Mercator Y (not plain
        # latitude degrees) to match how MapLibre's `image` source projects
        # the image. `resample_rows` already returns row 0 = north (top of
        # image), no additional flip needed.
        frame_img = resample_rows(frame)

        rgba = colormap(norm(np.ma.masked_invalid(frame_img)), bytes=True)
        rgba = np.array(rgba)  # (rows, cols, 4) uint8
        alpha = np.where(np.isnan(frame_img), 0, 255).astype(np.uint8)
        rgba[..., 3] = alpha

        img = Image.fromarray(rgba, mode="RGBA")
        png_name = f"week_{i:02d}.png"
        img.save(OUTPUT_DIR / png_name)

        # --- Raw binary (Int16 fixed-point, NaN sentinel) ---
        # Uses the *original* equirectangular grid (row 0 = north), unrelated
        # to the Mercator warp above, since this is only used for direct
        # lat/lon -> value lookups on hover (see meta["grid"]).
        frame_equirect = np.flipud(frame)
        fixed = np.round(frame_equirect * FIXED_POINT_SCALE)
        fixed = np.clip(fixed, -32767, 32767)  # clip real values only
        fixed = np.where(np.isnan(frame_equirect), NAN_SENTINEL, fixed).astype("<i2")
        bin_name = f"week_{i:02d}.bin"
        fixed.tofile(OUTPUT_DIR / bin_name)

        # --- Week label dates, relabeled to DISPLAY_YEAR ---
        week_number = i + 1
        monday = date.fromisocalendar(DISPLAY_YEAR, week_number, 1)
        sunday = date.fromisocalendar(DISPLAY_YEAR, week_number, 7)

        weeks_meta.append(
            {
                "index": i,
                "week": week_number,
                "png": png_name,
                "bin": bin_name,
                "monday": monday.isoformat(),
                "sunday": sunday.isoformat(),
            }
        )

    meta = {
        "bounds": {
            "lonMin": lon_min,
            "lonMax": lon_max,
            "latMin": lat_min,
            "latMax": lat_max,
        },
        "grid": {
            "rows": frame.shape[0],
            "cols": frame.shape[1],
            "latStep": float(lat[1] - lat[0]),
            "lonStep": float(lon[1] - lon[0]),
            # row 0 of png/bin = north, col 0 = west
        },
        "colorScale": {
            "colormap": COLORMAP,
            "min": SCALE_MIN,
            "max": SCALE_MAX,
            "units": "degC",
        },
        "rawEncoding": {
            "dtype": "int16",
            "byteorder": "little",
            "scale": FIXED_POINT_SCALE,
            "nanSentinel": NAN_SENTINEL,
            "formula": "value_degC = raw / scale (raw == nanSentinel -> no data)",
        },
        "displayYear": DISPLAY_YEAR,
        "weeks": weeks_meta,
    }

    with open(OUTPUT_DIR / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Wrote {n_weeks} weeks of PNG + BIN data to {OUTPUT_DIR}/")
    print(f"meta.json written to {OUTPUT_DIR / 'meta.json'}")


if __name__ == "__main__":
    main()
