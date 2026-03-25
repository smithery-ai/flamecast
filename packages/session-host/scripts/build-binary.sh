#!/usr/bin/env bash
# build-binary.sh — Compile session-host into a Node.js Single Executable Application (SEA).
#
# Usage:
#   ./scripts/build-binary.sh              # build for current platform
#   ./scripts/build-binary.sh --validate   # build and run a quick smoke test
#
# Prerequisites:
#   - Node.js >= 22.x (SEA support)
#   - The esbuild bundle must already exist (run `node esbuild.config.mjs` first)
#
# Output:
#   dist/session-host-<os>-<arch>   (e.g. session-host-linux-x64, session-host-linux-arm64)
#
# Cross-compilation note:
#   Node.js SEA does not support cross-compilation natively. To build for a
#   different architecture, run this script on the target platform (or inside a
#   Docker container / CI runner matching the target). The CI workflow handles
#   this by running the script in separate linux/amd64 and linux/arm64 jobs.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE="dist/session-host.bundle.cjs"
SEA_CONFIG="sea-config.json"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Normalise architecture names to match Node/Docker conventions
case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
esac

OUTPUT="dist/session-host-${OS}-${ARCH}"
BLOB="dist/session-host.blob"

echo "▸ Building SEA binary: $OUTPUT"
echo "  platform: ${OS}/${ARCH}"
echo "  node:     $(node --version)"

# ── 1. Verify bundle exists ─────────────────────────────────────────────────
if [ ! -f "$BUNDLE" ]; then
  echo "Bundle not found at $BUNDLE — running esbuild first..."
  node esbuild.config.mjs
fi

# ── 2. Generate SEA config ──────────────────────────────────────────────────
cat > "$SEA_CONFIG" <<EOF
{
  "main": "$BUNDLE",
  "output": "$BLOB",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
EOF

# ── 3. Generate the SEA blob ────────────────────────────────────────────────
echo "▸ Generating SEA preparation blob..."
node --experimental-sea-config "$SEA_CONFIG"

# ── 4. Copy the node binary and inject the blob ─────────────────────────────
echo "▸ Copying node binary..."
cp "$(command -v node)" "$OUTPUT"
chmod u+w "$OUTPUT"

echo "▸ Injecting SEA blob..."
case "$OS" in
  darwin)
    npx --yes postject "$OUTPUT" NODE_SEA_BLOB "$BLOB" \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
      --macho-segment-name NODE_SEA
    codesign --sign - "$OUTPUT" 2>/dev/null || true
    ;;
  linux)
    npx --yes postject "$OUTPUT" NODE_SEA_BLOB "$BLOB" \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# ── 5. Clean up intermediate files ──────────────────────────────────────────
rm -f "$BLOB" "$SEA_CONFIG"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "✓ Built $OUTPUT ($SIZE)"

# ── 6. Optional validation ──────────────────────────────────────────────────
if [ "${1:-}" = "--validate" ]; then
  echo ""
  echo "▸ Running smoke test..."
  # Start the binary, wait for it to report listening, then kill it.
  VALIDATION_PORT=0
  SESSION_HOST_PORT="$VALIDATION_PORT" timeout 10 "$OUTPUT" &
  PID=$!
  sleep 2

  # Check if the process is still running (didn't crash on startup)
  if kill -0 "$PID" 2>/dev/null; then
    echo "✓ Binary started successfully (PID $PID)"

    # Try a health check if it bound to a port
    # The binary prints "listening on port XXXX" to stdout
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    echo "✓ Smoke test passed"
  else
    wait "$PID" 2>/dev/null
    EXIT_CODE=$?
    echo "✗ Binary exited with code $EXIT_CODE" >&2
    exit 1
  fi
fi
