#!/usr/bin/env bash
# Generates a stub libasound.so.2 so headless Chromium (playwright-core) can
# launch in a container with no ALSA installed and no apt/network access for
# a real one. Chromium dlopen()s libasound at startup (even with
# --mute-audio) and fails with "cannot open shared object file" / then
# "undefined symbol: snd_pcm_open, version ALSA_0.9" if you stub it with an
# empty .so — the stub must export the exact symbols *and* ALSA version
# nodes Chromium's binary references.
#
# Usage: ./setup-libasound-stub.sh [chromium-binary-path] [output-dir]
#   Defaults: auto-detects the chrome-headless-shell binary under
#   ~/.cache/ms-playwright/; writes to ./libasound-stub/
#
# On success prints the LD_LIBRARY_PATH export line to use.
set -euo pipefail

CHROMIUM_BIN="${1:-}"
OUT_DIR="${2:-$(pwd)/libasound-stub}"

if [ -z "$CHROMIUM_BIN" ]; then
  CHROMIUM_BIN=$(find "$HOME/.cache/ms-playwright" -maxdepth 2 -iname 'chromium*' -type d 2>/dev/null \
    | xargs -I{} find {} -type f -iname 'chrome*' 2>/dev/null | head -1)
fi
if [ -z "$CHROMIUM_BIN" ] || [ ! -f "$CHROMIUM_BIN" ]; then
  echo "Could not find a chromium binary. Install one first:" >&2
  echo "  npm i playwright-core && npx playwright-core install chromium" >&2
  echo "Then re-run: $0 <path-to-chrome-headless-shell>" >&2
  exit 1
fi

if ldconfig -p 2>/dev/null | grep -q libasound.so.2; then
  echo "libasound.so.2 already resolvable system-wide — no stub needed." >&2
  exit 0
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

objdump -T "$CHROMIUM_BIN" 2>/dev/null \
  | grep -i alsa \
  | awk '{print $(NF-1), $NF}' \
  | sed 's/[()]//g' \
  | sort -u > syms.txt

if [ ! -s syms.txt ]; then
  echo "No ALSA symbols found in $CHROMIUM_BIN — nothing to stub (or binary changed shape)." >&2
  exit 1
fi

python3 - "$OUT_DIR" <<'EOF'
import sys
out_dir = sys.argv[1]
lines = [l.split() for l in open(f"{out_dir}/syms.txt") if l.strip()]
by_ver = {}
for ver, sym in lines:
    by_ver.setdefault(ver, []).append(sym)

with open(f"{out_dir}/asound.c", "w") as f:
    for syms in by_ver.values():
        for s in syms:
            f.write(f"int {s}(void) {{ return 0; }}\n")

with open(f"{out_dir}/asound.map", "w") as f:
    prev = None
    for ver, syms in by_ver.items():
        f.write(f"{ver} {{\n  global:\n")
        for s in syms:
            f.write(f"    {s};\n")
        f.write(f"}} {prev};\n\n" if prev else "};\n\n")
        prev = ver
EOF

gcc -shared -fPIC -Wl,--version-script=asound.map -Wl,-soname,libasound.so.2 \
  -o libasound.so.2 asound.c

echo "Built $OUT_DIR/libasound.so.2" >&2
echo "export LD_LIBRARY_PATH=$OUT_DIR:\$LD_LIBRARY_PATH"
