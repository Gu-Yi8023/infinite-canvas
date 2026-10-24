#!/bin/sh
set -eu
umask 077

case "${1:-worker}" in
  setup) exec node scripts/nas-setup.mjs ;;
  gateway) exec node dist/index.js gateway ;;
  worker|login|diagnose)
    # The same environment is used for device login and the running Codex process.
    : "${OUTBOUND_PROXY_FILE:?Set OUTBOUND_PROXY_FILE}"
    HTTP_PROXY=$(cat "$OUTBOUND_PROXY_FILE")
    [ -n "$HTTP_PROXY" ] || { echo 'OpenClash proxy address is empty' >&2; exit 1; }
    case "$HTTP_PROXY" in http://*|https://*) ;; *) echo 'Use the HTTP or mixed proxy endpoint' >&2; exit 1 ;; esac
    HTTPS_PROXY=$HTTP_PROXY
    http_proxy=$HTTP_PROXY
    https_proxy=$HTTP_PROXY
    NO_PROXY=127.0.0.1,localhost,::1,worker,gateway
    no_proxy=$NO_PROXY
    export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    case "$1" in
      login) exec codex login --device-auth ;;
      diagnose) exec node scripts/nas-diagnose.mjs ;;
      worker) exec node dist/index.js ;;
    esac
    ;;
  *) exec "$@" ;;
esac
