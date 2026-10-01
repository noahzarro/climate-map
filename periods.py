"""
Shared definitions for dividing the calendar year into 48 periods: each of
the 12 months split into 4 (nearly) equal parts.

This replaces the previous ISO-week (52/53 week) structure. ISO weeks don't
divide evenly into a year and don't align with month boundaries, which
drifts from one year to the next and reads awkwardly ("week 23") compared
to a simple, stable "month + part" structure.

Splitting rule
--------------
Each month is split into 4 parts as evenly as possible. When a month's day
count isn't divisible by 4, the remainder days are front-loaded: the first
`remainder` parts get one extra day, e.g. a 31-day month splits into
8/8/8/7 days, a 30-day month into 8/8/7/7, etc.

February is fixed at a nominal 29 days (not 28) for the purpose of
computing these boundaries, so Feb splits into 8/7/7/7 (days 1-8, 9-15,
16-22, 23-29). This isn't a special case bolted on afterwards: it falls out
of treating Feb as a normal 29-day month in the same split rule as above,
and it ensures Feb 29 - which the day-of-year climatology step produces as
its own "02-29" bucket (averaged only over the leap years that have it) -
always has a well-defined part to belong to, instead of needing to be
discarded or folded in as an afterthought. In non-leap years there's simply
no "02-29" data point to assign, and part 4 of February covers one fewer
real day (23-28) with no effect on the structure.
"""

PARTS_PER_MONTH = 4

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# Nominal day count per month, used only to compute the 4-part split
# boundaries (see module docstring for why February is 29, not 28).
MONTH_DAYS = {
    1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
    7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
}


def _split_sizes(n_days: int, n_parts: int = PARTS_PER_MONTH) -> list[int]:
    """Split n_days into n_parts nearly-equal chunks, front-loaded: any
    remainder is distributed one day per part, starting from the first."""
    base, remainder = divmod(n_days, n_parts)
    return [base + 1 if i < remainder else base for i in range(n_parts)]


def build_periods() -> list[dict]:
    """Build the 48 periods in calendar order (Jan part 1 .. Dec part 4).

    Each period dict has:
      index      - 0-based position in the full 48-period year
      month      - 1-12
      monthName  - e.g. "January"
      part       - 1-4 (which quarter of the month)
      dayStart   - first day-of-month in this part (1-based, inclusive)
      dayEnd     - last day-of-month in this part (1-based, inclusive)
      label      - e.g. "Jan 1-8"
    """
    periods = []
    index = 0
    for month in range(1, 13):
        sizes = _split_sizes(MONTH_DAYS[month])
        month_abbr = MONTH_NAMES[month - 1][:3]
        day = 1
        for part, size in enumerate(sizes, start=1):
            day_start = day
            day_end = day + size - 1
            periods.append(
                {
                    "index": index,
                    "month": month,
                    "monthName": MONTH_NAMES[month - 1],
                    "part": part,
                    "dayStart": day_start,
                    "dayEnd": day_end,
                    "label": f"{month_abbr} {day_start}\u2013{day_end}",
                }
            )
            day = day_end + 1
            index += 1
    return periods


_PERIODS_BY_MONTH_DAY: dict[tuple[int, int], int] | None = None


def month_day_to_period_index(month: int, day: int) -> int:
    """Map a calendar (month, day) to its 0-based period index (0-47)."""
    global _PERIODS_BY_MONTH_DAY
    if _PERIODS_BY_MONTH_DAY is None:
        lookup = {}
        for p in build_periods():
            for d in range(p["dayStart"], p["dayEnd"] + 1):
                lookup[(p["month"], d)] = p["index"]
        _PERIODS_BY_MONTH_DAY = lookup
    try:
        return _PERIODS_BY_MONTH_DAY[(month, day)]
    except KeyError:
        raise ValueError(f"No period found for month={month}, day={day}") from None
