import xarray as xr
ds = xr.open_dataset("tg_ens_mean_0.1deg_reg_2011-2025_v33.0e.nc")
print(ds)