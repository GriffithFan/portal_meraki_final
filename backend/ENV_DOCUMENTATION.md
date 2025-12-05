# Variables de Entorno - Portal Meraki

Documentación completa de todas las variables de entorno utilizadas en el backend.

## Índice
- [Variables Requeridas](#variables-requeridas)
- [Variables de Servidor](#variables-de-servidor)
- [Variables de Seguridad](#variables-de-seguridad)
- [Variables de Meraki API](#variables-de-meraki-api)
- [Variables de CORS](#variables-de-cors)
- [Variables de Caché](#variables-de-caché)
- [Variables de Logging](#variables-de-logging)
- [Variables de Performance](#variables-de-performance)
- [Ejemplo de Configuración](#ejemplo-de-configuración)

---

## Variables Requeridas

| Variable | Descripción | Valor por Defecto |
|----------|-------------|-------------------|
| `MERAKI_API_KEY` | API Key de Cisco Meraki Dashboard | *(sin valor)* |
| `JWT_SECRETO` | Clave secreta para firmar tokens JWT | *(sin valor)* |
| `ADMIN_KEY` | Clave para endpoints administrativos | *(sin valor)* |

⚠️ **IMPORTANTE**: Sin `MERAKI_API_KEY`, la aplicación no podrá conectarse a Meraki.

---

## Variables de Servidor

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `NODE_ENV` | Entorno de ejecución | `development` | `production` |
| `PUERTO` | Puerto del servidor HTTP | `3000` | `8080` |
| `HOST` | Dirección de binding | `0.0.0.0` | `127.0.0.1` |
| `TRUST_PROXY_HOPS` | Número de proxies de confianza | `1` | `2` |

### Ejemplo:
```bash
NODE_ENV=production
PUERTO=3000
HOST=0.0.0.0
TRUST_PROXY_HOPS=1
```

---

## Variables de Seguridad

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `JWT_SECRETO` | Clave para firmar tokens JWT | *(requerido)* | `mi_secreto_muy_largo_y_seguro_123!` |
| `ADMIN_KEY` | Clave para endpoints admin | *(requerido)* | `sha256_hash_64_caracteres` |
| `SECOND_ADMIN_KEY` | Clave admin secundaria | *(opcional)* | `clave_secundaria` |

### Notas de Seguridad:
- `JWT_SECRETO` debe tener al menos 32 caracteres para ser seguro
- `ADMIN_KEY` se recomienda usar hash SHA-256 (64 caracteres hex)
- Nunca subir estas claves a repositorios públicos

### Uso de ADMIN_KEY:
```bash
# Como header HTTP
curl -H "x-admin-key: tu_admin_key" https://api.ejemplo.com/admin/endpoint

# Como query parameter
curl "https://api.ejemplo.com/admin/endpoint?admin_key=tu_admin_key"
```

---

## Variables de Meraki API

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `MERAKI_API_KEY` | API Key del Dashboard Meraki | *(requerido)* | `abc123def456...` |
| `MERAKI_ORG_ID` | ID de organización específica | *(todas)* | `123456` |
| `MERAKI_ORG_IDS` | Múltiples IDs separados por coma | *(opcional)* | `123,456,789` |
| `MERAKI_BASE_URL` | URL base de la API Meraki | `https://api.meraki.com/api/v1` | *(usar valor por defecto)* |

### Obtener API Key:
1. Inicia sesión en [dashboard.meraki.com](https://dashboard.meraki.com)
2. Ve a **Organization > Settings > Dashboard API access**
3. Genera una nueva API key

### Comportamiento:
- Si `MERAKI_ORG_ID` no está definido, el sistema recorre todas las organizaciones accesibles
- `MERAKI_ORG_IDS` permite definir múltiples organizaciones separadas por coma

---

## Variables de CORS

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `CORS_ORIGINS` | Orígenes permitidos | `http://localhost:5173` | `https://mi-dominio.com,https://app.mi-dominio.com` |

### Comportamiento:
- En `development`: cualquier origen es permitido
- En `production`: solo orígenes listados en `CORS_ORIGINS`
- Usar `*` permite cualquier origen (no recomendado en producción)

### Ejemplo con múltiples dominios:
```bash
CORS_ORIGINS=https://portal.empresa.com,https://app.empresa.com
```

---

## Variables de Caché

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `ENABLE_WARM_CACHE` | Habilitar precarga de caché | `true` | `false` |
| `WARM_CACHE_SIZE` | Cantidad de predios a precargar | `20` | `50` |
| `LLDP_CACHE_TTL_MS` | TTL de caché LLDP en milisegundos | `600000` (10 min) | `300000` |

### Notas:
- `WARM_CACHE_SIZE` define cuántos predios frecuentes se precargan al iniciar
- Deshabilitar `ENABLE_WARM_CACHE` reduce tiempo de inicio pero aumenta latencia inicial

---

## Variables de Logging

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `NODE_ENV` | Afecta formato de logs | `development` | `production` |

### Comportamiento según NODE_ENV:
- **development**: Logs coloridos, formato legible, nivel `debug`
- **production**: JSON estructurado, nivel `info`, archivo de logs

---

## Variables de Performance

| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `UV_THREADPOOL_SIZE` | Tamaño del pool de threads | `4` (Node default) | `16` |
| `NODE_OPTIONS` | Opciones de Node.js | *(ninguna)* | `--max-old-space-size=1024` |

### Variables de Predios:
| Variable | Descripción | Valor por Defecto | Ejemplo |
|----------|-------------|-------------------|---------|
| `PREDIOS_REFRESH_INTERVAL_MINUTES` | Intervalo de actualización | `30` | `60` |
| `PREDIOS_REFRESH_INITIAL_DELAY_MS` | Delay inicial antes de primera actualización | `30000` | `60000` |

---

## Ejemplo de Configuración

### Desarrollo Local (.env)
```bash
# Servidor
NODE_ENV=development
PUERTO=3000
HOST=0.0.0.0

# Meraki API
MERAKI_API_KEY=tu_api_key_aqui
MERAKI_ORG_ID=123456789

# Seguridad
JWT_SECRETO=desarrollo_secreto_local_muy_largo_123
ADMIN_KEY=clave_desarrollo

# CORS
CORS_ORIGINS=http://localhost:5173

# Caché
ENABLE_WARM_CACHE=true
WARM_CACHE_SIZE=10
```

### Producción (.env.production)
```bash
# Servidor
NODE_ENV=production
PUERTO=3000
HOST=0.0.0.0
TRUST_PROXY_HOPS=1

# Meraki API
MERAKI_API_KEY=tu_api_key_produccion
MERAKI_ORG_ID=123456789

# Seguridad (usar valores fuertes!)
JWT_SECRETO=clave_jwt_muy_larga_y_segura_para_produccion_min_32_chars
ADMIN_KEY=e58a89f9f23220f83b37330fa7a4794415633275dd94effc947bb3d128d86aa6

# CORS
CORS_ORIGINS=https://portal.empresa.com

# Caché
ENABLE_WARM_CACHE=true
WARM_CACHE_SIZE=50

# Performance
UV_THREADPOOL_SIZE=16
```

---

## Validación de Configuración

La aplicación valida la configuración al iniciar. Para verificar:

```bash
# Ver estado de configuración
curl http://localhost:3000/api/status

# Respuesta ejemplo:
{
  "status": "ok",
  "config": {
    "nodeEnv": "development",
    "hasApiKey": true,
    "hasOrgId": true
  }
}
```

---

## Troubleshooting

### "ADMIN_KEY no configurada"
```bash
# Añadir a .env:
ADMIN_KEY=tu_clave_admin
```

### "Error de autenticación JWT"
```bash
# Verificar que JWT_SECRETO esté definido:
JWT_SECRETO=tu_secreto_jwt
```

### "No se pueden obtener dispositivos de Meraki"
```bash
# Verificar API key:
MERAKI_API_KEY=tu_api_key_valida

# Verificar permisos de la API key en Meraki Dashboard
```

### CORS bloqueando requests
```bash
# Añadir dominio del frontend:
CORS_ORIGINS=https://tu-frontend.com
```
