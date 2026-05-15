import React from 'react';
import VideoThumbnail from './VideoThumbnail';
import { VideoItem } from '../types';

const mockVideoData: VideoItem[] = [
  {
    id: '1',
    name: 'Video de prueba 1',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    thumbnail: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg',
    duration: 596,
    width: 1920,
    height: 1080
  },
  {
    id: '2',
    name: 'Video de prueba 2',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    thumbnail: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ElephantsDream.jpg',
    duration: 653,
    width: 1920,
    height: 1080
  },
  {
    id: '3',
    name: 'Video de prueba 3',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    thumbnail: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerBlazes.jpg',
    duration: 15,
    width: 1920,
    height: 1080
  },
  {
    id: '4',
    name: 'Video formato vertical',
    url: 'https://sample-videos.com/zip/10/mp4/SampleVideo_720x1280_1mb.mp4',
    thumbnail: 'https://sample-videos.com/zip/10/jpg/SampleJPGImage_350kbv.jpg',
    duration: 30,
    width: 720,
    height: 1280
  },
  {
    id: '5',
    name: 'Video corto de prueba',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    thumbnail: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerEscapes.jpg',
    duration: 15,
    width: 1920,
    height: 1080
  },
  {
    id: '6',
    name: 'Video con error simulado',
    url: 'https://invalid-url-for-testing-error-handling.mp4',
    thumbnail: 'https://via.placeholder.com/300x200/666/fff?text=Error+Test',
    duration: 60,
    width: 1920,
    height: 1080
  }
];

export default function VideoTestPage() {
  return (
    <div className="min-h-screen bg-noche p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-marfil mb-8">
          Prueba de Hover Preview de Videos
        </h1>
        
        <div className="mb-8 p-4 bg-grafito rounded-lg">
          <h2 className="text-lg font-semibold mb-2">Instrucciones:</h2>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Pasa el ratón sobre una miniatura y espera ~450ms para ver el preview</li>
            <li>El video se reproducirá automáticamente (muted y loop)</li>
            <li>En dispositivos táctiles no habrá autoplay</li>
            <li>Si hay error de carga, vuelve a mostrar la imagen</li>
            <li>Al salir del hover, el video se pausa</li>
          </ul>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {mockVideoData.map((video) => (
            <div
              key={video.id}
              className="bg-tinta rounded-xl shadow-sm hover:shadow-lg transition-shadow p-4"
            >
              <div className="aspect-video mb-4 rounded-lg overflow-hidden">
                <VideoThumbnail
                  video={video}
                  hoverDelayMs={450}
                  className="rounded-lg"
                />
              </div>
              
              <div className="space-y-2">
                <h3 className="font-semibold text-marfil">{video.name}</h3>
                <div className="text-sm text-lavanda-archivo space-y-1">
                  <p>Duración: {Math.floor(video.duration! / 60)}:{(video.duration! % 60).toString().padStart(2, '0')}</p>
                  <p>Resolución: {video.width}x{video.height}</p>
                  <p>ID: {video.id}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 p-6 bg-tinta rounded-lg shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Casos de prueba implementados:</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <h3 className="font-medium mb-2">✅ Funcionalidades:</h3>
              <ul className="space-y-1 text-lavanda-archivo">
                <li>• Retardo configurable de hover (450ms)</li>
                <li>• Preload de metadata</li>
                <li>• Reproducción automática muted + loop</li>
                <li>• Transiciones suaves de opacidad</li>
                <li>• Detección de pointer fino vs táctil</li>
                <li>• Fallback robusto a thumbnail</li>
                <li>• Limpieza al salir del hover</li>
                <li>• IntersectionObserver para pausa</li>
              </ul>
            </div>
            <div>
              <h3 className="font-medium mb-2">🧪 Pruebas incluidas:</h3>
              <ul className="space-y-1 text-lavanda-archivo">
                <li>• Videos HD normales (16:9)</li>
                <li>• Video formato vertical (9:16)</li>
                <li>• Videos de diferentes duraciones</li>
                <li>• URL inválida para probar error handling</li>
                <li>• Diferentes tamaños y resoluciones</li>
                <li>• Múltiples instancias simultáneas</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}