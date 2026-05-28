#!/bin/bash
# Uso: ./deploy.sh "/percorso/Programma Need copia X.zip"
# Estrae il codice dal zip ricevuto dal cliente e riavvia l'app.
set -e

ZIP="$1"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACT_DIR=$(mktemp -d)

if [ -z "$ZIP" ]; then
  echo "Uso: $0 <path-to-zip>"
  exit 1
fi

echo "[1/4] Estrazione $ZIP..."
unzip -o "$ZIP" -d "$EXTRACT_DIR"

SRC="$EXTRACT_DIR/Programma Need"
if [ ! -d "$SRC" ]; then
  # prova senza sottocartella
  SRC="$EXTRACT_DIR"
fi

echo "[2/4] Copia file..."
rsync -a \
  --exclude='.env' \
  --exclude='uploads/' \
  --exclude='*.log' \
  --exclude='*.err.log' \
  --exclude='data/' \
  --exclude='docker-compose.yml' \
  --exclude='deploy.sh' \
  --exclude='.gitignore' \
  --exclude='.git/' \
  "$SRC/" "$DEPLOY_DIR/"

echo "[3/4] Riavvio container app..."
cd "$DEPLOY_DIR"
docker-compose restart app

rm -rf "$EXTRACT_DIR"

echo "[4/4] Deploy completato!"
docker-compose ps app
