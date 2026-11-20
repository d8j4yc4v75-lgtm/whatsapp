#!/bin/bash
# Compila la app Coach y la instala en el iPhone conectado a esta Mac.
# Uso: bash mac/instalar.sh      (con la cuenta gratis de Apple hay que repetirlo cada 7 días)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› Revisando Xcode…"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Falta Xcode. Instálalo desde la App Store, ábrelo una vez y vuelve a correr esto."; exit 1
fi

if ! command -v xcodegen >/dev/null; then
  if command -v brew >/dev/null; then brew install xcodegen
  else echo "Falta XcodeGen. Instala Homebrew (https://brew.sh) y vuelve a correr esto."; exit 1; fi
fi
xcodegen generate --quiet

# Equipo de firma: el de la cuenta de Apple que agregaste en Xcode › Settings › Accounts
TEAM="${TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM=$(defaults export com.apple.dt.Xcode - 2>/dev/null | plutil -extract IDEProvisioningTeamByIdentifier json -o - - 2>/dev/null \
    | grep -o '"teamID":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4 || true)
fi
if [ -z "$TEAM" ]; then
  echo "No encontré tu cuenta de Apple en Xcode. Abre Xcode › Settings › Accounts › + › Apple ID, entra y vuelve a correr esto."; exit 1
fi
echo "› Equipo de firma: $TEAM"

DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /(available|connected)/ {for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/) {print $i; exit}}' || true)
if [ -z "$DEVICE" ]; then
  echo "No veo tu iPhone. Conéctalo con cable, desbloquéalo y toca «Confiar». Si es la primera vez, activa"
  echo "Ajustes › Privacidad y seguridad › Modo de desarrollador en el iPhone (aparece después de conectarlo a Xcode)."; exit 1
fi
echo "› iPhone: $DEVICE"

echo "› Compilando (la primera vez tarda unos minutos)…"
xcodebuild -quiet -project Coach.xcodeproj -scheme Coach -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" build

APP=build/Build/Products/Debug-iphoneos/Coach.app
echo "› Instalando en el iPhone…"
xcrun devicectl device install app --device "$DEVICE" "$APP"
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist")
if ! xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" >/dev/null 2>&1; then
  echo "Instalada. Antes de abrirla la primera vez: en el iPhone ve a Ajustes › General › VPN y gestión de dispositivos,"
  echo "toca tu Apple ID y «Confiar»."
else
  echo "Listo: Coach se abrió en tu iPhone."
fi
