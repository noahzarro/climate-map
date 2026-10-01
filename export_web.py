"""
Export the period climatology datasets for web display with MapLibre GL JS.

For each variable (tg = mean temp, tn = min temp, tx = max temp, rr =
precipitation) and each of the 48 climatological periods (each of the 12
months split into 4 nearly-equal parts; see periods.py), this produces:
  - web/data/<var>/period_XX.png  - RGBA image (colormapped, transparent
                                     over NaN/ocean), used as a MapLibre
                                     `image` source overlay. Rows are
                                     pre-warped so they are evenly spaced
                                     in Web Mercator Y (not plain latitude
                                     degrees), to avoid the vertical
                                     distortion that a large latitude span
                                     would otherwise cause when MapLibre
                                     projects the image.
  - web/data/<var>/period_XX.bin  - raw grid values as little-endian
                                     Int16, fixed-point (value = raw /
                                     scale), NaN encoded as -32768. Used
                                     client-side to show the exact value
                                     on hover. Uses the *original*
                                     equirectangular grid (not
                                     Mercator-warped), since hover does its
                                     own direct lat/lon -> row/col lookup.
  - web/data/meta.json             - bounds, grid shape, shared period
                                      list, and per-variable color scale /
                                      encoding info.

Image / binary row order: row 0 = northernmost latitude (top of image),
col 0 = westernmost longitude (left of image).
"""

import json
from pathlib import Path

import matplotlib
import matplotlib.colors as mcolors
import numpy as np
import xarray as xr
from PIL import Image

from periods import build_periods

OUTPUT_DIR = Path("web/data")

NAN_SENTINEL = -32768
FIXED_POINT_SCALE = 100  # store value * 100 as int16

# variable short-name -> config
# Each variable uses its own sensible color scale (based on its actual
# climatological range), so colors are NOT directly comparable between
# tg/tn/tx - but each map makes full use of the color ramp's contrast.
VARIABLES = {
    "tg": {
        "file": "tg_period_climatology_2011-2025.nc",
        "label": "Mean temperature",
        "units": "\u00b0C",
        "colormap": "RdYlBu_r",
        "scale_min": -25.0,
        "scale_max": 45.0,
    },
    "tn": {
        "file": "tn_period_climatology_2011-2025.nc",
        "label": "Min temperature",
        "units": "\u00b0C",
        "colormap": "RdYlBu_r",
        "scale_min": -25.0,
        "scale_max": 35.0,
    },
    "tx": {
        "file": "tx_period_climatology_2011-2025.nc",
        "label": "Max temperature",
        "units": "\u00b0C",
        "colormap": "RdYlBu_r",
        "scale_min": -20.0,
        "scale_max": 45.0,
    },
    "rr": {
        "file": "rr_period_climatology_2011-2025.nc",
        "label": "Precipitation",
        "units": "mm/day",
        "colormap": "YlGnBu",
        "scale_min": 0.0,
        "scale_max": 30.0,
    },
}


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
    lat.max() (north), matching the ascending `lat` array. The returned
    array already has row 0 = north (top of image).
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


def export_legend(var: str, config: dict, var_dir: Path) -> str:
    """Write a horizontal gradient strip PNG for this variable's colormap,
    so the frontend can show a legend that exactly matches the data
    colors without having to hand-reproduce the colormap in CSS."""
    colormap = matplotlib.colormaps[config["colormap"]]
    width = 256
    gradient = np.linspace(0, 1, width)
    rgba = colormap(gradient, bytes=True)  # (width, 4)
    rgba = np.tile(rgba[np.newaxis, :, :], (16, 1, 1))  # (16, width, 4)
    img = Image.fromarray(rgba, mode="RGBA")
    name = "legend.png"
    img.save(var_dir / name)
    return name


def compute_valid_bbox(files: list[str]) -> tuple[slice, slice]:
    """
    Find the smallest contiguous (lat, lon) index range that contains all
    non-NaN data across all variable files, so the exported grid/bounds can
    be trimmed of NaN-only edge rows/columns (e.g. ocean-only or
    outside-coverage margins of the source rectangular grid) instead of
    spanning the full raw grid extent.
    """
    valid_mask = None
    for file in files:
        ds = xr.open_dataset(file)
        var_name = next(iter(ds.data_vars))
        mask = ds[var_name].notnull().any(dim="time").values  # (lat, lon)
        valid_mask = mask if valid_mask is None else (valid_mask | mask)
        ds.close()

    lat_valid_idx = np.where(valid_mask.any(axis=1))[0]
    lon_valid_idx = np.where(valid_mask.any(axis=0))[0]
    if lat_valid_idx.size == 0 or lon_valid_idx.size == 0:
        raise ValueError("No valid (non-NaN) data found in any variable file")

    lat_slice = slice(int(lat_valid_idx.min()), int(lat_valid_idx.max()) + 1)
    lon_slice = slice(int(lon_valid_idx.min()), int(lon_valid_idx.max()) + 1)
    return lat_slice, lon_slice


