#!/bin/bash
# Compila la app «Chats» y la instala en el iPhone conectado a esta Mac.
# Requisitos: Xcode con tu Apple ID agregado (Xcode → Ajustes → Cuentas) y el iPhone conectado
# por cable, desbloqueado, con «Confiar en esta computadora» y el Modo de desarrollador activado.
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="${BUNDLE_ID:-com.d8j4yc4v75.chats}"

# Equipo de firma: el OU del certificado «Apple Development» (o pásalo con TEAM=XXXXXXXXXX ./instalar.sh)
if [ -z "${TEAM:-}" ]; then
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1 || true)"
fi
if [ -z "${TEAM:-}" ]; then
  echo "No encontré tu equipo de firma. Abre Xcode → Ajustes → Cuentas, agrega tu Apple ID y vuelve a correr esto." >&2
  exit 1
fi
echo "Equipo de firma: $TEAM"

# iPhone conectado
DEV="${DEVICE:-}"
if [ -z "$DEV" ]; then
  TMP="$(mktemp)"
  xcrun devicectl list devices --json-output "$TMP" >/dev/null
  DEV="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
for x in d.get("result",{}).get("devices",[]):
    hp=x.get("hardwareProperties",{}); cp=x.get("connectionProperties",{})
    if hp.get("deviceType")=="iPhone" and cp.get("pairingState")=="paired":
        print(x.get("identifier")); break
' "$TMP")"
  rm -f "$TMP"
fi
if [ -z "$DEV" ]; then
  echo "No encontré un iPhone conectado y emparejado. Conéctalo por cable, desbloquéalo y toca «Confiar»." >&2
  exit 1
fi
echo "iPhone: $DEV"

xcodebuild -project Chats.xcodeproj -target Chats -configuration Release -sdk iphoneos \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" CODE_SIGN_STYLE=Automatic \
  build | tail -20

APP="build/Release-iphoneos/Chats.app"
xcrun devicectl device install app --device "$DEV" "$APP"
xcrun devicectl device process launch --device "$DEV" "$BUNDLE_ID" || \
  echo "Instalada. Si no abre: en el iPhone ve a Ajustes → General → VPN y administración de dispositivos y confía en tu cuenta de desarrollador."
