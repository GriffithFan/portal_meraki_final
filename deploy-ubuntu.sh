#!/bin/bash

# ==============================================
# Portal Meraki - Deploy Script para Ubuntu VPS
# ==============================================

set -e  # Salir si cualquier comando falla

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Variables de configuración
DOMAIN="portalmeraki.info"
PROJECT_DIR="/root/portal-meraki-deploy"
NGINX_SITE="/etc/nginx/sites-available/portal-meraki"
SERVICE_USER="root"

echo -e "${BLUE}Portal Meraki - Deployment en Ubuntu VPS${NC}"
echo -e "${BLUE}===============================================${NC}"

# Verificar si se ejecuta como root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Este script debe ejecutarse como root${NC}"
    echo "Usa: sudo ./deploy-ubuntu.sh"
    exit 1
fi

echo -e "${YELLOW}1. Actualizando sistema y instalando dependencias...${NC}"
apt update && apt upgrade -y
apt install -y curl wget git nginx certbot python3-certbot-nginx

# Instalar Node.js 20
echo -e "${YELLOW}2. Instalando Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Instalar PM2 globalmente
echo -e "${YELLOW}3. Instalando PM2...${NC}"
npm install -g pm2

echo -e "${YELLOW}4. Configurando directorio del proyecto...${NC}"
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# Clonar o copiar el proyecto (asumimos que ya está copiado)
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo -e "${RED}Error: No se encontraron las carpetas backend y frontend${NC}"
    echo "Asegúrate de que el proyecto esté en $PROJECT_DIR"
    exit 1
fi

echo -e "${YELLOW}5. Instalando dependencias del backend...${NC}"
cd $PROJECT_DIR/backend
npm install --production

echo -e "${YELLOW}6. Configurando variables de entorno...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Usando configuración de producción...${NC}"
    cp .env.production .env
    echo -e "${GREEN}Variables de entorno configuradas para producción${NC}"
else
    echo -e "${GREEN}Archivo .env ya existe, manteniéndolo${NC}"
fi

echo -e "${YELLOW}7. Instalando dependencias del frontend...${NC}"
cd $PROJECT_DIR/frontend
npm install

echo -e "${YELLOW}8. Construyendo frontend para producción...${NC}"
npm run build

echo -e "${YELLOW}9. Configurando Nginx...${NC}"
cat > $NGINX_SITE << 'EOF'
server {
    listen 80;
    server_name portalmeraki.info www.portalmeraki.info 72.61.32.146;
    
    # Servir frontend estático
    location / {
        root /root/portal-meraki-deploy/frontend/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
        
        # No cachear Service Worker ni HTML (CRÍTICO para actualizaciones PWA)
        location ~* (sw\.js|index\.html)$ {
            add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
            expires off;
        }

        # Caché para assets estáticos
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
    
    # Proxy para API del backend
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }
    
    # Configuraciones de seguridad
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
}
EOF

# Habilitar el sitio
ln -sf $NGINX_SITE /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Verificar configuración de nginx
nginx -t

echo -e "${YELLOW}10. Creando directorios de logs...${NC}"
mkdir -p $PROJECT_DIR/backend/logs
chown -R $SERVICE_USER:$SERVICE_USER $PROJECT_DIR

echo -e "${YELLOW}11. Configurando PM2...${NC}"
cd $PROJECT_DIR/backend
# Iniciar la aplicación con PM2
sudo -u $SERVICE_USER pm2 start ecosystem.config.js --env production
sudo -u $SERVICE_USER pm2 save
sudo -u $SERVICE_USER pm2 startup systemd

echo -e "${YELLOW}12. Reiniciando servicios...${NC}"
systemctl restart nginx
systemctl enable nginx

echo -e "${GREEN}¡Deployment completado!${NC}"
echo -e "${GREEN}================================${NC}"
echo -e "Frontend: ${BLUE}http://$DOMAIN${NC}"
echo -e "Backend API: ${BLUE}http://$DOMAIN/api${NC}"
echo -e ""
echo -e "${YELLOW}Próximos pasos:${NC}"
echo -e "1. Configura DNS: A record $DOMAIN -> $(curl -s ifconfig.me)"
echo -e "2. Obtén certificado SSL:"
echo -e "   ${BLUE}certbot --nginx -d $DOMAIN -d www.$DOMAIN${NC}"
echo -e "3. Verifica que PM2 esté corriendo:"
echo -e "   ${BLUE}sudo -u $SERVICE_USER pm2 status${NC}"
echo -e "4. Ver logs en tiempo real:"
echo -e "   ${BLUE}sudo -u $SERVICE_USER pm2 logs portal-meraki${NC}"
echo -e ""
echo -e "${GREEN}¡Tu aplicación debería estar funcionando ahora!${NC}"