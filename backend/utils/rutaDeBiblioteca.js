// ¿Una carpeta o un nombre que llegan del navegador son de tus bibliotecas?
// Sin esto, las acciones que reciben "carpeta + nombre" (las de una cara)
// leian o escribian donde se les dijera, dentro o fuera de tus discos.
const path = require('path');

/** La carpeta es una raiz o esta dentro de una, ya resuelta: un `..` no la saca. */
function dentroDeBiblioteca(carpeta, raices) {
  if (typeof carpeta !== 'string' || !carpeta || !path.isAbsolute(carpeta)) return false;
  const c = path.resolve(carpeta);
  return (raices || []).some(r => {
    if (typeof r !== 'string' || !r) return false;
    const rel = path.relative(path.resolve(r), c);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  });
}

/** Un nombre de archivo suelto, sin carpetas por medio. */
function nombreSuelto(nombre) {
  return typeof nombre === 'string' && nombre !== '' && nombre !== '.' && nombre !== '..'
    && !/[\\/]/.test(nombre) && path.basename(nombre) === nombre;
}

module.exports = { dentroDeBiblioteca, nombreSuelto };
