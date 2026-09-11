#!/bin/sh
set -eu

APP_DIR_NAME="nozzlecam-calibrator"
case "$0" in
    */*) SCRIPT_PARENT=${0%/*} ;;
    *) SCRIPT_PARENT=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$SCRIPT_PARENT" && pwd)
ACTION=${1:-install}
WEB_ROOT=${2:-}

usage() {
    echo "Usage: ./install.sh [install|uninstall] [web-root]"
    echo "Example: ./install.sh install /home/pi/mainsail"
}

if [ "$ACTION" != "install" ] && [ "$ACTION" != "uninstall" ]; then
    usage
    exit 2
fi

if [ -z "$WEB_ROOT" ]; then
    if [ -d "$HOME/mainsail" ]; then
        WEB_ROOT="$HOME/mainsail"
    elif [ -d "$HOME/fluidd" ]; then
        WEB_ROOT="$HOME/fluidd"
    else
        echo "Could not find ~/mainsail or ~/fluidd."
        echo "Run again with the web root, for example:"
        echo "  ./install.sh $ACTION /home/pi/mainsail"
        exit 1
    fi
fi

case "$WEB_ROOT" in
    /|""|"$HOME")
        echo "Refusing unsafe web-root path: $WEB_ROOT"
        exit 1
        ;;
esac

if [ ! -d "$WEB_ROOT" ]; then
    echo "Web root does not exist: $WEB_ROOT"
    exit 1
fi

DEST="$WEB_ROOT/$APP_DIR_NAME"

if [ "$ACTION" = "uninstall" ]; then
    if [ ! -d "$DEST" ]; then
        echo "INDX Aim & Click is not installed at: $DEST"
        exit 0
    fi
    rm -rf -- "$DEST/css" "$DEST/js" "$DEST/media"
    rm -f -- "$DEST/index.html" "$DEST/.aim-and-click-install"
    if ! rmdir "$DEST" 2>/dev/null; then
        echo "Application files removed. Other files were left in: $DEST"
    fi
    echo "INDX Aim & Click uninstalled."
    exit 0
fi

for required in index.html css js; do
    if [ ! -e "$SCRIPT_DIR/$required" ]; then
        echo "Installation package is incomplete: missing $required"
        exit 1
    fi
done

mkdir -p "$DEST"
rm -rf -- "$DEST/css" "$DEST/js" "$DEST/media"
cp "$SCRIPT_DIR/index.html" "$DEST/index.html"
cp -R "$SCRIPT_DIR/css" "$SCRIPT_DIR/js" "$DEST/"
printf '%s\n' "INDX Aim & Click" > "$DEST/.aim-and-click-install"

HOSTNAME_VALUE=$(hostname 2>/dev/null || echo '<printer-host>')
echo "INDX Aim & Click installed successfully."
echo "Open: http://$HOSTNAME_VALUE/$APP_DIR_NAME/"
echo "If that hostname does not work, use the same hostname or IP address as Mainsail/Fluidd."
