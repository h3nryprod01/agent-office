# shellcheck shell=bash
# Shared by the start/install scripts (sourced, never run on its own).
# Messages are English; Vietnamese when LANG starts with "vi".
#   say EN VI        print one message
#   say_err EN VI    same, to stderr
#   die EN VI        print to stderr and exit 1
#   parse_yes ARGS   sets AO_YES=1 if --yes / -y is among them
#   confirm EN VI    ask a yes/no question; --yes answers yes, no terminal answers no

AO_YES=0

ao_vi() {
  case "${LANG:-}" in vi*) return 0 ;; esac
  return 1
}

say() {
  if ao_vi; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi
}

say_err() { say "$1" "$2" >&2; }

die() {
  say_err "$1" "$2"
  exit 1
}

parse_yes() {
  local a
  for a in "$@"; do
    case "$a" in --yes | -y) AO_YES=1 ;; esac
  done
}

confirm() {
  [ "$AO_YES" = 1 ] && return 0
  if [ ! -t 0 ]; then
    say_err "$1 (not a terminal: assuming no; re-run with --yes to agree)" \
      "$2 (không có terminal: coi như không; chạy lại với --yes để đồng ý)"
    return 1
  fi
  if ao_vi; then printf '%s [c/K] ' "$2"; else printf '%s [y/N] ' "$1"; fi
  local ans
  read -r ans || return 1
  case "$ans" in [yYcC]*) return 0 ;; esac
  return 1
}
