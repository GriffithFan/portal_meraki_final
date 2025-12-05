/**
 * Configuración de Swagger/OpenAPI para Portal Meraki
 */
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Portal Meraki API',
      version: '1.0.0',
      description: `API REST para el Portal Meraki - Gestión de dispositivos de red Cisco Meraki.
      
Esta API proporciona acceso a:
- **Autenticación** de técnicos y administradores
- **Redes y Dispositivos** Meraki (appliances, switches, access points)
- **Predios** - Sistema de gestión de predios con CSV
- **Topología** de red
- **Monitoreo** de estado y conectividad`,
      contact: {
        name: 'Soporte Portal Meraki'
      },
      license: {
        name: 'Uso interno',
      }
    },
    servers: [
      {
        url: '/api',
        description: 'API Server'
      }
    ],
    tags: [
      { name: 'Health', description: 'Endpoints de salud y diagnóstico' },
      { name: 'Auth', description: 'Autenticación y gestión de usuarios' },
      { name: 'Networks', description: 'Búsqueda y gestión de redes' },
      { name: 'Devices', description: 'Dispositivos Meraki' },
      { name: 'Predios', description: 'Sistema de gestión de predios' },
      { name: 'Topology', description: 'Topología de red' },
      { name: 'Admin', description: 'Endpoints administrativos (requieren ADMIN_KEY)' }
    ],
    components: {
      securitySchemes: {
        AdminKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-admin-key',
          description: 'Clave administrativa para endpoints protegidos'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT para técnicos autenticados'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Mensaje de error' },
            message: { type: 'string', description: 'Descripción del error' }
          }
        },
        HealthCheck: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OK', 'healthy', 'degraded'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
            uptime: { type: 'integer', description: 'Uptime en segundos' },
            memory: {
              type: 'object',
              properties: {
                used: { type: 'integer', description: 'Memoria usada en MB' },
                total: { type: 'integer', description: 'Memoria total en MB' }
              }
            }
          }
        },
        Network: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'L_123456789012345678' },
            name: { type: 'string', example: 'Red Principal' },
            organizationId: { type: 'string' },
            productTypes: { 
              type: 'array', 
              items: { type: 'string' },
              example: ['appliance', 'switch', 'wireless']
            },
            tags: { type: 'array', items: { type: 'string' } }
          }
        },
        Device: {
          type: 'object',
          properties: {
            serial: { type: 'string', example: 'Q2PN-XXXX-YYYY' },
            name: { type: 'string' },
            model: { type: 'string', example: 'MX68' },
            mac: { type: 'string', example: 'e4:55:a8:55:f2:6d' },
            networkId: { type: 'string' },
            status: { type: 'string', enum: ['online', 'offline', 'alerting'] }
          }
        },
        Predio: {
          type: 'object',
          properties: {
            predio_code: { type: 'string', example: 'PREDIO001' },
            network_id: { type: 'string' },
            organization_id: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' }
          }
        },
        LoginRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', example: 'tecnico1' },
            password: { type: 'string', format: 'password' }
          }
        },
        LoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            token: { type: 'string', description: 'JWT token' },
            tecnico: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                nombre: { type: 'string' }
              }
            }
          }
        }
      }
    }
  },
  apis: ['./src/swagger-docs.js'] // Archivo con anotaciones JSDoc
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
