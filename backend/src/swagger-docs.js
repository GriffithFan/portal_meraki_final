/**
 * Documentación Swagger/OpenAPI para Portal Meraki
 * Este archivo contiene las anotaciones JSDoc para generar la documentación
 */

// ============================================
// HEALTH ENDPOINTS
// ============================================

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check básico
 *     description: Verifica que el servidor esté funcionando y retorna estadísticas básicas
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Servidor funcionando correctamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthCheck'
 */

/**
 * @swagger
 * /health/full:
 *   get:
 *     summary: Health check completo
 *     description: Verifica conectividad con Meraki API, estado de predios y más
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Todos los servicios funcionando
 *       503:
 *         description: Uno o más servicios degradados
 */

/**
 * @swagger
 * /ready:
 *   get:
 *     summary: Readiness probe
 *     description: Indica si el servidor está listo para recibir tráfico (para Kubernetes)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Servidor listo
 *       503:
 *         description: Servidor no listo
 */

/**
 * @swagger
 * /live:
 *   get:
 *     summary: Liveness probe
 *     description: Indica si el proceso está vivo (para Kubernetes)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Proceso vivo
 */

// ============================================
// AUTH ENDPOINTS
// ============================================

/**
 * @swagger
 * /tecnicos/login:
 *   post:
 *     summary: Login de técnico
 *     description: Autentica un técnico y retorna un token JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login exitoso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       401:
 *         description: Credenciales inválidas
 */

/**
 * @swagger
 * /admin/login:
 *   post:
 *     summary: Login de administrador
 *     description: Verifica la clave administrativa
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *                 description: ADMIN_KEY
 *     responses:
 *       200:
 *         description: Login exitoso
 *       401:
 *         description: Clave incorrecta
 */

// ============================================
// NETWORK ENDPOINTS
// ============================================

/**
 * @swagger
 * /networks/search:
 *   get:
 *     summary: Buscar redes
 *     description: Busca redes por nombre, ID o tags
 *     tags: [Networks]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Término de búsqueda
 *     responses:
 *       200:
 *         description: Lista de redes encontradas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Network'
 */

/**
 * @swagger
 * /resolve-network:
 *   get:
 *     summary: Resolver red por predio o nombre
 *     description: Busca una red por código de predio, nombre exacto o ID
 *     tags: [Networks]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Código de predio, nombre o ID de red
 *     responses:
 *       200:
 *         description: Información de la red
 *       404:
 *         description: Red no encontrada
 */

/**
 * @swagger
 * /networks/{networkId}:
 *   get:
 *     summary: Obtener información de red
 *     description: Retorna detalles de una red específica
 *     tags: [Networks]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la red (ej. L_123456789012345678)
 *     responses:
 *       200:
 *         description: Información de la red
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Network'
 */

// ============================================
// DEVICE ENDPOINTS
// ============================================

/**
 * @swagger
 * /networks/{networkId}/devices:
 *   get:
 *     summary: Listar dispositivos de una red
 *     description: Obtiene todos los dispositivos de una red
 *     tags: [Devices]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de dispositivos
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Device'
 */

/**
 * @swagger
 * /networks/{networkId}/detailed:
 *   get:
 *     summary: Información detallada de red
 *     description: Obtiene información completa incluyendo dispositivos, topología y estado
 *     tags: [Devices]
 *     parameters:
 *       - in: path
 *         name: networkId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Información detallada
 */

// ============================================
// PREDIOS ENDPOINTS
// ============================================

/**
 * @swagger
 * /predios/search:
 *   get:
 *     summary: Buscar predios
 *     description: Busca predios por código, dirección o ciudad
 *     tags: [Predios]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Término de búsqueda
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Límite de resultados
 *     responses:
 *       200:
 *         description: Lista de predios encontrados
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Predio'
 */

/**
 * @swagger
 * /predios/{predioCode}:
 *   get:
 *     summary: Obtener predio por código
 *     description: Retorna información de un predio específico
 *     tags: [Predios]
 *     parameters:
 *       - in: path
 *         name: predioCode
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Información del predio
 *       404:
 *         description: Predio no encontrado
 */

/**
 * @swagger
 * /predios/stats:
 *   get:
 *     summary: Estadísticas de predios
 *     description: Retorna estadísticas del sistema de predios
 *     tags: [Predios]
 *     responses:
 *       200:
 *         description: Estadísticas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 porOrganizacion:
 *                   type: object
 */

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * @swagger
 * /tecnicos:
 *   get:
 *     summary: Listar técnicos
 *     description: Lista todos los técnicos registrados (requiere ADMIN_KEY)
 *     tags: [Admin]
 *     security:
 *       - AdminKey: []
 *     responses:
 *       200:
 *         description: Lista de técnicos
 *       401:
 *         description: No autorizado
 *   post:
 *     summary: Crear técnico
 *     description: Registra un nuevo técnico (requiere ADMIN_KEY)
 *     tags: [Admin]
 *     security:
 *       - AdminKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               nombre:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Técnico creado
 *       401:
 *         description: No autorizado
 */

/**
 * @swagger
 * /tecnicos/{username}:
 *   delete:
 *     summary: Eliminar técnico
 *     description: Elimina un técnico existente (requiere ADMIN_KEY)
 *     tags: [Admin]
 *     security:
 *       - AdminKey: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Técnico eliminado
 *       401:
 *         description: No autorizado
 *       404:
 *         description: Técnico no encontrado
 */

/**
 * @swagger
 * /cache:
 *   delete:
 *     summary: Limpiar caché
 *     description: Limpia toda la caché del servidor (requiere ADMIN_KEY)
 *     tags: [Admin]
 *     security:
 *       - AdminKey: []
 *     responses:
 *       200:
 *         description: Caché limpiada
 *       401:
 *         description: No autorizado
 */

module.exports = {};
