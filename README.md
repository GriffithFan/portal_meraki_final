# Portal Meraki

Dashboard de monitoreo para redes Cisco Meraki. Permite a equipos de soporte (NOC) visualizar estado de dispositivos, topologia de red y metricas wireless en tiempo real.

## Requisitos

- Ubuntu 22.04 LTS
- Node.js 20+
- Dominio con DNS configurado
- API Key de Meraki Dashboard

## Instalacion

```bash
cd /root
git clone https://github.com/GriffithFan/portal_web_deploy.git portal-meraki-deploy
cd portal-meraki-deploy
chmod +x *.sh
./deploy-ubuntu.sh
certbot --nginx -d tu-dominio.com
```

El script instala Node.js, PM2 y Nginx, configura el proxy reverso y levanta los servicios.

## Actualizacion

```bash
cd /root/portal-meraki-deploy
./update.sh
```

## Configuracion

Editar `backend/.env.production`:

```bash
MERAKI_API_KEY=tu_api_key
MERAKI_ORG_ID=              # opcional
ADMIN_KEY=clave_admin_32chars
NODE_ENV=production
PUERTO=3000
HOST=127.0.0.1
CORS_ORIGINS=https://tu-dominio.com
LLDP_CACHE_TTL_MS=600000
ENABLE_WARM_CACHE=true
UV_THREADPOOL_SIZE=16
TRUST_PROXY_HOPS=1
```

Para cambiar claves en produccion:

```bash
sed -i 's|^MERAKI_API_KEY=.*|MERAKI_API_KEY=nueva_key|' backend/.env.production
pm2 restart portal-meraki-backend
```

## Desarrollo local

Backend:
```bash
cd backend
npm install
npm run dev
# http://localhost:3000
```

Frontend:
```bash
cd frontend
npm install
npm run dev
# http://localhost:5173
```

## API

### Autenticacion
- `POST /api/login` - Login de tecnicos

### Redes
- `GET /api/resolve-network?q={codigo}` - Resolver predio por codigo
- `GET /api/networks/{id}/summary` - Resumen de red
- `GET /api/networks/{id}/section/switches` - Switches
- `GET /api/networks/{id}/section/access_points` - Access Points
- `GET /api/networks/{id}/section/appliances` - Appliances MX

### Administracion (requiere ADMIN_KEY)
- `GET /api/predios` - Catalogo de predios
- `GET /api/tecnicos` - Listar tecnicos
- `POST /api/tecnicos` - Crear tecnico
- `DELETE /api/tecnicos/{username}` - Eliminar tecnico

### Health
- `GET /api/health` - Estado del servicio

## Estructura

```
portal-meraki-deploy/
├── backend/
│   ├── src/
│   │   ├── servidor.js
│   │   ├── merakiApi.js
│   │   ├── auth.js
│   │   ├── prediosManager.js
│   │   └── controllers/
│   ├── data/
│   │   └── predios.csv
│   └── ecosystem.config.js
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   └── pages/
│   └── vite.config.js
├── deploy-ubuntu.sh
├── update.sh
└── nginx-portal-meraki.conf
```

## Comandos utiles

```bash
# PM2
pm2 status
pm2 logs portal-meraki-backend
pm2 restart portal-meraki-backend

# Nginx
nginx -t
systemctl reload nginx
tail -f /var/log/nginx/error.log

# Debug
netstat -tlnp | grep 3000
```

## Troubleshooting

**Backend no inicia:**
```bash
pm2 logs portal-meraki-backend --err
```

**Frontend no actualiza:**
```bash
cd frontend && rm -rf dist && npm run build
systemctl reload nginx
```

**502 Bad Gateway:**
```bash
pm2 status
pm2 restart portal-meraki-backend
```

## PWA

La aplicacion es instalable como PWA:
- Android: Menu > Instalar app
- iOS: Compartir > Agregar a pantalla de inicio
- Desktop: Icono en barra de URL > Instalar

## Documentacion adicional

- [DEPLOY.md](./DEPLOY.md) - Guia completa de despliegue
- [SSH_KEY_MANAGEMENT.md](./SSH_KEY_MANAGEMENT.md) - Gestion de claves por SSH
- [CHANGELOG.md](./CHANGELOG.md) - Historial de cambios

## Licencia

Proyecto privado para uso empresarial.

