"""Inspect binary STL files without CAD software. Needs only numpy.

Usage:
    python tools/stl_inspect.py info  <stl>...                 bounding box + heights of flat faces
    python tools/stl_inspect.py loops <stl> <z,z,...>          holes/outlines in horizontal slices
    python tools/stl_inspect.py slice <stl> <outdir> <z,z,...> [px_per_mm]
                                                              horizontal slices to PNG (10 mm grid)
    python tools/stl_inspect.py side  <stl> <outdir> <x|y> <c,c,...> [px_per_mm]
                                                              vertical slices (plane x=c or y=c) to PNG
    python tools/stl_inspect.py wall  <stl> [radius]           openings in the outer wall, by height

Coordinates are the STL's own (for this project: origin at the deck top-center, +Z up, mm).
"""
import os
import struct
import sys
import zlib
from collections import defaultdict

import numpy as np


def load_stl(path):
    """Load a binary STL as an (N, 3, 3) array of triangle vertices."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:5] == b"solid" and b"facet" in data[:512]:
        sys.exit(f"{path}: ASCII STL is not supported")
    count = struct.unpack_from("<I", data, 80)[0]
    dt = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    return np.frombuffer(data, dtype=dt, count=count, offset=84)["v"].astype(np.float64)


def write_png(path, img):
    """Write an HxW uint8 grayscale image as PNG."""
    h, w = img.shape
    raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def slice_segments(tri, z):
    """Line segments (M, 2, 2) where the plane Z=z cuts the triangles."""
    above = tri[:, :, 2] > z
    cut = above.sum(axis=1)
    mask = (cut == 1) | (cut == 2)
    segs = []
    for tv, av in zip(tri[mask], above[mask]):
        pts = []
        for i in range(3):
            p, q = tv[i], tv[(i + 1) % 3]
            if av[i] != av[(i + 1) % 3]:
                s = (z - p[2]) / (q[2] - p[2])
                pts.append(p[:2] + s * (q[:2] - p[:2]))
        if len(pts) == 2:
            segs.append(pts)
    return np.array(segs).reshape(-1, 2, 2)


def chain_loops(segs, tol=0.01):
    """Chain segments into polylines by matching endpoints (rounded to tol)."""
    key = lambda p: (round(p[0] / tol), round(p[1] / tol))
    ends = defaultdict(list)
    for i, (p, q) in enumerate(segs):
        ends[key(p)].append((i, 1))
        ends[key(q)].append((i, 0))
    used = np.zeros(len(segs), bool)
    loops = []
    for start in range(len(segs)):
        if used[start]:
            continue
        used[start] = True
        pts = [segs[start][0], segs[start][1]]
        cur = key(segs[start][1])
        while True:
            nxt = [(i, e) for (i, e) in ends[cur] if not used[i]]
            if not nxt:
                break
            i, e = nxt[0]
            used[i] = True
            pts.append(segs[i][e])
            cur = key(segs[i][e])
        loops.append(np.array(pts))
    return loops


def render(segs, bounds, ppm, path, grid=10):
    """Draw segments into a PNG with a light grid every `grid` mm (origin lines darker)."""
    xmin, ymin, xmax, ymax = bounds
    w, h = int((xmax - xmin) * ppm) + 1, int((ymax - ymin) * ppm) + 1
    img = np.full((h, w), 255, np.uint8)
    for gx in np.arange(np.ceil(xmin / grid) * grid, xmax, grid):
        img[:, int((gx - xmin) * ppm)] = 170 if gx == 0 else 225
    for gy in np.arange(np.ceil(ymin / grid) * grid, ymax, grid):
        img[h - 1 - int((gy - ymin) * ppm), :] = 170 if gy == 0 else 225
    for p, q in segs:
        n = max(int(max(abs(q - p)) * ppm * 2), 2)
        t = np.linspace(0, 1, n)[:, None]
        pts = ((p + t * (q - p)) - (xmin, ymin)) * ppm
        xi = np.clip(pts[:, 0].astype(int), 0, w - 1)
        yi = np.clip(h - 1 - pts[:, 1].astype(int), 0, h - 1)
        img[yi, xi] = 0
    write_png(path, img)


def bounds_of(tri, margin=2):
    v = tri.reshape(-1, 3)
    return (v[:, 0].min() - margin, v[:, 1].min() - margin, v[:, 0].max() + margin, v[:, 1].max() + margin)


def stem(path):
    return os.path.splitext(os.path.basename(path))[0].replace(" ", "_")


def cmd_info(paths):
    for path in paths:
        tri = load_stl(path)
        v = tri.reshape(-1, 3)
        lo, hi = v.min(0), v.max(0)
        print(f"== {os.path.basename(path)}: {len(tri)} triangles")
        print(f"   min {np.round(lo, 2)}  max {np.round(hi, 2)}  size {np.round(hi - lo, 2)}")
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        norm = np.linalg.norm(n, axis=1)
        nz = n[:, 2] / np.maximum(norm, 1e-12)
        flat = np.abs(nz) > 0.999
        areas = defaultdict(float)
        for z, a, up in zip(np.round(tri[flat, 0, 2], 2), norm[flat] / 2, nz[flat] > 0):
            areas[(z, "up" if up else "down")] += a
        print("   flat faces (z, facing, area mm^2):")
        for (z, facing), a in sorted(areas.items()):
            if a > 2:
                print(f"     z={z:8.2f} {facing:4s} {a:9.1f}")


def cmd_loops(path, zs):
    tri = load_stl(path)
    for z in zs:
        loops = [L for L in chain_loops(slice_segments(tri, z)) if len(L) > 3]
        print(f"== {os.path.basename(path)} z={z}: {len(loops)} loops")
        rows = []
        for L in loops:
            c = L.mean(0)
            r = np.linalg.norm(L - c, axis=1)
            x, y = L[:, 0], L[:, 1]
            area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
            rows.append((area, c, r, L.min(0), L.max(0)))
        for area, c, r, lo, hi in sorted(rows, key=lambda row: -row[0]):
            if r.std() < 0.05 * max(r.mean(), 1e-9):
                print(f"   circle  center=({c[0]:7.2f},{c[1]:7.2f})  d={2 * r.mean():6.2f}")
            else:
                print(f"   outline bbox=({lo[0]:7.2f},{lo[1]:7.2f})..({hi[0]:7.2f},{hi[1]:7.2f})  area={area:8.1f}")


def cmd_slice(path, outdir, zs, ppm):
    tri = load_stl(path)
    os.makedirs(outdir, exist_ok=True)
    for z in zs:
        out = os.path.join(outdir, f"{stem(path)}_z{z:g}.png")
        render(slice_segments(tri, z), bounds_of(tri), ppm, out)
        print(out)


def cmd_side(path, outdir, axis, cs, ppm):
    # Permute so the cut axis becomes Z; the image shows (other horizontal axis, z).
    perm = [1, 2, 0] if axis == "x" else [0, 2, 1]
    tri = load_stl(path)[:, :, perm]
    os.makedirs(outdir, exist_ok=True)
    for c in cs:
        out = os.path.join(outdir, f"{stem(path)}_{axis}{c:g}.png")
        render(slice_segments(tri, c), bounds_of(tri), ppm, out)
        print(out)


def cmd_wall(path, radius):
    tri = load_stl(path)
    v = tri.reshape(-1, 3)
    for z in np.arange(v[:, 2].min() + 0.25, v[:, 2].max(), 0.5):
        segs = slice_segments(tri, z)
        if not len(segs):
            continue
        mids = segs.mean(axis=1)
        outer = mids[np.hypot(mids[:, 0], mids[:, 1]) > radius]
        if not len(outer):
            continue
        ang = np.sort(np.degrees(np.arctan2(outer[:, 1], outer[:, 0])) % 360)
        gaps = np.diff(np.concatenate([ang, [ang[0] + 360]]))
        found = [f"{ang[i]:.1f}..{ang[(i + 1) % len(ang)]:.1f} deg" for i in np.where(gaps > 3)[0]]
        print(f"z={z:7.2f}  {', '.join(found) if found else '-'}")


def floats(s):
    return [float(x) for x in s.split(",")]


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    if cmd == "info":
        cmd_info(args[1:])
    elif cmd == "loops":
        cmd_loops(args[1], floats(args[2]))
    elif cmd == "slice":
        cmd_slice(args[1], args[2], floats(args[3]), float(args[4]) if len(args) > 4 else 6)
    elif cmd == "side":
        cmd_side(args[1], args[2], args[3], floats(args[4]), float(args[5]) if len(args) > 5 else 6)
    elif cmd == "wall":
        cmd_wall(args[1], float(args[2]) if len(args) > 2 else 49.5)
    else:
        sys.exit(__doc__)
