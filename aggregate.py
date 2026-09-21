"""
Aggregate the E-OBS daily mean temperature dataset into a single
"climatological week" cycle.

Method
------
1. Keep lat/lon coordinates unchanged.
2. Build a daily climatology: for every calendar day (month-day, e.g.
   "01-01", "02-29", ..., "12-31"), average all matching days across
   2011-2025. This gives ~366 daily values (Feb 29 only averages the
   leap years that actually have it).
3. Assign each calendar day to the ISO week (Mon-Sun) it falls into
   in a fixed reference year (2020, a leap year with the full 53 ISO
   weeks), then average the daily-climatology values within each week.
4. Label each resulting week with the date of its Monday in the same
   reference year, via ``date.fromisocalendar(2020, week, 1)``.

This two-stage approach (day-of-year climatology, then weekly average of
that climatology) avoids the misalignment that comes from grouping raw
daily data directly by ISO week number across years with different
calendars.
"""

from datetime import date

import numpy as np
import xarray as xr

INPUT_FILE = "tg_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc"
OUTPUT_FILE = "tg_weekly_climatology_2011-2025.nc"
REFERENCE_YEAR = 2020  # leap year, used to define week boundaries & labels


def main() -> None:
    ds = xr.open_dataset(INPUT_FILE)

    # Step 1: daily climatology, keyed by "MM-DD" (calendar day, no year).
    month_day = ds.time.dt.strftime("%m-%d")
    month_day.name = "month_day"
    daily_climatology = ds.groupby(month_day).mean(dim="time", skipna=True)

    # Step 2: map each "MM-DD" to the ISO week number it falls in during
    # the reference year, then average the daily climatology within
    # each week.
    month_days = daily_climatology["month_day"].values
    iso_weeks = np.array(
        [
            date(REFERENCE_YEAR, int(md[:2]), int(md[3:5])).isocalendar()[1]
            for md in month_days
        ]
    )
    week_da = xr.DataArray(
        iso_weeks, dims="month_day", coords={"month_day": month_days}
    )
    weekly = daily_climatology.groupby(week_da).mean(
        dim="month_day", skipna=True
    )
    weekly = weekly.rename({"group": "time"})

    # Step 3: label each week with the date of its Monday in the
    # reference year.
    week_numbers = weekly["time"].values
    monday_dates = [
        date.fromisocalendar(REFERENCE_YEAR, int(w), 1) for w in week_numbers
    ]
    weekly = weekly.assign_coords(
        time=("time", [str(d) for d in monday_dates])
    )
    weekly["time"] = weekly["time"].astype("datetime64[ns]")
    weekly = weekly.sortby("time")

    weekly.attrs.update(ds.attrs)
    weekly.attrs["description"] = (
        "Weekly climatology (2011-2025): each calendar day (MM-DD) is "
        "first averaged across all years, then those ~366 daily values "
        "are grouped by the ISO week (Mon-Sun) they fall into in "
        f"reference year {REFERENCE_YEAR} and averaged again. The time "
        "coordinate is the Monday of each ISO week in that reference "
        "year."
    )

    weekly.to_netcdf(OUTPUT_FILE)
    print(weekly)
    print(f"\nSaved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
