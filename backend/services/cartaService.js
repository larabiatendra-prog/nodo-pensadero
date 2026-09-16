/**
 * Carta del archivo — Pensadero NODO
 *
 * Una vez por semana el archivo escribe. No es un panel de datos ni otro eco:
 * es prosa corta sobre algo que se ha encontrado mirando su propio material.
 *
 * El reparto de trabajo es deliberado:
 *   - El HALLAZGO lo calcula `hallazgos.js`, deterministicamente, sobre fechas,
 *     carpetas, personas y embeddings. Es dato duro y de coste acotado.
 *   - El modelo local SOLO lo redacta. Se le pasa el hallazgo ya masticado y se
 *     le prohibe añadir nada: un 7B inventa fechas y nombres con una facilidad
 *     pasmosa, y una carta con datos falsos sobre tu propia vida es peor que no
 *     tener carta.
 *
 * Si Ollama no esta levantado no pasa nada: se devuelve el hallazgo con una
 * redaccion minima hecha aqui. La carta sigue existiendo, mas seca.
 *
 * Se guarda una por semana en `cartas_persistent.json` (mismo patron plano que
 * notas y descartes): la carta del lunes es la misma el jueves, y las viejas
 * se conservan porque son lo unico no regenerable de todo esto.
 */

const fs = require('fs').promises;
const path = require('path');
const { atomicWriteFile, quarantineCorrupt } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');
const hallazgos = require('./hallazgos');

const ARCHIVO = path.join(__dirname, '..', 'cartas_persistent.json');