def export_variable(
    var: str, config: dict, resample_rows, periods_meta, lat_slice: slice, lon_slice: slice
):
    ds = xr.open_dataset(config["file"])
    # Crop to the bounding box of actual (non-NaN) data across all
    # variables, trimming NaN-only edge rows/columns of the raw grid.
    ds = ds.isel(latitude=lat_slice, longitude=lon_slice)
    n_periods = ds.sizes["time"]
    assert n_periods == len(periods_meta), (
        f"{var}: expected {len(periods_meta)} periods, got {n_periods}"
    )

    var_dir = OUTPUT_DIR / var
    var_dir.mkdir(parents=True, exist_ok=True)

    norm = mcolors.Normalize(
        vmin=config["scale_min"], vmax=config["scale_max"], clip=True
    )
    colormap = matplotlib.colormaps[config["colormap"]]

    for i in range(n_periods):
        frame = ds[var].isel(time=i).values  # shape (lat, lon), lat ascending

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
        png_name = f"period_{i:02d}.png"
        img.save(var_dir / png_name)

        # --- Raw binary (Int16 fixed-point, NaN sentinel) ---
        # Uses the *original* equirectangular grid (row 0 = north), unrelated
        # to the Mercator warp above, since this is only used for direct
        # lat/lon -> value lookups on hover (see meta["grid"]).
        frame_equirect = np.flipud(frame)
        fixed = np.round(frame_equirect * FIXED_POINT_SCALE)
        fixed = np.clip(fixed, -32767, 32767)  # clip real values only
        fixed = np.where(np.isnan(frame_equirect), NAN_SENTINEL, fixed).astype(
            "<i2"
        )
        bin_name = f"period_{i:02d}.bin"
        fixed.tofile(var_dir / bin_name)

    print(f"  {var}: wrote {n_periods} periods to {var_dir}/")
    return frame.shape  # (rows, cols), same across variables


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Grid resolution/shape is identical across variables (same source
    # grid), so just read coordinates once from the first variable's file.
    # The *extent* of actual (non-NaN) data can differ slightly at the
    # edges though, so bounds are trimmed to the bounding box of valid data
    # across all variables (see compute_valid_bbox), rather than spanning
    # the full raw grid, which often has NaN-only margins (ocean / outside
    # coverage).
    all_files = [config["file"] for config in VARIABLES.values()]
    lat_slice, lon_slice = compute_valid_bbox(all_files)

    first_file = next(iter(VARIABLES.values()))["file"]
    ds0 = xr.open_dataset(first_file)
    lat = ds0["latitude"].values[lat_slice]
    lon = ds0["longitude"].values[lon_slice]
    lat_min, lat_max = float(lat.min()), float(lat.max())
    lon_min, lon_max = float(lon.min()), float(lon.max())
    n_rows = lat.shape[0]

    resample_rows = build_row_resampler(lat, n_rows)

    # Periods (each of the 12 months split into 4 nearly-equal parts) are
    # shared across all variables since the aggregation produces the same
    # 48 period buckets; see periods.py for the exact split rule.
    periods_meta = build_periods()

    variables_meta = {}
    grid_shape = None
    for var, config in VARIABLES.items():
        print(f"Exporting {var} ({config['label']}) ...")
        grid_shape = export_variable(
            var, config, resample_rows, periods_meta, lat_slice, lon_slice
        )
        legend_name = export_legend(var, config, OUTPUT_DIR / var)
        variables_meta[var] = {
            "label": config["label"],
            "units": config["units"],
            "dir": var,
            "legend": legend_name,
            "colorScale": {
                "colormap": config["colormap"],
                "min": config["scale_min"],
                "max": config["scale_max"],
            },
            "rawEncoding": {
                "dtype": "int16",
                "byteorder": "little",
                "scale": FIXED_POINT_SCALE,
                "nanSentinel": NAN_SENTINEL,
                "formula": "value = raw / scale (raw == nanSentinel -> no data)",
            },
        }

    meta = {
        "bounds": {
            "lonMin": lon_min,
            "lonMax": lon_max,
            "latMin": lat_min,
            "latMax": lat_max,
        },
        "grid": {
            "rows": grid_shape[0],
            "cols": grid_shape[1],
            "latStep": float(lat[1] - lat[0]),
            "lonStep": float(lon[1] - lon[0]),
            # row 0 of png/bin = north, col 0 = west
        },
        "periods": periods_meta,
        "variables": variables_meta,
        "defaultVariable": "tg",
    }

    with open(OUTPUT_DIR / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"meta.json written to {OUTPUT_DIR / 'meta.json'}")


if __name__ == "__main__":
    main()
