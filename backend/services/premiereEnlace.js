/**
 * El enlace con Premiere: la extension «Pensadero» (premiere/extension) da un
 * latido cada dos segundos con el proyecto que tiene abierto, y en la
 * respuesta recoge lo que hay que importar. Pensadero no puede llamar a
 * Premiere; es Premiere el que pregunta.
 *
 * Un envio pasa por: pendiente -> entregado (la extension se lo ha llevado)
 * -> hecho | error. Mientras importa, la extension va contando el progreso
 * (y eso cuenta como latido: Premiere ocupado no es Premiere cerrado). Si se
 * lo lleva y pasa un minuto y medio sin dar señales, o nadie lo recoge en
 * medio minuto, queda en error con su motivo: nunca espera para siempre.
 *
 * En memoria: al reiniciar Pensadero no hay nada que retomar (la extension
 * vuelve a dar latido sola y lo enviado ya esta en Premiere).
 */

const crypto = require('crypto');

const VIVO_MS = 6000;
// La version del puente que habla este Pensadero. Una extension que manda una
// menor es la de antes, cargada en un Premiere abierto antes de actualizarse:
// hay que reiniciar Premiere (desde la 3 se pone al dia sola).
const PUENTE_ACTUAL = 3;
const SIN_RECOGER_MS = 30000;
const SIN_CONTESTAR_MS = 90000;
const GUARDAR_MS = 60 * 60 * 1000;

function crearEnlace({ ahora = () => Date.now() } = {}) {
  let extension = null; // { ultimo, proyecto, rutaProyecto, version }
  const envios = new Map(); // id -> envio

  const caducar = () => {
    const t = ahora();
    for (const [id, e] of envios) {
      if (e.estado === 'pendiente' && t - e.creado > SIN_RECOGER_MS) {
        e.estado = 'error';
        e.error = 'Premiere no lo ha recogido. ¿Se ha cerrado?';
      } else if (e.estado === 'entregado' && t - (e.actividad || e.entregado) > SIN_CONTESTAR_MS) {
        e.estado = 'error';
        e.error = 'Premiere ha dejado de contestar a mitad. Mira si tiene una ventana abierta esperando respuesta; lo que ya entró se queda en el proyecto.';
      }
      if (t - e.creado > GUARDAR_MS) envios.delete(id);
    }
  };

  function estado() {
    const conectado = !!extension && ahora() - extension.ultimo < VIVO_MS;
    return {
      conectado,
      // Sin proyecto abierto (la pantalla de inicio de Premiere) no se puede importar.
      proyecto: conectado ? extension.proyecto || null : null,
      version: extension ? extension.version || null : null,
      // 1 = extension vieja, que hay que reiniciar Premiere para cambiar.
      puente: extension ? extension.puente : null,
      puenteActual: PUENTE_ACTUAL,
      fallo: conectado ? extension.fallo : null,
    };
  }

  /** La extension da señales de vida y se lleva lo pendiente. */
  function latido({ proyecto, rutaProyecto, version, puente, fallo } = {}) {
    caducar();
    extension = {
      ultimo: ahora(),
      proyecto: proyecto ? String(proyecto) : null,
      rutaProyecto: rutaProyecto ? String(rutaProyecto) : null,
      version: version ? String(version) : null,
      // La extension de antes (importaba el XML) no manda «puente».
      puente: Number(puente) || 1,
      // La extension contesta pero su parte de Premiere (host.jsx) no.
      fallo: fallo ? String(fallo).slice(0, 200) : null,
    };
    // De uno en uno: con la pieza invisible y el panel abiertos a la vez, dos
    // envios entregados juntos se pisarian dentro de Premiere.
    const enCurso = Array.from(envios.values()).some(e => e.estado === 'entregado');
    if (!extension.proyecto || enCurso || extension.fallo) return [];
    const e = Array.from(envios.values()).find(x => x.estado === 'pendiente');
    if (!e) return [];
    e.estado = 'entregado';
    e.entregado = ahora();
    e.proyecto = extension.proyecto;
    return [{ id: e.id, token: e.token, archivo: e.archivo }];
  }

  /** Pensadero pide importar un XML ya preparado. */
  function enviar({ token, archivo }) {
    caducar();
    const est = estado();
    if (!est.conectado) {
      const err = new Error('Premiere no está abierto (o no tiene instalada la extensión de Pensadero).');
      err.status = 409;
      throw err;
    }
    if (!est.proyecto) {
      const err = new Error('Abre un proyecto en Premiere y vuelve a enviarlo.');
      err.status = 409;
      throw err;
    }
    const id = crypto.randomBytes(6).toString('hex');
    envios.set(id, { id, token, archivo, estado: 'pendiente', creado: ahora(), proyecto: est.proyecto });
    return id;
  }

  /** La extension cuenta por donde va; tambien es señal de vida. */
  function progreso(id, texto) {
    const e = envios.get(id);
    if (!e || e.estado !== 'entregado') return false;
    e.actividad = ahora();
    e.progreso = texto || null;
    if (extension) extension.ultimo = ahora();
    return true;
  }

  /** La extension dice como ha ido (y, si puede, que entro y que no). */
  function resolver(id, { ok, error, resumen } = {}) {
    const e = envios.get(id);
    if (!e) return false;
    e.estado = ok ? 'hecho' : 'error';
    e.error = ok ? null : String(error || 'Premiere no ha podido importarlo.');
    e.resumen = resumen || null;
    e.terminado = ahora();
    return true;
  }

  function consultar(id) {
    caducar();
    const e = envios.get(id);
    if (!e) return null;
    return {
      id: e.id, token: e.token, estado: e.estado, error: e.error || null, proyecto: e.proyecto || null,
      archivo: e.archivo, progreso: e.progreso || null, resumen: e.resumen || null,
    };
  }

  return { estado, latido, enviar, progreso, resolver, consultar };
}

module.exports = { crearEnlace, VIVO_MS, SIN_RECOGER_MS, SIN_CONTESTAR_MS, PUENTE_ACTUAL };