/** Clave de la semana: "2026-W37". Estable de lunes a domingo. */
function claveSemana(hoy = new Date()) {
  const d = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicioAnio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil((((d - inicioAnio) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}

/**
 * Redaccion de emergencia, sin modelo. Seca pero cierta: si Ollama no esta
 * levantado la carta sale igual. Tambien es la red si el modelo devuelve algo
 * inservible.
 */
function redactarSinModelo(hallazgo) {
  const d = hallazgo.datos;
  switch (hallazgo.tipo) {
    case 'aniversario_semana':
      return `Esta semana, hace ${d.anios} ${d.anios === 1 ? 'año' : 'años'}, grababas ${d.evento}. Fue el ${d.fecha} y quedaron ${d.cuantos} archivos.`;
    case 'mismo_mes':
      return `Hay ${d.mes} en dos puntos distintos del archivo: ${d.anioViejo} y ${d.anioNuevo}, ${d.distancia} ${d.distancia === 1 ? 'año' : 'años'} entre uno y otro. El primero es ${d.eventoViejo}; el segundo, ${d.eventoNuevo}.`;
    case 'persona_larga':
      return `${d.nombre} lleva ${d.anios} ${d.anios === 1 ? 'año' : 'años'} apareciendo aquí, desde ${d.desde} hasta ${d.hasta}, en ${d.cuantos} archivos.`;
    case 'dia_mas_activo':
      return `El ${d.fecha} grabaste ${d.cuantos} archivos, más que ningún otro día del archivo. Era ${d.evento}.`;
    case 'anio_callado':
      return `${d.anio} está casi vacío: ${d.cuantos} archivos, entre un ${d.anioAntes} de ${d.cuantosAntes} y un ${d.anioDespues} de ${d.cuantosDespues}.`;
    case 'eco_visual':
      return `Hay un aire común entre ${d.eventoViejo} (${d.fechaViejo}) y ${d.eventoNuevo} (${d.fechaNuevo}), con ${d.distancia} años en medio.`;
    default:
      return `Lo más antiguo que guardas es ${d.evento}, del ${d.fecha}.`;
  }
}

/**
 * Prompt: datos cerrados y prohibicion explicita de inventar.
 *
 * Los ejemplos no son decoracion: un modelo local pequeño obedece mucho mejor
 * viendo notas bien hechas que leyendo cinco reglas. Sin ellos devolvia
 * "Daniel, este archivo abarca tu tiempo desde... totalizando 124 episodios
 * registrados", que es un informe, no una nota.
 */
function construirMensajes(hallazgo) {
  const sistema = [
    'Eres el archivo audiovisual personal de alguien y le dejas una nota corta sobre algo que has encontrado en tu propio material.',
    '',
    'REGLAS:',
    '- Español, segunda persona ("tú"), 2 o 3 frases. Nada mas.',
    '- Usa SOLO los datos que te doy. No inventes lugares, nombres, fechas, emociones ni detalles visuales.',
    '- No empieces con un saludo ni con un vocativo (nada de "Hola" ni de "Daniel,"). Entra por el hallazgo.',
    '- No firmes, no te despidas, no hagas preguntas.',
    '- Nada de lenguaje de informe: ni "totalizando", ni "registros", ni "episodios", ni cifras entre parentesis.',
    '- Llama "archivos" a los archivos, "carpeta" a la carpeta. Una carpeta con fecha delante es un evento: puedes nombrarlo tal cual.',
    '- Tono sobrio y calido, como una nota al margen escrita a mano.',
  ].join('\n');

  // Un ejemplo por familia: uno que compara dos momentos, uno de persona y uno
  // que habla de una ausencia. Con estos tres el modelo generaliza al resto.
  const ejemplos = [
    {
      role: 'user',
      content: 'Hallazgo del tipo "mismo_mes". Datos:\nmes: septiembre\nanioViejo: 2019\nanioNuevo: 2026\ndistancia: 7\neventoViejo: 190907_Bioritme\neventoNuevo: 260906_La Fenix\ncuantosViejo: 279\ncuantosNuevo: 151\n\nEscribe la nota.',
    },
    {
      role: 'assistant',
      content: 'Septiembre aparece dos veces aqui, con siete años de distancia: 190907_Bioritme y 260906_La Fenix. El primero dejo 279 archivos; el segundo, 151. Casi la misma semana del año, dos vidas distintas.',
    },
    {
      role: 'user',
      content: 'Hallazgo del tipo "persona_larga". Datos:\nnombre: Kike\nanios: 2\ndesde: junio de 2024\nhasta: septiembre de 2026\ncuantos: 73\n\nEscribe la nota.',
    },
    {
      role: 'assistant',
      content: 'Kike lleva dos años cruzando este archivo. Desde junio de 2024 hasta septiembre de 2026 ha aparecido en 73 archivos, sin faltar a ningun verano.',
    },
    {
      role: 'user',
      content: 'Hallazgo del tipo "anio_callado". Datos:\nanio: 2021\ncuantos: 12\nanioAntes: 2020\ncuantosAntes: 340\nanioDespues: 2022\ncuantosDespues: 512\n\nEscribe la nota.',
    },
    {
      role: 'assistant',
      content: 'De 2021 apenas guardas doce archivos, con un 2020 de 340 detras y un 2022 de 512 delante. No se si dejaste de grabar o dejaste de guardar, pero ese año esta casi en blanco.',
    },
  ];

  const datos = Object.entries(hallazgo.datos)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return [
    { role: 'system', content: sistema },
    ...ejemplos,
    { role: 'user', content: `Hallazgo del tipo "${hallazgo.tipo}". Datos:\n${datos}\n\nEscribe la nota.` },
  ];
}

// ── Persistencia ────────────────────────────────────────────────────────────

async function leerCartas() {
  try {
    const existe = await fs.access(ARCHIVO).then(() => true).catch(() => false);
    if (!existe) return {};
    const raw = await fs.readFile(ARCHIVO, 'utf-8');
    try {
      const data = JSON.parse(raw);
      return (data && data.cartas) || {};
    } catch (parseErr) {
      await quarantineCorrupt(ARCHIVO, parseErr);
      return {};
    }
  } catch (err) {
    fallos.record('leer las cartas del archivo', err, { path: ARCHIVO });
    return {};
  }
}

async function guardarCartas(cartas) {
  try {
    await atomicWriteFile(ARCHIVO, JSON.stringify({ version: 1, cartas }, null, 2));
  } catch (err) {
    fallos.record('guardar las cartas del archivo', err, { path: ARCHIVO });
  }
}

/**
 * Carta de esta semana. Si ya existe se devuelve tal cual (no se re-redacta):
 * el calculo ocurre UNA vez cada siete dias, no en cada visita a la galeria.
 *
 * @param {Array} files - los archivos servidos por /api/files
 * @param {object} deps - { chat: async (mensajes) => texto|null }
 * @param {object} opts - { forzar: boolean }
 */
async function cartaDeLaSemana(files, deps = {}, opts = {}) {
  const clave = claveSemana();
  const cartas = await leerCartas();
  if (cartas[clave] && !opts.forzar) return { ...cartas[clave], semana: clave, nueva: false };

  const hallazgo = await hallazgos.buscarHallazgo(files || [], clave);
  if (!hallazgo) return null;

  let texto = redactarSinModelo(hallazgo);
  let redactadaPor = 'archivo';
  if (typeof deps.chat === 'function') {
    try {
      const salida = await deps.chat(construirMensajes(hallazgo));
      const limpio = (salida || '').trim();
      // Un modelo pequeño a veces devuelve el prompt, comillas o un parrafo
      // kilometrico. Si no cabe en lo razonable, se queda la version seca.
      if (limpio && limpio.length > 20 && limpio.length < 900) {
        texto = limpio.replace(/^["“']|["”']$/g, '').trim();
        redactadaPor = 'modelo';
      }
    } catch (err) {
      fallos.record('redactar la carta con el modelo local', err, {});
    }
  }

  const carta = {
    texto,
    tipo: hallazgo.tipo,
    fileIds: hallazgo.fileIds,
    redactadaPor,
    generadaEl: new Date().toISOString(),
  };
  cartas[clave] = carta;
  await guardarCartas(cartas);
  return { ...carta, semana: clave, nueva: true };
}

async function listarCartas() {
  const cartas = await leerCartas();
  return Object.entries(cartas)
    .map(([semana, c]) => ({ semana, ...c }))
    .sort((a, b) => b.semana.localeCompare(a.semana));
}

module.exports = {
  cartaDeLaSemana,
  listarCartas,
  claveSemana,
  redactarSinModelo,
  // Re-exportados: los usan las pruebas y el diagnostico de la vista.
  buscarHallazgo: hallazgos.buscarHallazgo,
  buscarCandidatos: hallazgos.buscarCandidatos,
};
