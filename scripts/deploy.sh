#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IMAGE_NAME:-}" ]; then
  echo "IMAGE_NAME is required"
  exit 1
fi

mkdir -p ./data
IMAGE_NAME="$IMAGE_NAME" docker compose pull
IMAGE_NAME="$IMAGE_NAME" docker compose up -d --remove-orphans
# Remove superseded tagged images after the new container is running.
docker image prune -af
