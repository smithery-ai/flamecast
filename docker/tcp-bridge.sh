#!/bin/sh
# Bridge: TCP server on ACP_PORT → stdin/stdout of the given command
# Usage: ACP_PORT=9100 ./tcp-bridge.sh codex-acp
exec socat TCP-LISTEN:${ACP_PORT:-9100},reuseaddr,fork,nodelay EXEC:"stdbuf -i0 -o0 -e0 $*"
