#!/bin/bash
set -e

VERSION="${1:?Usage: ./update-version.sh <version> (e.g. v1)}"

git tag -fa "$VERSION" -m "$VERSION"
git push origin "$VERSION" --force
