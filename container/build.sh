#!/bin/bash
# Build the agent container image.
#
# Reads optional build flags from the caller's env, falling back to ../.env:
#   BRAND_NAMESPACE=acme     — image name prefix (default: agentdesk)
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)

set -e

# pwd -P resolves symlinks — Node's process.cwd() returns the physical path,
# so the slug input must be physical on this side too or the names diverge.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$SCRIPT_DIR"

# Brand namespace — caller's env takes precedence, then .env, then default.
# Must produce the exact same value the host derives in src/branding.ts,
# otherwise the host looks for an image this script never built.
if [ -z "${BRAND_NAMESPACE:-}" ] && [ -f "../.env" ]; then
    BRAND_NAMESPACE="$(grep -E '^[[:space:]]*BRAND_NAMESPACE=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi
# Sanitize to a DNS/label-safe slug. Mirrors sanitizeNamespace in src/branding.ts.
BRAND_NAMESPACE="$(printf '%s' "${BRAND_NAMESPACE:-}" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9-]/-/g' -e 's/^-*//' -e 's/-*$//')"
BRAND_NAMESPACE="${BRAND_NAMESPACE:-agentdesk}"

# Derive the image name from the checkout path so two installs on the same
# host don't clobber each other. Mirrors src/install-slug.ts.
if command -v shasum >/dev/null 2>&1; then
    INSTALL_SLUG="$(printf '%s' "$PROJECT_ROOT" | shasum | cut -c1-8)"
else
    INSTALL_SLUG="$(printf '%s' "$PROJECT_ROOT" | sha1sum | cut -c1-8)"
fi
IMAGE_NAME="${CONTAINER_IMAGE_BASE:-${BRAND_NAMESPACE}-agent-v2-${INSTALL_SLUG}}"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

echo "Building agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
