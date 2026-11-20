#!/bin/bash
# Compila la app Coach y la instala en el iPhone conectado a esta Mac.
# Uso: bash mac/instalar.sh      (con la cuenta gratis de Apple hay que repetirlo cada 7 días)
set -euo pipefail
cd "$(dirname "$0")/.."

# Trae los cambios más recientes del proyecto antes de compilar
if [ -d .git ]; then git pull --ff-only --quiet 2>/dev/null && echo "› Proyecto actualizado" || echo "› No pude actualizar el proyecto; compilo la versión que ya tienes"; fi

echo "› Revisando Xcode…"
if [ ! -d /Applications/Xcode.app ] && ! xcodebuild -version >/dev/null 2>&1; then
  echo "Falta Xcode. Instálalo desde la App Store, ábrelo una vez y vuelve a correr esto."
  open "macappstore://apps.apple.com/app/id497799835" 2>/dev/null || true
  exit 1
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode está instalado pero la Terminal no lo usa. Corre esto (te pedirá la contraseña de la Mac) y vuelve a intentar:"
  echo "  sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept && xcodebuild -runFirstLaunch"
  exit 1
fi

# XcodeGen arma el proyecto de Xcode desde project.yml; sin Homebrew se baja el binario oficial
XCODEGEN=$(command -v xcodegen || true)
if [ -z "$XCODEGEN" ]; then
  if command -v brew >/dev/null; then brew install xcodegen; XCODEGEN=$(command -v xcodegen)
  else
    mkdir -p .tools && curl -fsSL -o .tools/xcodegen.zip https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip
    (cd .tools && unzip -oq xcodegen.zip) && XCODEGEN="$PWD/.tools/xcodegen/bin/xcodegen"
  fi
fi
"$XCODEGEN" generate --quiet

# Equipo de firma: el de la cuenta de Apple que agregaste en Xcode › Settings › Accounts
TEAM="${TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM=$(for key in IDEProvisioningTeamByIdentifier IDEProvisioningTeams; do
      defaults export com.apple.dt.Xcode - 2>/dev/null | plutil -extract "$key" xml1 -o - - 2>/dev/null
    done | grep -A1 '<key>teamID</key>' | grep -o '<string>[A-Z0-9]*</string>' | head -1 | sed 's/<[^>]*>//g' || true)
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
