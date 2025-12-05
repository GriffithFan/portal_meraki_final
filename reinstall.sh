#!/bin/bash

# ==============================================
# Portal Meraki - Script de Reinstalación
# Migración desde portal_web_deploy a portal_meraki_final
# ==============================================

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Variables
NEW_REPO="https://github.com/GriffithFan/portal_meraki_final.git"
PROJECT_DIR="/root/portal-meraki-deploy"
BACKUP_DIR="/tmp/portal-meraki-backup-$(date +%Y%m%d_%H%M%S)"

echo -e "${BLUE}=========================================="
echo "Portal Meraki - Reinstalación Completa"
echo "=========================================="
echo -e "${NC}"
echo "Este script:"
echo "  1. Hace backup de tus datos (tecnicos.json, predios.csv, .env)"
echo "  2. Elimina el proyecto actual"
echo "  3. Clona el nuevo repositorio (portal_meraki_final)"
echo "  4. Restaura tus datos"
echo "  5. Reconstruye e inicia los servicios"
echo ""
echo -e "${YELLOW}Nuevo repositorio: ${NEW_REPO}${NC}"
echo ""

# Confirmación
read -p "¿Continuar con la reinstalación? (s/N): " confirm
if [[ ! "$confirm" =~ ^[sS]$ ]]; then
    echo "Operación cancelada."
    exit 0
fi

echo ""
echo -e "${YELLOW}Paso 1/8: Creando backup de datos...${NC}"
mkdir -p "$BACKUP_DIR"

# Backup de archivos de datos
if [ -f "$PROJECT_DIR/backend/data/tecnicos.json" ]; then
    cp "$PROJECT_DIR/backend/data/tecnicos.json" "$BACKUP_DIR/"
    echo -e "  ${GREEN}✓${NC} tecnicos.json"
else
    echo -e "  ${YELLOW}⚠${NC} tecnicos.json no encontrado"
fi

if [ -f "$PROJECT_DIR/backend/data/predios.csv" ]; then
    cp "$PROJECT_DIR/backend/data/predios.csv" "$BACKUP_DIR/"
    echo -e "  ${GREEN}✓${NC} predios.csv"
else
    echo -e "  ${YELLOW}⚠${NC} predios.csv no encontrado"
fi

if [ -f "$PROJECT_DIR/backend/.env" ]; then
    cp "$PROJECT_DIR/backend/.env" "$BACKUP_DIR/"
    echo -e "  ${GREEN}✓${NC} .env"
else
    echo -e "  ${YELLOW}⚠${NC} .env no encontrado"
fi

echo -e "  Backup guardado en: ${BLUE}$BACKUP_DIR${NC}"

echo ""
echo -e "${YELLOW}Paso 2/8: Deteniendo servicios PM2...${NC}"
if pm2 describe portal-meraki-backend > /dev/null 2>&1; then
    pm2 stop portal-meraki-backend 2>/dev/null || true
    pm2 delete portal-meraki-backend 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Servicio detenido y eliminado"
else
    echo -e "  ${YELLOW}⚠${NC} Servicio no encontrado en PM2"
fi

echo ""
echo -e "${YELLOW}Paso 3/8: Eliminando proyecto anterior...${NC}"
if [ -d "$PROJECT_DIR" ]; then
    rm -rf "$PROJECT_DIR"
    echo -e "  ${GREEN}✓${NC} Directorio eliminado"
else
    echo -e "  ${YELLOW}⚠${NC} Directorio no existía"
fi

echo ""
echo -e "${YELLOW}Paso 4/8: Clonando nuevo repositorio...${NC}"
git clone "$NEW_REPO" "$PROJECT_DIR"
echo -e "  ${GREEN}✓${NC} Repositorio clonado"

echo ""
echo -e "${YELLOW}Paso 5/8: Restaurando datos...${NC}"

# Restaurar tecnicos.json
if [ -f "$BACKUP_DIR/tecnicos.json" ]; then
    cp "$BACKUP_DIR/tecnicos.json" "$PROJECT_DIR/backend/data/"
    echo -e "  ${GREEN}✓${NC} tecnicos.json restaurado"
fi

# Restaurar predios.csv
if [ -f "$BACKUP_DIR/predios.csv" ]; then
    cp "$BACKUP_DIR/predios.csv" "$PROJECT_DIR/backend/data/"
    echo -e "  ${GREEN}✓${NC} predios.csv restaurado"
fi

# Restaurar .env
if [ -f "$BACKUP_DIR/.env" ]; then
    cp "$BACKUP_DIR/.env" "$PROJECT_DIR/backend/"
    echo -e "  ${GREEN}✓${NC} .env restaurado"
else
    # Si no hay .env, usar el de producción
    if [ -f "$PROJECT_DIR/backend/.env.production" ]; then
        cp "$PROJECT_DIR/backend/.env.production" "$PROJECT_DIR/backend/.env"
        echo -e "  ${YELLOW}⚠${NC} .env creado desde .env.production"
    fi
fi

echo ""
echo -e "${YELLOW}Paso 6/8: Instalando dependencias del backend...${NC}"
cd "$PROJECT_DIR/backend"
npm install --production --no-audit
echo -e "  ${GREEN}✓${NC} Dependencias instaladas"

echo ""
echo -e "${YELLOW}Paso 7/8: Construyendo frontend...${NC}"
cd "$PROJECT_DIR/frontend"
npm install --no-audit
npm run build

if [ -d "dist" ] && [ "$(ls -A dist)" ]; then
    echo -e "  ${GREEN}✓${NC} Frontend construido"
else
    echo -e "  ${RED}✗${NC} Error: Build del frontend falló"
    exit 1
fi

echo ""
echo -e "${YELLOW}Paso 8/8: Iniciando servicios...${NC}"
cd "$PROJECT_DIR/backend"
pm2 start ecosystem.config.js --env production
pm2 save
echo -e "  ${GREEN}✓${NC} Backend iniciado con PM2"

# Recargar nginx
if command -v nginx > /dev/null 2>&1; then
    if nginx -t > /dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} Nginx recargado"
    fi
fi

# Verificar salud del backend
echo ""
echo "Verificando backend..."
sleep 3
if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Backend respondiendo correctamente"
else
    echo -e "  ${YELLOW}⚠${NC} Backend no responde aún (puede tardar unos segundos)"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Reinstalación completada exitosamente"
echo "==========================================${NC}"
echo ""
echo "Repositorio: $NEW_REPO"
echo "Commit: $(cd $PROJECT_DIR && git rev-parse --short HEAD)"
echo ""
echo "Backup guardado en: $BACKUP_DIR"
echo ""
echo -e "${BLUE}Estado de PM2:${NC}"
pm2 status
echo ""
echo "Comandos útiles:"
echo "  pm2 logs portal-meraki-backend    # Ver logs"
echo "  ./update.sh                        # Actualizar desde GitHub"
echo ""
echo -e "${GREEN}¡Listo! El portal ahora se actualiza desde portal_meraki_final${NC}"
echo ""
