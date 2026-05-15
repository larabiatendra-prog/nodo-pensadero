import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { 
  HardDrive, FileVideo, FileAudio, FileImage, Files, 
  TrendingUp, Database, Activity, FolderOpen, Calendar, Network
} from 'lucide-react';
import { api } from '../services/api';
import GraphView from './GraphView';
import { MediaFile } from '../types';

interface FileStats {
  totalFiles: number;
  totalSize: number;
  videoCount: number;
  videoSize: number;
  audioCount: number;
  audioSize: number;
  imageCount: number;
  imageSize: number;
  filesByYear: Array<{ year: string; count: number }>;
  filesByType: Array<{ type: string; count: number; size: number }>;
  topTags: Array<{ tag: string; count: number }>;
  recentActivity: Array<{ date: string; uploads: number; modifications: number }>;
}

export default function Statistics() {
  const [stats, setStats] = useState<FileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [activeTab, setActiveTab] = useState<'stats' | 'graph'>('stats');

  useEffect(() => {
    loadStatistics();
  }, []);

  const loadStatistics = async () => {
    try {
      setLoading(true);
      
      // Load statistics
      const statsResponse = await api.getStatistics();
      if (statsResponse.success && statsResponse.data) {
        setStats(statsResponse.data);
      }
      
      // Load files for graph view
      const filesResponse = await api.getFiles();
      if (filesResponse.success && filesResponse.data) {
        const processedFiles = filesResponse.data.map(file => ({
          ...file,
          createdAt: new Date(file.createdAt),
          modifiedAt: file.modifiedAt ? new Date(file.modifiedAt) : new Date(),
          extractedDate: file.extractedDate ? new Date(file.extractedDate) : undefined
        }));
        setFiles(processedFiles);
      }
    } catch (error) {
      console.error('Error loading statistics:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatNumber = (num: number): string => {
    return num.toLocaleString('es-ES');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Activity className="w-12 h-12 text-blue-600 animate-pulse mx-auto mb-4" />
          <p className="text-slate-600">Cargando estadísticas...</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Database className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <p className="text-slate-600">No hay estadísticas disponibles</p>
        </div>
      </div>
    );
  }

  // Colores para los gráficos
  const COLORS = {
    video: '#fac6a8', // lavanda-claro
    audio: '#f2efe4', // grafito
    image: '#f56845', // lavanda
    other: '#6B7280'  // gray
  };

  // Datos para el gráfico de pastel
  const pieData = [
    { name: 'Videos', value: stats.videoCount, color: COLORS.video },
    { name: 'Audios', value: stats.audioCount, color: COLORS.audio },
    { name: 'Imágenes', value: stats.imageCount, color: COLORS.image }
  ];

  // Datos para el gráfico de barras (tamaño por tipo)
  const sizeData = [
    { type: 'Videos', size: stats.videoSize / (1024 * 1024 * 1024), color: COLORS.video },
    { type: 'Audios', size: stats.audioSize / (1024 * 1024 * 1024), color: COLORS.audio },
    { type: 'Imágenes', size: stats.imageSize / (1024 * 1024 * 1024), color: COLORS.image }
  ];

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Estadísticas del Sistema</h1>
            <p className="text-slate-600">Análisis completo de archivos multimedia</p>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('stats')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                activeTab === 'stats'
                  ? 'bg-bruma text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <BarChart className="w-4 h-4" />
              <span>Estadísticas</span>
            </button>
            <button
              onClick={() => setActiveTab('graph')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                activeTab === 'graph'
                  ? 'bg-bruma text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Network className="w-4 h-4" />
              <span>Vista de Grafo</span>
            </button>
          </div>
        </div>
      </div>

      {/* Graph View Tab */}
      {activeTab === 'graph' && (
        <GraphView files={files} />
      )}

      {/* Statistics Tab */}
      {activeTab === 'stats' && (
        <>
          {/* Tarjetas de resumen */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {/* Total de archivos */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <Files className="w-8 h-8 text-bruma" />
            <span className="text-2xl font-bold text-slate-900">{formatNumber(stats.totalFiles)}</span>
          </div>
          <h3 className="text-sm font-medium text-slate-600 mb-1">Total de Archivos</h3>
          <p className="text-xs text-slate-500">{formatSize(stats.totalSize)} en total</p>
        </div>

        {/* Videos */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <FileVideo className="w-8 h-8 text-lavanda-claro" />
            <span className="text-2xl font-bold text-slate-900">{formatNumber(stats.videoCount)}</span>
          </div>
          <h3 className="text-sm font-medium text-slate-600 mb-1">Videos</h3>
          <p className="text-xs text-slate-500">{formatSize(stats.videoSize)}</p>
          <div className="mt-2">
            <div className="w-full bg-slate-200 rounded-full h-2">
              <div 
                className="bg-lavanda-claro h-2 rounded-full" 
                style={{ width: `${(stats.videoCount / stats.totalFiles) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Audios */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <FileAudio className="w-8 h-8 text-grafito" />
            <span className="text-2xl font-bold text-slate-900">{formatNumber(stats.audioCount)}</span>
          </div>
          <h3 className="text-sm font-medium text-slate-600 mb-1">Audios</h3>
          <p className="text-xs text-slate-500">{formatSize(stats.audioSize)}</p>
          <div className="mt-2">
            <div className="w-full bg-slate-200 rounded-full h-2">
              <div 
                className="bg-grafito h-2 rounded-full" 
                style={{ width: `${(stats.audioCount / stats.totalFiles) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Imágenes */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <FileImage className="w-8 h-8 text-lavanda" />
            <span className="text-2xl font-bold text-slate-900">{formatNumber(stats.imageCount)}</span>
          </div>
          <h3 className="text-sm font-medium text-slate-600 mb-1">Imágenes</h3>
          <p className="text-xs text-slate-500">{formatSize(stats.imageSize)}</p>
          <div className="mt-2">
            <div className="w-full bg-slate-200 rounded-full h-2">
              <div 
                className="bg-lavanda h-2 rounded-full" 
                style={{ width: `${(stats.imageCount / stats.totalFiles) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Gráficos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Distribución por tipo */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Distribución por Tipo</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => formatNumber(value as number)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Tamaño por tipo */}
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Tamaño por Tipo (GB)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sizeData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="type" />
              <YAxis />
              <Tooltip formatter={(value) => `${(value as number).toFixed(2)} GB`} />
              <Bar dataKey="size" fill="#3B82F6">
                {sizeData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Actividad por año */}
      {stats.filesByYear && stats.filesByYear.length > 0 && (
        <div className="bg-tinta rounded-lg border border-slate-200 p-6 mb-8">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Archivos por Año</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={stats.filesByYear}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="year" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="count" 
                stroke="#28568c" 
                strokeWidth={2}
                name="Archivos"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top etiquetas */}
      {stats.topTags && stats.topTags.length > 0 && (
        <div className="bg-tinta rounded-lg border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Etiquetas Más Usadas</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {stats.topTags.slice(0, 8).map((tag, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <span className="text-sm font-medium text-slate-700">{tag.tag}</span>
                <span className="text-sm text-slate-500 bg-tinta px-2 py-1 rounded">{tag.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

          {/* Información adicional */}
          <div className="mt-8 text-center text-sm text-slate-500">
            <p>Última actualización: {new Date().toLocaleString('es-ES')}</p>
            <button 
              onClick={loadStatistics}
              className="mt-2 text-bruma hover:text-bruma hover:opacity-80 underline"
            >
              Actualizar estadísticas
            </button>
          </div>
        </>
      )}
    </div>
  );
}