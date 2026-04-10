#!/usr/bin/env bash
set -euo pipefail

run_up() {
  exec env __FLAMECAST_DAEMON=1 flamecast up "$@"
}

if [ "$#" -eq 0 ]; then
  run_up
fi

case "$1" in
  up)
    shift
    run_up "$@"
    ;;
  -*)
    run_up "$@"
    ;;
  down|status|db|help|-h|--help)
    exec flamecast "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
