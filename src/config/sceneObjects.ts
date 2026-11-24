import type { SceneObjectItem } from '../types/robot';

export const createInitialSceneObjects = (): SceneObjectItem[] => [
  {
    id: 'red_cube',
    label: '红色工件 (Red Cube)',
    kind: 'graspable',
    geometry: 'box',
    color: '#ef4444',
    defaultPosition: [-0.36, 0.04, 0.34],
    position: [-0.36, 0.04, 0.34],
    graspOffset: [0, 0.08, 0],
  },
  {
    id: 'blue_cylinder',
    label: '蓝色料筒 (Blue Cylinder)',
    kind: 'graspable',
    geometry: 'cylinder',
    color: '#3b82f6',
    defaultPosition: [0.38, 0.045, 0.32],
    position: [0.38, 0.045, 0.32],
    graspOffset: [0, 0.085, 0],
  },
  {
    id: 'tray_a',
    label: 'A 号料盘 (Tray A)',
    kind: 'receptacle',
    geometry: 'tray',
    color: '#10b981',
    defaultPosition: [0.0, 0.015, 0.50],
    position: [0.0, 0.015, 0.50],
    graspOffset: [0, 0.095, 0],
  },
];
