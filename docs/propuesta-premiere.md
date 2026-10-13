# Llevar material a Premiere

> **Actualizado el 12/10/2026 (madrugada): cesta + puente v2.** «Añadir a Premiere»
> (selección, `P`, cabecera, colección, ficha) y **Enviar** en la propia burbuja de
> abajo a la izquierda: dos clics. La extensión de Pensadero ya no le pasa a Premiere
> un XML (26.2 lo rechazó como «proyecto dañado»): crea las bandejas e importa los
> originales con la API de Premiere, paso a paso, y lo que no entra o no encaja se
> dice al terminar. El XML de abajo queda para DaVinci o para importar a mano. Cómo
> está hecho: el CLAUDE.md del repo.

Propuesta del 10/10/2026. **Construido el mismo dia** (pasos 2 a 4 del orden de
trabajo, salvo el boton en la sesion y en la ficha de un archivo):

- Boton en la barra de seleccion (y tecla `P`), en la cabecera cuando hay
  busqueda, filtros o una coleccion abierta («A Premiere», lo que se ve) y en
  cada tarjeta de Colecciones (la coleccion entera, en su orden).
- XML, rutas y tarjeta como se describen abajo. Probado con material real
  (190 archivos en ~4 s la primera vez; las medidas se recuerdan).
- **Falta lo mas importante: soltar la ficha en Premiere de verdad** (paso 1).
  Si Premiere no la acepta, la ficha sigue sirviendo para el escritorio y
  quedan los dos botones.

## Para que

Cerrar el circuito buscar -> elegir -> montar. Hoy Pensadero encuentra el
material, pero para llevarlo a Premiere hay que ir al explorador e importar
archivo a archivo. Tiene que costar un gesto y llegar a Premiere ya ordenado,
con lo que Pensadero sabe de cada clip (quien sale, que pasa, tus notas).

## La idea en una frase

Un boton **«A Premiere»** en todo sitio donde haya un grupo de archivos, que
abre una tarjeta pequeña con **una ficha arrastrable**: la coges, la sueltas en
el panel Proyecto de Premiere y aparece una bandeja con los clips. Si arrastrar
no va (otro navegador, otra version de Premiere), la misma tarjeta da las dos
salidas de siempre: guardar el `.xml` o enseñarlo en su carpeta.

## Donde esta el boton

Nada de menus nuevos: aparece donde ya hay un grupo de archivos.

1. **Barra de seleccion** (la flotante de abajo): un boton mas junto a
   «Añadir a colección» y «Descargar».
2. **Colecciones**: «A Premiere» en la cabecera de cada coleccion. Es el caso
   de los «selects»: vas metiendo lo bueno en una coleccion y al final la llevas
   entera.
3. **Sesion / dia** (la tarjeta de sesion): el dia entero de un rodaje.
4. **Resultados de una busqueda**: «Llevar estos 48 a Premiere» junto al
   recuento, sin tener que seleccionar todo antes.
5. **Ficha de un archivo**: para uno suelto.

Atajo: `P` con algo seleccionado abre la tarjeta.

## La tarjeta

Sale junto al boton (no es una ventana encima de todo) y se cierra con Esc o
con un clic fuera, como la tarjeta de un archivo.

```
Llevar 23 archivos a Premiere
-----------------------------------------------------------
Nombre    [ Boda Ana y Pablo · selección              ]
Ordenar   ( Por día )( Por persona )( Por carpeta )( Todo junto )
[x] Notas y descripciones como marcadores
[ ] Crear también una secuencia con los clips en orden

  +-----------------------------------------------+
  | [icono XML]  Boda Ana y Pablo.xml             |
  |              23 clips · 2 bandejas            |
  |   Arrástrala al panel Proyecto de Premiere   |
  +-----------------------------------------------+
     Guardar el archivo     Mostrar en la carpeta

  ! 3 están en el LaCie 10TB, que no está conectado: entran igual,
    Premiere los verá sin conexión hasta que lo enchufes.
```

- **El nombre viene puesto**: el de la coleccion, la busqueda, la sesion o la
  persona. Se cambia si quieres.
- **Ordenar** es una sola eleccion y se recuerda la ultima. Decide las
  sub-bandejas dentro de la bandeja principal.
- **La ficha es lo protagonista**: se ve que se puede coger (asa, cursor de
  mano, se levanta al pasar el raton). Mientras se arrastra, la tarjeta dice
  «Suéltala en el panel Proyecto».
- Los avisos solo si hay algo que avisar, en una linea cada uno: discos
  desconectados, cosas que Premiere no abre (lo que Pensadero no sabe leer
  tampoco entra), fotogramas por segundo mezclados en la secuencia.
- Lo que esta bajo candado nunca sale, aunque este seleccionado.

## Que llega a Premiere

