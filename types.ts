export interface Document {
  id: string;
  collection: string;
  content: Record<string, any>;
  createdAt: string;
  hash: string;
  historyVersion: number;
}

export interface StreamMessage {
  id: string;
  stream: string;
  payload: Record<string, any>;
  timestamp: string;
  offset: number;
}

export interface CacheItem {
  key: string;
  value: string;
  ttl: number; // seconds
  status: 'ACTIVE' | 'EXPIRED';
}

export interface StorageFile {
  id: string;
  name: string;
  hash: string;
  size: number;
  uploadedAt: string;
  type: string;
}

export interface AuditLog {
  id: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE' | 'PUBLISH' | 'UPLOAD' | 'AUTH';
  entity: string;
  timestamp: string;
  hash: string;
  details: string;
}

export interface AlertRule {
  id: string;
  source: string;
  conditionField: string;
  conditionValue: string;
  action: string;
  active: boolean;
}

export enum View {
  DASHBOARD = 'Dashboard',
  DOCUMENTS = 'Documents',
  STREAMS = 'Streams',
  CACHE = 'Cache',
  STORAGE = 'Storage',
  AUDIT = 'Audit & Proofs',
  ALERTS = 'Alerts',
  SDK = 'SDK & Docs',
  SETTINGS = 'Project Settings'
}