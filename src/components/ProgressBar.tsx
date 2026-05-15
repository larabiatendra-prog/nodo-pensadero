import React from 'react';

interface ProgressBarProps {
  isVisible: boolean;
  percentage: number;
  status: string;
  stats?: {
    nuevos?: number;
    cache?: number;
    modificados?: number;
    total?: number;
  };
  onClose?: () => void;
}

export default function ProgressBar({ 
  isVisible, 
  percentage, 
  status, 
  stats,
  onClose 
}: ProgressBarProps) {
  if (!isVisible) return null;

  const isComplete = percentage === 100;

  return (
    <div className="fixed top-4 left-4 right-4 sm:left-auto sm:right-4 z-50 bg-tinta rounded-lg shadow-lg border p-3 md:p-4 sm:min-w-96 max-w-md">
      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center">
          {isComplete ? (
            <span className="text-green-500 mr-2">✅</span>
          ) : (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent mr-2"></div>
          )}
          Sincronizando archivos
        </h3>
        {isComplete && onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
            title="Cerrar"
          >
            ×
          </button>
        )}
      </div>

      {/* Progress Bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-600 mb-1">
          <span>{status}</span>
          <span>{percentage}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className={`h-2 rounded-full transition-all duration-300 ${
              isComplete 
                ? 'bg-green-500' 
                : 'bg-blue-500'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="text-xs text-gray-600 space-y-1">
          <div className="flex justify-between">
            <span>✨ Nuevos:</span>
            <span className="font-medium">{stats.nuevos || 0}</span>
          </div>
          <div className="flex justify-between">
            <span>📦 Desde cache:</span>
            <span className="font-medium">{stats.cache || 0}</span>
          </div>
          <div className="flex justify-between">
            <span>📝 Modificados:</span>
            <span className="font-medium">{stats.modificados || 0}</span>
          </div>
          <div className="flex justify-between font-semibold border-t pt-1 mt-2">
            <span>📁 Total:</span>
            <span>{stats.total || 0}</span>
          </div>
        </div>
      )}

      {/* Auto close timer for completed sync */}
      {isComplete && (
        <div className="mt-2 text-xs text-gray-500 text-center">
          Se cerrará automáticamente en unos segundos
        </div>
      )}
    </div>
  );
}