Un XML de Final Cut 7 (`xmeml`), el que Premiere importa de siempre. **El mismo
archivo sirve para DaVinci Resolve**, sin hacer nada aparte.

```
Bandeja  «Boda Ana y Pablo · selección»
  Bandeja «14 jun 2026»
    P1248495.MP4
    ...
  Bandeja «15 jun 2026»
  Secuencia «Boda Ana y Pablo · selección»   (si se pidio)
```

- **Siempre los originales**, nunca los proxies de Pensadero.
- **Lo que Pensadero sabe, a la vista en Premiere**: la descripcion de la IA y
  tu nota en la columna «Descripción» / «Comentario» de cada clip; las personas
  en «Registro»; favoritos con una etiqueta de color (para filtrarlos o verlos
  de un vistazo en la linea de tiempo).
- **Marcadores** (si la casilla esta): la nota y la descripcion como marcador al
  principio del clip.
- **Secuencia** (si se pide): los clips seguidos, en el orden en que se ven en
  Pensadero (o en el orden manual de la coleccion). Ajustes de la secuencia: los
  del clip mas comun (tamaño y fps).
- Fotos como fotos fijas y audio en su pista.

## Arrastrar: lo que se puede y lo que no

Un navegador no puede arrastrar archivos del disco a otro programa, por
seguridad. Lo que **si** puede Chrome y Edge es arrastrar un archivo que esta
en una direccion web: al soltarlo, el navegador lo descarga en ese momento y
se lo entrega al programa de destino. El XML lo sirve el propio Pensadero
(`localhost:5000`), asi que la ficha lleva ese archivo. Por eso se arrastra el
**XML** y no los clips: los clips los trae Premiere al leerlo.

**Sin comprobar todavia**: que Premiere acepte un archivo soltado desde el
navegador (el explorador si lo acepta). Es lo primero que hay que probar, y son
cinco minutos: una pagina de prueba con una ficha y un XML de tres clips. Si no
lo acepta:

- La ficha se arrastra igual al **escritorio o a una carpeta**, y de ahi a
  Premiere.
- **«Mostrar en la carpeta»** guarda el XML y abre el explorador con el archivo
  ya marcado (lo mismo que «Abrir en el explorador»), listo para arrastrarlo.
- En Firefox no hay arrastre: quedan los dos botones.

## Mas adelante: Premiere conectado

Un panel pequeño de Pensadero dentro de Premiere (como el de la acampada): con
el panel abierto, la tarjeta cambia la ficha por un boton **«Enviar a
Premiere»** con un punto verde, y el material entra solo en el proyecto abierto
(`importFiles` con el XML), sin arrastrar nada. Es lo mas comodo, pero instalar
un panel sin firmar pide tocar un ajuste de Adobe (PlayerDebugMode); para el
producto, una herramienta en `Herramientas\` que lo instale, con su explicacion.

Otras dos ideas que encajan aqui, para despues:

- **Solo el trozo bueno**: marcar entrada y salida en el reproductor (`I` /
  `O`) y que el XML lleve ese trozo en vez del clip entero.
- **Volver a mandar**: si una coleccion ya se llevo, «Actualizar en Premiere»
  manda solo lo nuevo.

## Como se construye

- `backend/services/premiereXml.js`: recibe archivos (ya filtrados por candado)
  y opciones, devuelve el XML. Puro, con pruebas en `backend/tests/`.
  Rutas `file://localhost/C%3a/...` con todo escapado (tildes, `&`, `#`).
- `POST /api/premiere/xml { ids, nombre, ordenar, marcadores, secuencia }`:
  guarda el XML en un temporal y devuelve `{ url, nombre, avisos }`.
  `GET /api/premiere/xml/:token` lo sirve con `Content-Disposition`.
- `POST /api/premiere/xml/:token/mostrar`: lo copia a Descargas y abre el
  explorador con el marcado. No se escribe en ningun disco que no hayas elegido.
- `src/components/LlevarAPremiere.tsx`: la tarjeta. La ficha usa `draggable` y
  `dataTransfer.setData('DownloadURL', 'application/xml:<nombre>.xml:<url>')`;
  el XML se pide al abrir la tarjeta (y se rehace al cambiar una opcion), para
  que al arrastrar ya este listo.

## Orden de trabajo

1. Pagina de prueba: ¿Premiere acepta la ficha soltada desde el navegador? Con
   la respuesta se cierra el diseño de la ficha.
2. El XML: bandejas, metadatos, fotos y audio; probarlo en Premiere y DaVinci
   con material real (4K de camara, movil vertical, fotos, un disco desconectado).
3. La tarjeta y el boton en la barra de seleccion.
4. Los demas sitios del boton (coleccion, sesion, busqueda, ficha).
5. Despues, si compensa: el panel «Premiere conectado».
