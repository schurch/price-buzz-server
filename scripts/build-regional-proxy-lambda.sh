#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAMBDA_DIR="$ROOT_DIR/lambda/regional-proxy"
BUILD_DIR="$LAMBDA_DIR/.build"
ARTIFACT_DIR="$LAMBDA_DIR/dist"
ARTIFACT_PATH="$ARTIFACT_DIR/regional-proxy.zip"

rm -rf "$BUILD_DIR" "$ARTIFACT_DIR"
mkdir -p "$BUILD_DIR" "$ARTIFACT_DIR"

cd "$LAMBDA_DIR"
npm install --omit=dev

cp index.mjs package.json "$BUILD_DIR/"
cp -R node_modules "$BUILD_DIR/node_modules"

python3 - <<'PY' "$BUILD_DIR" "$ARTIFACT_PATH"
from pathlib import Path
import sys
import zipfile

build_dir = Path(sys.argv[1])
artifact_path = Path(sys.argv[2])

with zipfile.ZipFile(artifact_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in build_dir.rglob("*"):
        if path.is_dir():
            continue
        archive.write(path, path.relative_to(build_dir))
PY

echo "Created $ARTIFACT_PATH"
