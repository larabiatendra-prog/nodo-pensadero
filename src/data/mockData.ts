import { MediaFile, Collection, User } from '../types';

export const mockUser: User = {
  id: '1',
  username: 'marina_user',
  email: 'usuario@marinadeem.com',
  role: 'admin', // Changed to admin for testing path management
  avatar: 'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=150&h=150&dpr=2'
};

export const mockMediaFiles: MediaFile[] = [
  {
    id: '1',
    name: 'Presentación Corporativa 2024',
    type: 'video',
    url: 'https://example.com/video1.mp4',
    thumbnail: 'https://images.pexels.com/photos/3761020/pexels-photo-3761020.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 25600000,
    createdAt: new Date('2024-01-15'),
    tags: ['corporativo', 'presentación', '2024', 'empresas'],
    description: 'Video institucional para la presentación de servicios 2024',
    duration: 180,
    dimensions: { width: 1920, height: 1080 },
    isFavorite: true
  },
  {
    id: '2',
    name: 'Evento Networking Marina',
    type: 'image',
    url: 'https://images.pexels.com/photos/1181406/pexels-photo-1181406.jpeg',
    thumbnail: 'https://images.pexels.com/photos/1181406/pexels-photo-1181406.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 2048000,
    createdAt: new Date('2024-01-10'),
    tags: ['networking', 'evento', 'empresarios', 'marina'],
    description: 'Fotografías del evento de networking empresarial',
    dimensions: { width: 1920, height: 1280 },
    isFavorite: false
  },
  {
    id: '3',
    name: 'Podcast Emprendimiento',
    type: 'audio',
    url: 'https://example.com/audio1.mp3',
    thumbnail: 'https://images.pexels.com/photos/7088526/pexels-photo-7088526.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 15360000,
    createdAt: new Date('2024-01-05'),
    tags: ['podcast', 'emprendimiento', 'entrevista', 'negocios'],
    description: 'Episodio sobre estrategias de emprendimiento',
    duration: 2340,
    isFavorite: true
  },
  {
    id: '4',
    name: 'Workshop Innovación',
    type: 'video',
    url: 'https://example.com/video2.mp4',
    thumbnail: 'https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 45600000,
    createdAt: new Date('2023-12-20'),
    tags: ['workshop', 'innovación', 'formación', 'digital'],
    description: 'Grabación completa del workshop sobre innovación digital',
    duration: 3600,
    dimensions: { width: 1920, height: 1080 },
    isFavorite: false
  },
  {
    id: '5',
    name: 'Instalaciones Marina',
    type: 'image',
    url: 'https://images.pexels.com/photos/1170412/pexels-photo-1170412.jpeg',
    thumbnail: 'https://images.pexels.com/photos/1170412/pexels-photo-1170412.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 1536000,
    createdAt: new Date('2023-12-15'),
    tags: ['instalaciones', 'oficinas', 'espacios', 'corporativo'],
    description: 'Fotografías profesionales de las instalaciones',
    dimensions: { width: 1600, height: 1067 },
    isFavorite: false
  },
  {
    id: '6',
    name: 'Conferencia Startups',
    type: 'video',
    url: 'https://example.com/video3.mp4',
    thumbnail: 'https://images.pexels.com/photos/2608517/pexels-photo-2608517.jpeg?auto=compress&cs=tinysrgb&w=400&h=225',
    size: 38400000,
    createdAt: new Date('2023-12-10'),
    tags: ['conferencia', 'startups', 'inversión', 'tecnología'],
    description: 'Ponencias sobre el ecosistema startup español',
    duration: 2700,
    dimensions: { width: 1920, height: 1080 },
    isFavorite: true
  }
];

export const mockCollections: Collection[] = [
  {
    id: '1',
    name: 'Eventos 2024',
    description: 'Colección de contenido audiovisual de eventos del año 2024',
    isPublic: true,
    createdBy: '1',
    mediaFiles: ['1', '2'],
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-15')
  },
  {
    id: '2',
    name: 'Material Formativo',
    description: 'Videos y audios para formación y capacitación',
    isPublic: false,
    createdBy: '1',
    mediaFiles: ['3', '4'],
    createdAt: new Date('2023-12-01'),
    updatedAt: new Date('2024-01-10')
  }
];

export const mockTags = [
  'corporativo', 'presentación', '2024', 'empresas', 'networking', 'evento',
  'empresarios', 'marina', 'podcast', 'emprendimiento', 'entrevista', 'negocios',
  'workshop', 'innovación', 'formación', 'digital', 'instalaciones', 'oficinas',
  'espacios', 'conferencia', 'startups', 'inversión', 'tecnología'
];