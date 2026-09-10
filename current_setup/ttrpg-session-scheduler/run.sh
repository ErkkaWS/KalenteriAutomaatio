#!/bin/sh
# Tämä tiedosto EI sisällä mitään salaista — se vain lataa
# secrets.env-tiedoston (joka on erikseen suojattu, chmod 600)
# ja ajaa sen jälkeen itse skriptin.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE="$SCRIPT_DIR/secrets.env"

if [ ! -f "$SECRETS_FILE" ]; then
    echo "VIRHE: $SECRETS_FILE puuttuu." >&2
    echo "Kopioi secrets.env.example nimelle secrets.env ja täytä oikeat webhook-osoitteet." >&2
    exit 1
fi

# Varoitus jos oikeudet ovat liian löysät (kuka tahansa koneella voisi lukea)
PERMS=$(stat -c "%a" "$SECRETS_FILE" 2>/dev/null || stat -f "%OLp" "$SECRETS_FILE" 2>/dev/null)
if [ "$PERMS" != "600" ]; then
    echo "VAROITUS: $SECRETS_FILE oikeudet ovat $PERMS, pitäisi olla 600. Aja: chmod 600 $SECRETS_FILE" >&2
fi

. "$SECRETS_FILE"

python3 "$SCRIPT_DIR/check.py"
