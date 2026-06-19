/// <reference lib="webworker" />
/**
 * Worker del Atlas: ejecuta el calculo pesado (buildAtlas + metricas) fuera del
 * hilo principal para que la UI no se congele. Recibe una proyeccion ligera de
 * los archivos y devuelve el grafo serializable + las metricas emergentes.
 */
import {
  buildAtlas, connectedComponents, centersOfGravity, bridgePeople, anchorPlaces, islands,
} from '../utils/atlasGraph';
import type { MediaFile } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent) => {
  const files = e.data?.files as MediaFile[] | undefined;
  if (!Array.isArray(files)) return;

  const graph = buildAtlas(files);
  const components = connectedComponents(graph);

  ctx.postMessage({
    recuerdos: graph.recuerdos,
    edges: graph.edges,
    looseCount: graph.looseCount,
    fileCount: graph.fileCount,
    metrics: {
      componentCount: components.length,
      compById: components.flatMap((c, i) => c.keys.map(k => [k, i] as [string, number])),
      centers: centersOfGravity(graph, 12),
      bridges: bridgePeople(graph, 10),
      anchors: anchorPlaces(graph, 10),
      islandList: islands(graph, 2),
    },
  });
};

export {};
