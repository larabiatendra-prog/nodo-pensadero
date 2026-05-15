import React, { useState } from 'react';
import { Folder, FolderOpen, File, CheckSquare, Square, Upload, X, Search } from 'lucide-react';

interface FileItem {
  path: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  selected: boolean;
  children?: FileItem[];
}

interface FolderScannerProps {
  onClose: () => void;
  onUpload: (files: FileItem[]) => void;
}

export function FolderScanner({ onClose, onUpload }: FolderScannerProps) {
  const [scanPath, setScanPath] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Simular escaneo de carpetas
  const handleScan = () => {
    if (!scanPath) return;
    
    setIsScanning(true);
    
    // Simulación de estructura de archivos
    setTimeout(() => {
      const mockFiles: FileItem[] = [
        {
          path: `${scanPath}/Documents`,
          name: 'Documents',
          type: 'folder',
          selected: false,
          children: [
            { path: `${scanPath}/Documents/video1.mp4`, name: 'video1.mp4', type: 'file', size: 1024000, selected: false },
            { path: `${scanPath}/Documents/image1.jpg`, name: 'image1.jpg', type: 'file', size: 512000, selected: false },
            { path: `${scanPath}/Documents/document.pdf`, name: 'document.pdf', type: 'file', size: 204800, selected: false },
          ]
        },
        {
          path: `${scanPath}/Media`,
          name: 'Media',
          type: 'folder',
          selected: false,
          children: [
            { path: `${scanPath}/Media/photo1.png`, name: 'photo1.png', type: 'file', size: 819200, selected: false },
            { path: `${scanPath}/Media/video2.mov`, name: 'video2.mov', type: 'file', size: 2048000, selected: false },
            {
              path: `${scanPath}/Media/Subfolder`,
              name: 'Subfolder',
              type: 'folder',
              selected: false,
              children: [
                { path: `${scanPath}/Media/Subfolder/nested.jpg`, name: 'nested.jpg', type: 'file', size: 409600, selected: false },
              ]
            }
          ]
        },
        { path: `${scanPath}/standalone.txt`, name: 'standalone.txt', type: 'file', size: 1024, selected: false },
      ];
      
      setFiles(mockFiles);
      setIsScanning(false);
    }, 1500);
  };

  const toggleFolder = (path: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedFolders(newExpanded);
  };

  const toggleSelection = (path: string, isFolder: boolean) => {
    const updateSelection = (items: FileItem[]): FileItem[] => {
      return items.map(item => {
        if (item.path === path) {
          const newSelected = !item.selected;
          if (isFolder && item.children) {
            // Si es carpeta, seleccionar/deseleccionar todos los hijos
            const updateChildren = (children: FileItem[]): FileItem[] => {
              return children.map(child => ({
                ...child,
                selected: newSelected,
                children: child.children ? updateChildren(child.children) : undefined
              }));
            };
            return { ...item, selected: newSelected, children: updateChildren(item.children) };
          }
          return { ...item, selected: newSelected };
        }
        if (item.children) {
          return { ...item, children: updateSelection(item.children) };
        }
        return item;
      });
    };
    
    setFiles(updateSelection(files));
  };

  const getSelectedFiles = (): FileItem[] => {
    const selected: FileItem[] = [];
    const traverse = (items: FileItem[]) => {
      items.forEach(item => {
        if (item.selected && item.type === 'file') {
          selected.push(item);
        }
        if (item.children) {
          traverse(item.children);
        }
      });
    };
    traverse(files);
    return selected;
  };

  const handleUpload = () => {
    const selectedFiles = getSelectedFiles();
    if (selectedFiles.length > 0) {
      onUpload(selectedFiles);
    }
  };

  const renderFileTree = (items: FileItem[], level = 0) => {
    return items.map(item => {
      const isExpanded = expandedFolders.has(item.path);
      const hasSelectedChildren = item.children?.some(child => child.selected) || false;
      
      return (
        <div key={item.path}>
          <div
            className="flex items-center py-1 px-2 hover:bg-grafito cursor-pointer rounded-xl"
            style={{ paddingLeft: `${level * 20 + 8}px` }}
          >
            <button
              onClick={() => toggleSelection(item.path, item.type === 'folder')}
              className="mr-2"
            >
              {item.selected || hasSelectedChildren ? (
                <CheckSquare className="w-4 h-4 text-bruma" />
              ) : (
                <Square className="w-4 h-4 text-lavanda-archivo" />
              )}
            </button>
            
            {item.type === 'folder' ? (
              <button
                onClick={() => toggleFolder(item.path)}
                className="mr-2"
              >
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4 text-lavanda" />
                ) : (
                  <Folder className="w-4 h-4 text-lavanda" />
                )}
              </button>
            ) : (
              <File className="w-4 h-4 text-lavanda-archivo mr-2" />
            )}
            
            <span className="text-sm text-marfil flex-1">{item.name}</span>
            {item.size && (
              <span className="text-xs text-lavanda-archivo">
                {(item.size / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
          
          {item.children && isExpanded && (
            <div>{renderFileTree(item.children, level + 1)}</div>
          )}
        </div>
      );
    });
  };

  const selectedCount = getSelectedFiles().length;

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-4xl w-full max-h-[80vh] flex flex-col border border-borde-sutil">
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <h2 className="text-xl font-semibold">Escanear Carpetas</h2>
          <button
            onClick={onClose}
            className="text-lavanda-archivo hover:text-marfil"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6">
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              placeholder="Ingrese la ruta de la carpeta (ej: C:/Users/Documents)"
              className="flex-1 px-3 py-2 border border-pizarra rounded-full focus:outline-none focus:ring-2 focus:ring-lavanda"
            />
            <button
              onClick={handleScan}
              disabled={isScanning || !scanPath}
              className="btn-primary flex items-center gap-2"
            >
              <Search className="w-4 h-4" />
              {isScanning ? 'Escaneando...' : 'Escanear'}
            </button>
          </div>
          
          {files.length > 0 && (
            <>
              <div className="border border-pizarra rounded-2xl overflow-auto max-h-96 mb-4">
                <div className="p-2">
                  {renderFileTree(files)}
                </div>
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-sm text-lavanda-archivo">
                  {selectedCount} archivo{selectedCount !== 1 ? 's' : ''} seleccionado{selectedCount !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={handleUpload}
                  disabled={selectedCount === 0}
                  className="btn-primary flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  Subir Archivos Seleccionados
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}