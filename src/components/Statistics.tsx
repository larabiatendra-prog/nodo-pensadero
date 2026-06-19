import React, { useEffect, useState, useMemo } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  FileVideo, FileAudio, FileImage, Files,
  Database, Activity, Network, BarChart3, Clock, Palette
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

interface PaletteColor { color: string; frequency: number; usage: number; }

interface StatisticsProps {
  files: MediaFile[];
  onTagClick?: (tag: string) => void;
  onTypeClick?: (type: 'image' | 'video' | 'audio') => void;
  onYearClick?: (year: string) => void;
  onPersonClick?: (personId: string) => void;
  onColorClick?: (hex: string) => void;
}

// Colores de los charts — tokens semanticos noche/lavanda (valores literales
// porque recharts pinta SVG, no acepta clases Tailwind).
const C = {
  video: '#C8B6FF',   // lavanda
  audio: '#9CB7A5',   // salvia
  image: '#F2B8A0',   // melocoton
  line: '#8EA4FF',    // bruma
  bar: '#C8B6FF',     // lavanda
  area: '#8EA4FF',    // bruma
  grid: 'rgba(184,179,201,0.12)',
  axis: '#7D8197',    // humo
};
const TOOLTIP_STYLE = {
  backgroundColor: '#1C2033',
  border: '1px solid rgba(37,42,66,0.6)',
  borderRadius: 8,
  color: '#F5F1FF',
};
const TAB_KEY = 'pensadero.stats.tab';

