#!/usr/bin/env bash
# Fills in PKGBUILD for a GitHub release of Oatmeal and writes it, with .SRCINFO, to a work directory.
# With --push, commits both to the AUR (needs an SSH key the AUR account accepts).
#
#   packaging/aur/publish.sh 0.1.1-beta.7            # prepare only; prints the directory (try `makepkg -si` there)
#   packaging/aur/publish.sh 0.1.1-beta.7 --push     # what release.yml runs
#
# Needs makepkg (Arch), curl and git. makepkg refuses to run as root.
set -euo pipefail

version=${1:?usage: publish.sh <version> [--push]}
push=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=https://github.com/angelplusultra/oatmeal

# The AUR's pkgver can't contain "-": 0.1.1-beta.7 becomes 0.1.1beta7, which vercmp sorts before 0.1.1.
base=${version%%-*}
pre=${version#"$base"}
pre=${pre#-}
pkgver=$base${pre//./}

work=$(mktemp -d)
# Download into the work directory under the source names, so makepkg reuses the files instead of fetching again.
curl -fsSL -o "$work/oatmeal-$version.pacman" "$repo/releases/download/v$version/oatmeal-$version.pacman"
curl -fsSL -o "$work/LICENSE-$version" "https://raw.githubusercontent.com/angelplusultra/oatmeal/v$version/LICENSE"
sha_pacman=$(sha256sum "$work/oatmeal-$version.pacman" | cut -d' ' -f1)
sha_license=$(sha256sum "$work/LICENSE-$version" | cut -d' ' -f1)

sed -e "s/@VERSION@/$version/" -e "s/@PKGVER@/$pkgver/" \
  -e "s/@SHA256_PACMAN@/$sha_pacman/" -e "s/@SHA256_LICENSE@/$sha_license/" \
  "$here/PKGBUILD" >"$work/PKGBUILD"
(cd "$work" && makepkg --printsrcinfo >.SRCINFO)

if [ "$push" != --push ]; then
  echo "$work"
  exit 0
fi

aur=$(mktemp -d)
git clone -q ssh://aur@aur.archlinux.org/oatmeal-notes-bin.git "$aur"
cp "$work/PKGBUILD" "$work/.SRCINFO" "$aur/"
cd "$aur"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
  echo "The AUR already has $version."
  exit 0
fi
git -c user.name='Oatmeal release' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -q -m "Update to $version"
git push -q origin HEAD:master
echo "Published oatmeal-notes-bin $pkgver to the AUR."
