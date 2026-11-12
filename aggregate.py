"""
Aggregate the E-OBS daily datasets into a single "climatological period"
cycle, for each of the four variables: mean/min/max temperature and
precipitation.

Method (applied identically to every variable)
-----------------------------------------------
1. Keep lat/lon coordinates unchanged.
2. Build a daily climatology: for every calendar day (month-day, e.g.
   "01-01", "02-29", ..., "12-31"), average all matching days across
   2011-2025. This gives ~366 daily values (Feb 29 only averages the
   leap years that actually have it).
3. Assign each calendar day to one of 48 periods - each of the 12 months
   split into 4 (nearly) equal parts - then average the daily-climatology
   values within each period. See periods.py for the exact split rule.
4. Label each resulting period by its position (0-47) in calendar order;
   periods.py carries the human-readable month/day-range label.

This two-stage approach (day-of-year climatology, then averaging within
each period) avoids the misalignment that comes from grouping raw daily
data directly by period across years with different calendars, and -
unlike the ISO-week structure this replaces - periods always align exactly
with month boundaries and never drift from year to year.

Note: precipitation ("rr") is averaged the same way as the temperature
variables (mean daily climatology, then mean over the period), so the
output represents a typical/mean daily precipitation for that period - not
a period total. Let me know if you'd rather have period totals (sum)
instead.
"""

import numpy as np
import xarray as xr

from periods import MONTH_DAYS, build_periods, month_day_to_period_index

# variable short-name -> (input file, output file)
VARIABLES = {
    "tg": (
        "tg_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc",
        "tg_period_climatology_2011-2025.nc",
    ),
    "tn": (
        "tn_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc",
        "tn_period_climatology_2011-2025.nc",
    ),
    "tx": (
        "tx_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc",
        "tx_period_climatology_2011-2025.nc",
    ),
    "rr": (
        "rr_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc",
        "rr_period_climatology_2011-2025.nc",
    ),
    # Wet days per month, derived from the precipitation input.
    "rd": (
        "rr_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc",
        "rd_period_climatology_2011-2025.nc",
    ),
}


WET_DAY_THRESHOLD_MM = 1.0


def to_wet_day_indicator(ds: xr.Dataset) -> xr.Dataset:
    """Convert daily precipitation (mm) into a 1/0 wet-day indicator (NaN
    preserved), renamed to "rd". Its climatology is the wet-day fraction."""
    wet = (ds["rr"] >= WET_DAY_THRESHOLD_MM).astype("float32")
    wet = wet.where(ds["rr"].notnull())
    return wet.to_dataset(name="rd")


def scale_to_days_per_month(ds: xr.Dataset) -> xr.Dataset:
    """Scale the per-period wet-day fraction to wet days per month, using
    each period's month length (February = 28.25)."""
    days = np.array(
        [28.25 if p["month"] == 2 else MONTH_DAYS[p["month"]] for p in build_periods()],
        dtype="float32",
    )
    factor = xr.DataArray(days, dims="time", coords={"time": ds["time"]})
    out = ds * factor
    out["rd"].attrs.update(
        units="days/month",
        long_name=f"Days per month with precipitation >= {WET_DAY_THRESHOLD_MM} mm",
    )
    return out


LAT_STRIP = 50  # rows per strip, keeps memory bounded for the daily data


def build_period_climatology(
    input_file: str, preprocess=None, postprocess=None
) -> xr.Dataset:
    full = xr.open_dataset(input_file)
    n_lat = full.sizes["latitude"]
    strips = []
    for start in range(0, n_lat, LAT_STRIP):
        ds = full.isel(latitude=slice(start, start + LAT_STRIP)).load()
        if preprocess is not None:
            ds = preprocess(ds)
        strips.append(_period_climatology(ds, postprocess))
    result = xr.concat(strips, dim="latitude")
    result.attrs.update(full.attrs)
    result.attrs["description"] = _DESCRIPTION
    return result


_DESCRIPTION = (
    "Period climatology (2011-2025): each calendar day (MM-DD) is "
    "first averaged across all years, then those ~366 daily values "
    "are grouped into one of 48 periods (each of the 12 months split "
    "into 4 nearly-equal parts; see periods.py) and averaged again. "
    "The time coordinate is the 0-based period index (0-47), in "
    "calendar order."
)


def _period_climatology(ds: xr.Dataset, postprocess=None) -> xr.Dataset:

    # Step 1: daily climatology, keyed by "MM-DD" (calendar day, no year).
    month_day = ds.time.dt.strftime("%m-%d")
    month_day.name = "month_day"
    daily_climatology = ds.groupby(month_day).mean(dim="time", skipna=True)

    # Step 2: map each "MM-DD" to its 0-47 period index, then average the
    # daily climatology within each period.
    month_days = daily_climatology["month_day"].values
    period_indices = np.array(
        [
            month_day_to_period_index(int(md[:2]), int(md[3:5]))
            for md in month_days
        ]
    )
    period_da = xr.DataArray(
        period_indices, dims="month_day", coords={"month_day": month_days}
    )
    period_climatology = daily_climatology.groupby(period_da).mean(
        dim="month_day", skipna=True
    )
    period_climatology = period_climatology.rename({"group": "time"})
    period_climatology = period_climatology.sortby("time")

    n_periods = len(build_periods())
    assert period_climatology.sizes["time"] == n_periods, (
        f"expected {n_periods} periods, got {period_climatology.sizes['time']}"
    )

    if postprocess is not None:
        period_climatology = postprocess(period_climatology)
    return period_climatology


def main() -> None:
    for var, (input_file, output_file) in VARIABLES.items():
        print(f"Processing {var} ({input_file}) ...")
        if var == "rd":
            period_climatology = build_period_climatology(
                input_file,
                preprocess=to_wet_day_indicator,
                postprocess=scale_to_days_per_month,
            )
        else:
            period_climatology = build_period_climatology(input_file)
        period_climatology.to_netcdf(output_file)
        print(f"  -> saved {output_file}  {dict(period_climatology.sizes)}")


if __name__ == "__main__":
    main()