export default function Statistics({
  files,
  onTagClick,
  onTypeClick,
  onYearClick,
  onPersonClick,
  onColorClick,
}: StatisticsProps) {
  const [stats, setStats] = useState<FileStats | null>(null);
  const [palette, setPalette] = useState<PaletteColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'stats' | 'graph'>(() => {
    try { return localStorage.getItem(TAB_KEY) === 'graph' ? 'graph' : 'stats'; } catch { return 'stats'; }
  });

  useEffect(() => { try { localStorage.setItem(TAB_KEY, activeTab); } catch { /* SSR/quota */ } }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [statsResponse, colorsResponse] = await Promise.allSettled([
          api.getStatistics(),
          api.getColors(),
        ]);
        if (cancelled) return;
        if (statsResponse.status === 'fulfilled' && statsResponse.value.success && statsResponse.value.data) {
          setStats(statsResponse.value.data);
        }
        if (colorsResponse.status === 'fulfilled' && colorsResponse.value.success && colorsResponse.value.data?.globalPalette) {
          setPalette(colorsResponse.value.data.globalPalette);
        }
      } catch (error) {
        console.error('Error loading statistics:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Metraje (horas de video/audio) — dato identitario de un archivo
  // audiovisual, calculado del array ya en memoria (files), sin red extra.
  const footage = useMemo(() => {
    let videoSec = 0, audioSec = 0;
    for (const f of files) {
      const d = f.duration || 0;
      if (d <= 0) continue;
      if (f.type === 'video') videoSec += d;
      else if (f.type === 'audio') audioSec += d;
    }
    return { videoSec, audioSec, totalSec: videoSec + audioSec };
  }, [files]);

  const formatSize = (bytes: number): string => {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };
  const formatNumber = (num: number): string => num.toLocaleString('es-ES');
  const formatDuration = (sec: number): string => {
    if (!sec || sec <= 0) return '0 h';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
    return `${m} min`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-24">
        <div className="text-center">
          <Activity className="w-12 h-12 text-lavanda animate-pulse mx-auto mb-4" />
          <p className="text-niebla">Cargando estadísticas...</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full py-24">
        <div className="text-center">
          <Database className="w-12 h-12 text-lavanda-archivo mx-auto mb-4" />
          <p className="text-niebla">No hay estadísticas disponibles. ¿Has escaneado alguna biblioteca en <span className="text-lavanda">Rutas</span>?</p>
        </div>
      </div>
    );
  }

  const pieData = [
    { name: 'Videos', value: stats.videoCount, type: 'video' as const, color: C.video },
    { name: 'Audios', value: stats.audioCount, type: 'audio' as const, color: C.audio },
    { name: 'Imágenes', value: stats.imageCount, type: 'image' as const, color: C.image },
  ].filter(d => d.value > 0);

  const sizeData = [
    { type: 'Videos', size: stats.videoSize / (1024 ** 3), color: C.video },
    { type: 'Audios', size: stats.audioSize / (1024 ** 3), color: C.audio },
    { type: 'Imágenes', size: stats.imageSize / (1024 ** 3), color: C.image },
  ];

  const renderPieLabel = (props: any) => (
    <text x={props.x} y={props.y} fill="#F5F1FF" textAnchor={props.textAnchor} dominantBaseline="central" fontSize={12}>
      {`${props.name} ${(props.percent * 100).toFixed(0)}%`}
    </text>
  );

  const maxColorFreq = palette.length ? palette[0].frequency : 1;

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-marfil mb-2">Estadísticas del archivo</h1>
            <p className="text-niebla">Análisis y conexiones de tu archivo audiovisual</p>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('stats')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                activeTab === 'stats' ? 'bg-lavanda text-noche' : 'bg-grafito text-niebla hover:text-marfil'
              }`}
            >
              <BarChart3 className="w-4 h-4" />
              <span>Estadísticas</span>
            </button>
            <button
              onClick={() => setActiveTab('graph')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                activeTab === 'graph' ? 'bg-lavanda text-noche' : 'bg-grafito text-niebla hover:text-marfil'
              }`}
            >
              <Network className="w-4 h-4" />
              <span>Vista de grafo</span>
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'graph' && (
        <GraphView files={files} onTagClick={onTagClick} onPersonClick={onPersonClick} />
      )}

      {activeTab === 'stats' && (
        <>
          {/* Tarjetas de resumen */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6">
              <div className="flex items-center justify-between mb-4">
                <Files className="w-8 h-8 text-lavanda" />
                <span className="text-2xl font-bold text-marfil">{formatNumber(stats.totalFiles)}</span>
              </div>
              <h3 className="text-sm font-medium text-niebla mb-1">Total de archivos</h3>
              <p className="text-xs text-humo">{formatSize(stats.totalSize)} en total</p>
            </div>

            <TypeCard
              icon={<FileVideo className="w-8 h-8" style={{ color: C.video }} />}
              count={stats.videoCount} total={stats.totalFiles} label="Videos"
              size={formatSize(stats.videoSize)} barColor={C.video}
              onClick={onTypeClick ? () => onTypeClick('video') : undefined}
            />
            <TypeCard
              icon={<FileAudio className="w-8 h-8" style={{ color: C.audio }} />}
              count={stats.audioCount} total={stats.totalFiles} label="Audios"
              size={formatSize(stats.audioSize)} barColor={C.audio}
              onClick={onTypeClick ? () => onTypeClick('audio') : undefined}
            />
            <TypeCard
              icon={<FileImage className="w-8 h-8" style={{ color: C.image }} />}
              count={stats.imageCount} total={stats.totalFiles} label="Imágenes"
              size={formatSize(stats.imageSize)} barColor={C.image}
              onClick={onTypeClick ? () => onTypeClick('image') : undefined}
            />
          </div>

          {/* Metraje: horas de video/audio */}
          {footage.totalSec > 0 && (
            <div className="bg-tinta rounded-lg border border-borde-sutil p-5 mb-8 flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-3">
                <Clock className="w-7 h-7 text-lavanda" />
                <div>
                  <p className="text-xs text-humo">Metraje total</p>
                  <p className="text-xl font-bold text-marfil">{formatDuration(footage.totalSec)}</p>
                </div>
              </div>
              <div className="h-8 w-px bg-borde-sutil hidden sm:block" />
              <div>
                <p className="text-xs text-humo">Video</p>
                <p className="text-base font-semibold" style={{ color: C.video }}>{formatDuration(footage.videoSec)}</p>
              </div>
              <div>
                <p className="text-xs text-humo">Audio</p>
                <p className="text-base font-semibold" style={{ color: C.audio }}>{formatDuration(footage.audioSec)}</p>
              </div>
            </div>
          )}

          {/* Charts: distribucion + tamaño */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6">
              <h3 className="text-lg font-semibold text-marfil mb-4">Distribución por tipo</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={pieData} cx="50%" cy="50%" labelLine={false} label={renderPieLabel}
                    outerRadius={80} dataKey="value"
                    onClick={(d: any) => { const t = d?.type || d?.payload?.type; if (t) onTypeClick?.(t); }}
                    style={{ cursor: onTypeClick ? 'pointer' : 'default' }}
                  >
                    {pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#F5F1FF' }} formatter={(value) => formatNumber(value as number)} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-tinta rounded-lg border border-borde-sutil p-6">
              <h3 className="text-lg font-semibold text-marfil mb-4">Tamaño por tipo (GB)</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={sizeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="type" tick={{ fill: C.axis, fontSize: 12 }} />
                  <YAxis tick={{ fill: C.axis, fontSize: 12 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#F5F1FF' }} cursor={{ fill: 'rgba(200,182,255,0.08)' }} formatter={(value) => `${(value as number).toFixed(2)} GB`} />
                  <Bar dataKey="size">
                    {sizeData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Archivos por año (clicable → biblioteca filtrada) */}
          {stats.filesByYear && stats.filesByYear.length > 0 && (
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-marfil">Archivos por año</h3>
                {onYearClick && <span className="text-xs text-humo">Pulsa un punto para filtrar la biblioteca</span>}
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart
                  data={stats.filesByYear}
                  onClick={(e: any) => e?.activeLabel && onYearClick?.(String(e.activeLabel))}
                  style={{ cursor: onYearClick ? 'pointer' : 'default' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                  <XAxis dataKey="year" tick={{ fill: C.axis, fontSize: 12 }} />
                  <YAxis tick={{ fill: C.axis, fontSize: 12 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#F5F1FF' }} labelStyle={{ color: '#B8B3C9' }} />
                  <Line type="monotone" dataKey="count" stroke={C.line} strokeWidth={2} name="Archivos" dot={{ r: 4, fill: C.line }} activeDot={{ r: 7 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Actividad reciente de catalogo (resucita recentActivity) */}
          {stats.recentActivity && stats.recentActivity.length > 0 && (
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6 mb-8">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-semibold text-marfil">Actividad reciente</h3>
                <span className="text-xs text-humo">cambios de catálogo (mtime) · ~30 días</span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={stats.recentActivity}>
                  <defs>
                    <linearGradient id="actGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.area} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.area} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 11 }} interval="preserveStartEnd" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#F5F1FF' }} labelStyle={{ color: '#B8B3C9' }} />
                  <Area type="monotone" dataKey="uploads" stroke={C.area} strokeWidth={2} fill="url(#actGrad)" name="Archivos" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Paleta dominante (clicable → busqueda por color) */}
          {palette.length > 0 && (
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-marfil flex items-center gap-2">
                  <Palette className="w-5 h-5 text-lavanda" /> Paleta dominante
                </h3>
                {onColorClick && <span className="text-xs text-humo">Pulsa un color para buscar archivos con ese tono</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {palette.slice(0, 40).map((c, i) => {
                  const rel = Math.max(0.35, c.frequency / maxColorFreq);
                  const dim = Math.round(20 + rel * 28); // 20–48px
                  return (
                    <button
                      key={`${c.color}-${i}`}
                      onClick={() => onColorClick?.(c.color)}
                      disabled={!onColorClick}
                      title={`${c.color} · ${c.usage}% de cobertura`}
                      className="rounded-md border border-borde-sutil hover:ring-2 hover:ring-lavanda transition-shadow"
                      style={{ backgroundColor: c.color, width: dim, height: dim, cursor: onColorClick ? 'pointer' : 'default' }}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Top etiquetas (clicable → filtra biblioteca) */}
          {stats.topTags && stats.topTags.length > 0 && (
            <div className="bg-tinta rounded-lg border border-borde-sutil p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-marfil">Etiquetas más usadas</h3>
                {onTagClick && <span className="text-xs text-humo">Pulsa una etiqueta para filtrar la biblioteca</span>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {stats.topTags.slice(0, 12).map((tag, index) => (
                  <button
                    key={index}
                    onClick={() => onTagClick?.(tag.tag)}
                    disabled={!onTagClick}
                    className={`flex items-center justify-between p-3 bg-grafito rounded-lg text-left transition-colors ${
                      onTagClick ? 'hover:bg-pizarra cursor-pointer' : ''
                    }`}
                  >
                    <span className="text-sm font-medium text-marfil truncate">{tag.tag}</span>
                    <span className="text-sm text-niebla bg-tinta px-2 py-1 rounded ml-2 flex-shrink-0">{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Tarjeta de tipo con barra de proporcion; clicable si se pasa onClick.
function TypeCard({ icon, count, total, label, size, barColor, onClick }: {
  icon: React.ReactNode;
  count: number;
  total: number;
  label: string;
  size: string;
  barColor: string;
  onClick?: () => void;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`bg-tinta rounded-lg border border-borde-sutil p-6 text-left w-full transition-colors ${
        onClick ? 'hover:border-lavanda/50 cursor-pointer' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        {icon}
        <span className="text-2xl font-bold text-marfil">{count.toLocaleString('es-ES')}</span>
      </div>
      <h3 className="text-sm font-medium text-niebla mb-1">{label}</h3>
      <p className="text-xs text-humo">{size}</p>
      <div className="mt-2">
        <div className="w-full bg-grafito rounded-full h-2">
          <div className="h-2 rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
        </div>
      </div>
    </Tag>
  );
}
