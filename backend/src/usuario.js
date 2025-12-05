// Gestión de técnicos usando archivo JSON
// SEGURIDAD: Migrado de SHA-256 a bcrypt (2025-12-04)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { logger } = require('./config/logger');

// Configuración de bcrypt
const BCRYPT_ROUNDS = 12; // Balance entre seguridad y performance

// Función legacy para verificar hashes SHA-256 (solo lectura, para migración)
function hashPasswordLegacy(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Función para detectar si un hash es SHA-256 o bcrypt
function isLegacyHash(hash) {
  // SHA-256 produce 64 caracteres hexadecimales
  // bcrypt produce ~60 caracteres y empieza con $2b$ o $2a$
  return hash && hash.length === 64 && /^[a-f0-9]+$/.test(hash);
}

// Función para hashear contraseñas con bcrypt (async)
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Función sincrónica para hashear (para compatibilidad)
function hashPasswordSync(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// Path al archivo de técnicos (FUERA de src/ para no ser sobrescrito por git pull)
const TECNICOS_PATH = path.join(__dirname, '../data/tecnicos.json');

// Inicializar archivo de técnicos si no existe
function initTecnicosFile() {
  const dataDir = path.join(__dirname, '../data');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Si no existe tecnicos.json en data/, crearlo o migrar desde src/
  if (!fs.existsSync(TECNICOS_PATH)) {
    const oldPath = path.join(__dirname, 'tecnicos.json');
    
    if (fs.existsSync(oldPath)) {
      const oldData = fs.readFileSync(oldPath, 'utf-8');
      fs.writeFileSync(TECNICOS_PATH, oldData, 'utf-8');
    } else {
      // Crear archivo con usuarios por defecto (hashes legacy SHA-256)
      // Se migrarán automáticamente a bcrypt en el primer login exitoso
      const defaultUsers = [
        { username: "tecnico1@empresa.com", password: "9010e72389a80487d473017425c6ec7951068abed82a4df32459c91f0e45d2ea" },
        { username: "tecnico2@empresa.com", password: "998aab960cd9f809b09dd12eade1de4a2985f62335d8ff45a775a598ead09b06" },
        { username: "tecnico3@empresa.com", password: "ebeaace31a258620999e9fba185031b757451d37dd76b3bea25c5b897bb46be4" },
        { username: "tecnico4@empresa.com", password: "ae84504e96e41376c2b23e773fc66a6689f60bdd3f68a0909c4a4ccaa554fb2b" },
        { username: "tecnico5@empresa.com", password: "ae4379b9e5aed205fb7a1e6899aaaf7fa1a38d03031bf116331454fc99d02d56" },
        { username: "griffith@fan.com", password: "000c22deec6ed2c7475d34bff05884884bfe71848ffef5571adb66ef8e46aa8f" }
      ];
      fs.writeFileSync(TECNICOS_PATH, JSON.stringify(defaultUsers, null, 2), 'utf-8');
    }
  }
}

// Ejecutar inicialización al cargar el módulo
initTecnicosFile();

// Función para validar usuario y contraseña (con migración automática a bcrypt)
async function validarTecnico(username, password) {
  try {
    const data = fs.readFileSync(TECNICOS_PATH, 'utf-8');
    const tecnicos = JSON.parse(data);
    const tecnico = tecnicos.find(t => t.username === username);
    
    if (!tecnico) {
      return false;
    }
    
    // Verificar si es hash legacy (SHA-256)
    if (isLegacyHash(tecnico.password)) {
      // Comparar con hash SHA-256
      const legacyHash = hashPasswordLegacy(password);
      if (tecnico.password === legacyHash) {
        // ¡Login exitoso! Migrar a bcrypt automáticamente
        logger.info(`[usuario.js] Migrando contraseña de ${username} a bcrypt`);
        tecnico.password = await hashPassword(password);
        tecnico.migratedAt = new Date().toISOString();
        guardarTecnicos(tecnicos);
        return true;
      }
      return false;
    }
    
    // Verificar con bcrypt
    return bcrypt.compare(password, tecnico.password);
  } catch (error) {
    logger.error('Error validando técnico:', { error: error.message });
    return false;
  }
}

// Versión sincrónica para compatibilidad (NO migra automáticamente)
function validarTecnicoSync(username, password) {
  try {
    const data = fs.readFileSync(TECNICOS_PATH, 'utf-8');
    const tecnicos = JSON.parse(data);
    const tecnico = tecnicos.find(t => t.username === username);
    
    if (!tecnico) {
      return false;
    }
    
    // Verificar si es hash legacy (SHA-256)
    if (isLegacyHash(tecnico.password)) {
      const legacyHash = hashPasswordLegacy(password);
      return tecnico.password === legacyHash;
    }
    
    // Verificar con bcrypt
    return bcrypt.compareSync(password, tecnico.password);
  } catch (error) {
    logger.error('Error validando técnico (sync):', { error: error.message });
    return false;
  }
}

function listarTecnicos() {
  try {
    const data = fs.readFileSync(TECNICOS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Buscar técnico por username (retorna objeto sin password)
function buscarTecnico(username) {
  const tecnicos = listarTecnicos();
  const tecnico = tecnicos.find(t => t.username === username);
  if (!tecnico) return null;
  // Retornar sin password por seguridad
  const { password, ...tecnicoSinPassword } = tecnico;
  return tecnicoSinPassword;
}

function guardarTecnicos(list) {
  fs.writeFileSync(TECNICOS_PATH, JSON.stringify(list, null, 2), 'utf-8');
}

// Agregar técnico con bcrypt (async)
async function agregarTecnico(username, password) {
  const list = listarTecnicos();
  if (list.find(t => t.username === username)) {
    return { ok: false, error: 'Usuario ya existe' };
  }
  const hashedPassword = await hashPassword(password);
  list.push({ 
    username, 
    password: hashedPassword,
    createdAt: new Date().toISOString()
  });
  guardarTecnicos(list);
  return { ok: true };
}

// Versión sincrónica para compatibilidad
function agregarTecnicoSync(username, password) {
  const list = listarTecnicos();
  if (list.find(t => t.username === username)) {
    return { ok: false, error: 'Usuario ya existe' };
  }
  const hashedPassword = hashPasswordSync(password);
  list.push({ 
    username, 
    password: hashedPassword,
    createdAt: new Date().toISOString()
  });
  guardarTecnicos(list);
  return { ok: true };
}

function eliminarTecnico(username) {
  const list = listarTecnicos();
  const next = list.filter(t => t.username !== username);
  if (next.length === list.length) {
    return { ok: false, error: 'Usuario no encontrado' };
  }
  guardarTecnicos(next);
  return { ok: true };
}

// Cambiar contraseña de un técnico (async)
async function cambiarPassword(username, newPassword) {
  const list = listarTecnicos();
  const tecnico = list.find(t => t.username === username);
  if (!tecnico) {
    return { ok: false, error: 'Usuario no encontrado' };
  }
  tecnico.password = await hashPassword(newPassword);
  tecnico.passwordChangedAt = new Date().toISOString();
  guardarTecnicos(list);
  return { ok: true };
}

module.exports = { 
  validarTecnico,
  validarTecnicoSync,
  listarTecnicos,
  buscarTecnico,
  agregarTecnico,
  agregarTecnicoSync,
  eliminarTecnico,
  cambiarPassword,
  // Exportar constantes para testing
  BCRYPT_ROUNDS,
  isLegacyHash
};
