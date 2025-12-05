// Controlador de autenticación de usuarios
const jwt = require('jsonwebtoken');
const { buscarPorCorreo } = require('./usuario');
const { logger } = require('./config/logger');

// Iniciar sesión
async function login(req, res) {
  const { correo, contraseña } = req.body;
  // Buscar usuario en la base de datos
  const usuario = await buscarPorCorreo(correo);
  // Registrar sólo información no sensible para diagnóstico
  if (usuario) {
    logger.debug(`Inicio de sesión solicitado para usuario id=${usuario.id} correo=${correo}`);
  } else {
    logger.debug(`Intento de login para correo=${correo} — usuario no encontrado`);
  }
  if (!usuario) {
    return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
  }
  // Compatibilidad con campo mal codificado
  const passBD = usuario.contraseña || usuario['contrase¤a'] || usuario.password;
  if (passBD !== contraseña) {
    return res.status(401).json({ mensaje: 'Credenciales incorrectas' });
  }
  // Generar token JWT
  const token = jwt.sign({ id: usuario.id, correo: usuario.correo }, process.env.JWT_SECRETO, { expiresIn: '8h' });
  res.json({ token });
}

module.exports = { login };
