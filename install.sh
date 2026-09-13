#!/usr/bin/env sh
# Install or update FreeRDC from source. This script never publishes packages.
set -eu

REPOSITORY_URL='https://github.com/danielarif26/freerdc'
INSTALL_MARKER='freerdc-source-installer-v1'

say() {
  printf '%s\n' "$*"
}

cleanup_failed_clone() {
  cleanup_status=$?
  trap - 0 HUP INT TERM
  if [ "${fresh_install_root_created:-0}" -eq 1 ] &&
     [ -d "$INSTALL_ROOT" ] &&
     [ ! -L "$INSTALL_ROOT" ] &&
     [ ! -e "$MARKER_FILE" ]; then
    if ! rm -rf "$INSTALL_ROOT"; then
      printf 'install.sh: warning: could not clean failed install at %s\n' "$INSTALL_ROOT" >&2
    fi
  fi
  exit "$cleanup_status"
}

exit_for_signal() {
  signal_status=$1
  trap - HUP INT TERM
  exit "$signal_status"
}

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

canonical_repository() {
  printf '%s' "$1" | sed 's:/*$::; s:\.git$::' | tr '[:upper:]' '[:lower:]'
}

canonicalize_absolute_path() {
  case "$1" in
    /*) ;;
    *) die "install location must be an absolute path: $1" ;;
  esac

  remaining=${1#/}
  canonical_path=/
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then
      remaining=
    else
      remaining=${remaining#*/}
    fi

    case "$component" in
      ''|.) ;;
      ..)
        canonical_path=${canonical_path%/*}
        [ -n "$canonical_path" ] || canonical_path=/
        ;;
      *)
        if [ "$canonical_path" = / ]; then
          canonical_path="/$component"
        else
          canonical_path="$canonical_path/$component"
        fi
        ;;
    esac
  done
  printf '%s\n' "$canonical_path"
}

canonicalize_install_path() {
  install_candidate=$(canonicalize_absolute_path "$1")
  install_parent=${install_candidate%/*}
  install_name=${install_candidate##*/}
  [ -n "$install_parent" ] || install_parent=/
  unresolved_parent=

  while [ ! -d "$install_parent" ]; do
    [ ! -e "$install_parent" ] || die "install location ancestor is not a directory: $install_parent"
    parent_name=${install_parent##*/}
    if [ -n "$unresolved_parent" ]; then
      unresolved_parent="$parent_name/$unresolved_parent"
    else
      unresolved_parent=$parent_name
    fi
    install_parent=${install_parent%/*}
    [ -n "$install_parent" ] || install_parent=/
  done

  physical_parent=$(CDPATH= cd -P "$install_parent" 2>/dev/null && pwd) ||
    die "could not canonicalize install location ancestor: $install_parent"
  if [ -n "$unresolved_parent" ]; then
    printf '%s/%s/%s\n' "${physical_parent%/}" "$unresolved_parent" "$install_name"
  else
    printf '%s/%s\n' "${physical_parent%/}" "$install_name"
  fi
}

require_node_22() {
  require_command node
  require_command npm
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || die 'could not determine Node.js version'
  case "$node_major" in
    ''|*[!0-9]*) die "unexpected Node.js version: $(node --version 2>/dev/null || true)" ;;
  esac
  [ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node --version))"
}

[ -n "${HOME:-}" ] || die 'HOME is not set'
HOME_PATH=$(canonicalize_absolute_path "$HOME")
[ -d "$HOME_PATH" ] || die "HOME is not a directory: $HOME_PATH"
HOME_ROOT=$(CDPATH= cd -P "$HOME_PATH" 2>/dev/null && pwd) || die "could not canonicalize HOME: $HOME_PATH"
case "$(uname -s)" in
  Darwin)
    data_home=${XDG_DATA_HOME:-"$HOME/Library/Application Support"}
    ;;
  Linux)
    data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
    ;;
  *)
    die 'this installer supports macOS and Linux only; use install.ps1 on Windows'
    ;;
esac

INSTALL_ROOT=$(canonicalize_install_path "${FREERDC_INSTALL_DIR:-"$data_home/freerdc"}")
case "$INSTALL_ROOT" in
  "$HOME_ROOT"/*) ;;
  *) die "refusing an install location outside HOME: $INSTALL_ROOT" ;;
esac
[ "$INSTALL_ROOT" != "$HOME_ROOT" ] || die 'invalid install location'
APP_DIR="$INSTALL_ROOT/app"
MARKER_FILE="$INSTALL_ROOT/.freerdc-install"
LAUNCHER="$INSTALL_ROOT/bin/freerdc-server"
FREERDC_REF=${FREERDC_REF:-}

checkout_requested_ref() {
  git -C "$APP_DIR" fetch --tags origin || die 'could not fetch the requested FreeRDC ref'
  requested_commit=$(git -C "$APP_DIR" rev-parse --verify "${FREERDC_REF}^{commit}" 2>/dev/null) || die "requested FreeRDC ref is not a commit, tag, or reachable branch: $FREERDC_REF"
  git -C "$APP_DIR" checkout --detach "$requested_commit" || die "could not check out requested FreeRDC ref: $FREERDC_REF"
}

uninstall() {
  if [ ! -e "$INSTALL_ROOT" ]; then
    say "FreeRDC is not installed at $INSTALL_ROOT"
    return
  fi
  [ ! -L "$INSTALL_ROOT" ] || die "refusing to remove symlinked install location: $INSTALL_ROOT"
  [ -f "$MARKER_FILE" ] || die "refusing to remove unmanaged directory: $INSTALL_ROOT"
  marker=$(sed -n '1p' "$MARKER_FILE")
  [ "$marker" = "$INSTALL_MARKER" ] || die "refusing to remove directory with an unknown marker: $INSTALL_ROOT"
  rm -rf "$INSTALL_ROOT"
  say "Removed FreeRDC from $INSTALL_ROOT"
}

if [ "${1:-}" = '--uninstall' ]; then
  [ "$#" -eq 1 ] || die 'usage: install.sh [--uninstall]'
  uninstall
  exit 0
fi
[ "$#" -eq 0 ] || die 'usage: install.sh [--uninstall]'

require_command git
require_node_22

if [ -z "$FREERDC_REF" ]; then
  say 'Security warning: this source installer follows the mutable default repository branch. For higher assurance, set FREERDC_REF to a reviewed commit or tag.'
fi

if [ -e "$INSTALL_ROOT" ]; then
  [ ! -L "$INSTALL_ROOT" ] || die "refusing to use symlinked install location: $INSTALL_ROOT"
  [ -d "$INSTALL_ROOT" ] || die "install location is not a directory: $INSTALL_ROOT"
  [ -f "$MARKER_FILE" ] || die "refusing to update an unmanaged directory: $INSTALL_ROOT"
  [ "$(sed -n '1p' "$MARKER_FILE")" = "$INSTALL_MARKER" ] || die "refusing to update a directory with an unknown marker: $INSTALL_ROOT"
  [ ! -L "$APP_DIR" ] || die "refusing to use symlinked install location: $APP_DIR"
  [ -d "$APP_DIR" ] || die "install location is not a directory: $APP_DIR"
  top_level=$(git -C "$APP_DIR" rev-parse --show-toplevel 2>/dev/null) || die "install location already exists and is not a Git checkout: $APP_DIR"
  [ "$top_level" = "$APP_DIR" ] || die "install location is not the checkout root: $APP_DIR"
  origin=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null) || die "checkout has no origin remote: $APP_DIR"
  [ "$(canonical_repository "$origin")" = "$(canonical_repository "$REPOSITORY_URL")" ] || die "refusing to update checkout with unexpected origin: $origin"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || die "checkout has local changes; update it manually before rerunning"
  if [ -n "$FREERDC_REF" ]; then
    say "Updating FreeRDC source checkout to $FREERDC_REF..."
    checkout_requested_ref
  else
    say "Updating FreeRDC source checkout..."
    git -C "$APP_DIR" pull --ff-only
  fi
else
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  mkdir "$INSTALL_ROOT"
  fresh_install_root_created=1
  trap cleanup_failed_clone 0
  trap 'exit_for_signal 129' HUP
  trap 'exit_for_signal 130' INT
  trap 'exit_for_signal 143' TERM
  say "Cloning FreeRDC source checkout..."
  git clone "$REPOSITORY_URL" "$APP_DIR"
  if [ -n "$FREERDC_REF" ]; then
    checkout_requested_ref
  fi
  trap - 0 HUP INT TERM
  fresh_install_root_created=0
  printf '%s\n' "$INSTALL_MARKER" > "$MARKER_FILE"
fi

say 'Installing locked dependencies and building FreeRDC...'
(
  cd "$APP_DIR"
  npm ci
  npm run build
)

if [ -e "$LAUNCHER" ] && ! grep -Fqx '# freerdc-source-installer-v1' "$LAUNCHER"; then
  die "refusing to overwrite an unmanaged launcher: $LAUNCHER"
fi
mkdir -p "$(dirname "$LAUNCHER")"
cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env sh
# freerdc-source-installer-v1
set -eu
APP_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
exec node "$APP_DIR/app/packages/server/dist/src/cli.js" "$@"
EOF
chmod 755 "$LAUNCHER"

say "FreeRDC is ready. Run: $LAUNCHER --root /absolute/allowed/root"
say "Add $INSTALL_ROOT/bin to PATH to run freerdc-server by name."
say "To uninstall this managed install: $0 --uninstall"
