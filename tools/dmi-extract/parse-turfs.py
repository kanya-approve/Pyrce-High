#!/usr/bin/env python3
"""
Parse Turfs.dm and emit a sidecar JSON of turf-path -> {icon, icon_state}.

DM source uses tab-indented hierarchical syntax; child paths inherit
icon/icon_state from ancestors when not overridden. We output exactly the
turf paths the dm-to-tiled converter discovers in the .dmm grid, plus their
final resolved icon assignment.

Run once and commit the output:
    python3 tools/dmi-extract/parse-turfs.py Turfs.dm packages/client/public/atlases/turf-icons.json
"""
from __future__ import annotations
import json, re, sys

# Strip comments. DM uses // and /* */. We only handle //; multi-line block
# comments don't appear in the relevant section of Turfs.dm at the indents
# we care about.
COMMENT_RE = re.compile(r"//.*$")


def parse(path: str) -> dict[str, dict[str, str]]:
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()

    # Tree: each level is (indent_level, accumulated_path_segment, props_dict_inherited).
    # Props inherited downward; redefining at a lower level overrides.
    # Path stack: list of (indent_tabs, segment, props_so_far).
    stack: list[tuple[int, str, dict[str, str]]] = []
    out: dict[str, dict[str, str]] = {}

    def measure_indent(line: str) -> int:
        n = 0
        for ch in line:
            if ch == "\t":
                n += 1
            else:
                break
        return n

    for raw in lines:
        if not raw.strip():
            continue
        # Strip line comment but keep quoted contents intact (no // inside strings here).
        line = COMMENT_RE.sub("", raw).rstrip()
        if not line.strip():
            continue
        indent = measure_indent(line)
        body = line[indent:]
        # Pop stack to current indent level (strict <=).
        while stack and stack[-1][0] >= indent:
            stack.pop()

        # A property line has '=' and is a sibling-property of the deepest
        # path on the stack. Update that frame's props in place AND propagate
        # to the resolved path.
        if "=" in body and not body.strip().startswith("turf"):
            key, _, val = body.partition("=")
            key = key.strip()
            val = val.strip().rstrip(",")
            # Strip surrounding quotes on string vals.
            if (val.startswith("'") and val.endswith("'")) or (
                val.startswith('"') and val.endswith('"')
            ):
                val = val[1:-1]
            if key in ("icon", "icon_state") and stack:
                stack[-1][2][key] = val
                # Record the resolved props at this turf path.
                full = "/" + "/".join(s[1] for s in stack)
                # Inherit from ancestors that haven't been overridden at this level.
                merged = {}
                for _, _, p in stack:
                    merged.update(p)
                if "icon" in merged or "icon_state" in merged:
                    out[full] = {k: merged[k] for k in ("icon", "icon_state") if k in merged}
            continue

        # Otherwise it's a path segment (possibly slash-separated like turf/School_Floors).
        # Treat each segment as its own indent level so inheritance works.
        seg = body.strip().rstrip("/").rstrip(",")
        if not seg:
            continue
        # `turf/Tatami_Rooom` on one line declares a deeper path at the same
        # indent level — it's syntactic sugar for nesting. Treat the whole
        # slash chain as ONE stack frame so children at indent+1 resolve to
        # the full path.
        parts = [p for p in seg.split("/") if p]
        if not parts:
            continue
        parent_props = stack[-1][2].copy() if stack else {}
        joined = "/".join(parts)
        stack.append((indent, joined, parent_props))
        full = "/" + "/".join(s[1] for s in stack)
        merged: dict[str, str] = {}
        for _, _, p in stack:
            merged.update(p)
        if "icon" in merged or "icon_state" in merged:
            out[full] = {k: merged[k] for k in ("icon", "icon_state") if k in merged}

    return out


def resolve_atlas_keys(paths: dict[str, dict[str, str]], meta_path: str) -> dict[str, str]:
    """Convert each (icon, icon_state) into the atlas frame key the client uses."""
    meta = json.load(open(meta_path))
    # Build (source_lower, state_lower) -> key for S/0 frame only (turfs are 1-dir).
    lookup: dict[tuple[str, str], str] = {}
    for f in meta["frames"]:
        if f["dir"] != "S" or f["frame"] != 0:
            continue
        src_lower = f["source"].lower()
        state_norm = f["state"].replace(" ", "_").lower()
        # Index by the trailing path component too (without category dir).
        leaf = src_lower.rsplit("/", 1)[-1]
        lookup.setdefault((leaf, state_norm), f["key"])
        lookup.setdefault((src_lower, state_norm), f["key"])

    out: dict[str, str] = {}
    for path, props in paths.items():
        icon = props.get("icon", "")
        if not icon.lower().endswith(".dmi"):
            continue  # gfx/*.png and similar — out of scope
        leaf = icon.lower()[:-4]  # strip .dmi
        state = props.get("icon_state", "")
        # Re-normalise state the same way the extractor did.
        state_norm = state.replace(" ", "_").lower()
        key = lookup.get((leaf, state_norm))
        if key:
            out[path] = key
    return out


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: parse-turfs.py <Turfs.dm> <atlas-meta.json> <out.json>", file=sys.stderr)
        return 2
    src, meta, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    paths = parse(src)
    keys = resolve_atlas_keys(paths, meta)
    with open(dst, "w") as f:
        json.dump(keys, f, indent=2, sort_keys=True)
    print(f"wrote {dst} ({len(keys)} of {len(paths)} resolved to atlas frames)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
