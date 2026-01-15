#!/bin/bash
# Auto-install CCS locally for testing changes
# Usage: ./scripts/dev-install.sh
#
# Options:
#   --skip-validate  Skip validation (faster, use when you're sure code is good)
#   --npm            Force npm install (default: auto-detect, fallback to bun)
#   --bun            Force bun install

set -e

SKIP_VALIDATE=false
FORCE_NPM=false
FORCE_BUN=false

for arg in "$@"; do
    case $arg in
        --skip-validate) SKIP_VALIDATE=true ;;
        --npm) FORCE_NPM=true ;;
        --bun) FORCE_BUN=true ;;
    esac
done

echo "[i] CCS Dev Install - Starting..."

# Get to the right directory
cd "$(dirname "$0")/.."

# Detect installation method
# Priority: CLI flags > existing global install location > bun (default)
detect_pkg_manager() {
    if [ "$FORCE_NPM" = true ]; then
        echo "npm"
        return
    fi

    if [ "$FORCE_BUN" = true ]; then
        echo "bun"
        return
    fi

    # Check existing ccs installation location
    CCS_PATH=$(which ccs 2>/dev/null || true)

    if [ -n "$CCS_PATH" ]; then
        # Check if installed via bun
        if [[ "$CCS_PATH" == *".bun"* ]]; then
            echo "bun"
            return
        fi
        # Check if installed via npm
        if [[ "$CCS_PATH" == *"npm"* ]] || [[ "$CCS_PATH" == *"node_modules"* ]]; then
            echo "npm"
            return
        fi
    fi

    # Default fallback: bun (preferred)
    echo "bun"
}

PKG_MANAGER=$(detect_pkg_manager)
echo "[i] Detected package manager: $PKG_MANAGER"

# Build TypeScript first
echo "[i] Building TypeScript..."
bun run build:all

# Pack the npm package
echo "[i] Creating package..."
if [ "$SKIP_VALIDATE" = true ]; then
    # Skip validation, just pack
    npm pack --ignore-scripts 2>/dev/null || bun pm pack --ignore-scripts
else
    # Full pack with validation (runs prepublishOnly)
    npm pack 2>/dev/null || bun pm pack
fi

# Find the tarball
TARBALL=$(ls -t kaitranntt-ccs-*.tgz 2>/dev/null | head -1)

if [ -z "$TARBALL" ]; then
    echo "[X] ERROR: No tarball found"
    exit 1
fi

echo "[i] Found tarball: $TARBALL"

# Install globally using detected package manager
echo "[i] Installing globally with $PKG_MANAGER..."

if [ "$PKG_MANAGER" = "bun" ]; then
    # Remove existing to avoid duplicate key warnings in bun's global package.json
    # (bun add -g appends instead of replacing file: protocol entries)
    bun remove -g @kaitranntt/ccs 2>/dev/null || true
    # Bun requires file: protocol for local tarballs
    bun add -g "file:$(pwd)/$TARBALL"
else
    npm install -g "$TARBALL"
fi

# Clean up
echo "[i] Cleaning up..."
rm "$TARBALL"

echo "[OK] Complete! CCS is now updated."
echo ""
echo "Test with: ccs --version"
