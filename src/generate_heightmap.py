# generate_heightmap_fast.py
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.crs import CRS
from affine import Affine

def load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))

def resolve_path(base_dir: Path, p: str) -> Path:
    pp = Path(p)
    return pp if pp.is_absolute() else (base_dir / pp).resolve()

def main():
    config_path = Path("terrain_request.json").resolve()
    cfg = load_config(config_path)
    base_dir = config_path.parent

    origin_lat = float(cfg["origin"]["lat"])
    origin_lon = float(cfg["origin"]["lon"])

    size_m = float(cfg["grid"]["size_m"])
    samples = int(cfg["grid"]["samples"])

    center_e = float(cfg["center_offset"]["east_m"])
    center_n = float(cfg["center_offset"]["north_m"])

    nodata_out = -32768

    raster_path = resolve_path(base_dir, cfg["raster_path"])
    out_bin = resolve_path(base_dir, cfg.get("out_bin", "../public/terrain.bin"))
    out_meta = resolve_path(base_dir, cfg.get("out_meta", "../public/terrain.meta.json"))

    out_bin.parent.mkdir(parents=True, exist_ok=True)

    # Destination CRS: local meters centered on origin
    # AEQD = Azimuthal Equidistant
    dst_crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={origin_lat} +lon_0={origin_lon} +datum=WGS84 +units=m +no_defs"
    )

    # We want a samples x samples grid covering size_m x size_m in meters.
    # Define pixel spacing so that the grid spans the square.
    # Using (samples-1) makes endpoints land on the square edges, matching your vertex grid logic.
    pixel = size_m / (samples - 1)

    half = size_m / 2.0

    # Our grid coordinates are in local meters where:
    # X = east, Y = north
    # Row 0 is north edge, so Y decreases as row increases => negative y scale in Affine.
    # Top-left pixel center at:
    x0 = center_e - half
    y0 = center_n + half

    dst_transform = Affine(pixel, 0, x0, 0, -pixel, y0)

    dst = np.full((samples, samples), nodata_out, dtype=np.int16)

    with rasterio.open(raster_path) as src:
        # Reproject band 1 into our local grid
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            dst_nodata=nodata_out,
            resampling=Resampling.nearest,  # change to bilinear later if you want smoothing
        )

    # Write binary little-endian int16, row-major
    out_bin.write_bytes(dst.astype("<i2", copy=False).tobytes(order="C"))

    valid = dst[dst != nodata_out]
    meta = {
        "origin": {"lat": origin_lat, "lon": origin_lon},
        "grid": {"size_m": size_m, "samples": samples},
        "center_offset": {"east_m": center_e, "north_m": center_n},
        "format": {"dtype": "int16", "endian": "little", "layout": "row-major"},
        "nodata_out": nodata_out,
        "min": int(valid.min()) if valid.size else None,
        "max": int(valid.max()) if valid.size else None,
        "out_bin": str(out_bin),
    }
    out_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print("Wrote:", out_bin)
    print("Meta :", out_meta)
    print("Valid samples:", int(valid.size), "/", samples * samples)

if __name__ == "__main__":
    main()
