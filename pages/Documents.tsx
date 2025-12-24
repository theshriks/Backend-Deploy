import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Input, Modal, TextArea, Badge } from '../components/ui';
import { Search, Plus, Trash2, Clock, Hash } from 'lucide-react';
import { Document } from '../types';

export const Documents: React.FC = () => {
  const { documents, addDocument, deleteDocument } = useStore();
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [isInsertModalOpen, setInsertModalOpen] = useState(false);
  const [newDocContent, setNewDocContent] = useState('{\n  "key": "value"\n}');
  const [newDocCollection, setNewDocCollection] = useState('users');

  const collections = Array.from(new Set(documents.map(d => d.collection)));
  const [activeCollection, setActiveCollection] = useState<string>(collections[0] || 'users');

  const filteredDocs = documents.filter(d => d.collection === activeCollection);

  const handleInsert = () => {
    try {
      const content = JSON.parse(newDocContent);
      addDocument(newDocCollection, content);
      setInsertModalOpen(false);
      setNewDocContent('{\n  "key": "value"\n}');
    } catch (e) {
      alert("Invalid JSON");
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-6">
      {/* Left Panel: Collections */}
      <div className="w-48 flex-shrink-0 border-r border-neutral-800 pr-4">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">Collections</h3>
        <ul className="space-y-1">
          {collections.map(c => (
            <li key={c}>
              <button
                onClick={() => setActiveCollection(c)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  activeCollection === c 
                  ? 'bg-neutral-800 text-white' 
                  : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {c}
                <span className="ml-2 text-xs text-neutral-600">
                  {documents.filter(d => d.collection === c).length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Center Panel: Document List */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="mb-4 flex items-center justify-between">
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-neutral-500" />
            <Input placeholder="Search documents..." className="pl-8" />
          </div>
          <Button size="sm" onClick={() => setInsertModalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Insert
          </Button>
        </div>

        <div className="flex-1 overflow-auto rounded-md border border-neutral-800 bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Ver</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {filteredDocs.map(doc => (
                <tr 
                  key={doc.id} 
                  onClick={() => setSelectedDoc(doc)}
                  className={`cursor-pointer transition-colors hover:bg-neutral-800/50 ${selectedDoc?.id === doc.id ? 'bg-neutral-800' : ''}`}
                >
                  <td className="px-4 py-3 font-mono text-neutral-300">{doc.id}</td>
                  <td className="px-4 py-3 text-neutral-400">{new Date(doc.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-neutral-400">{doc.historyVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Panel: Details */}
      <div className="w-80 flex-shrink-0 border-l border-neutral-800 pl-4 flex flex-col">
        {selectedDoc ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-mono text-sm text-white">{selectedDoc.id}</h3>
              <button 
                onClick={() => { deleteDocument(selectedDoc.id); setSelectedDoc(null); }}
                className="text-neutral-500 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 flex-1 overflow-auto">
              <div className="rounded bg-neutral-900 p-3 font-mono text-xs text-neutral-300 whitespace-pre-wrap overflow-x-auto border border-neutral-800">
                {JSON.stringify(selectedDoc.content, null, 2)}
              </div>

              <div className="space-y-3 border-t border-neutral-800 pt-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-500 flex items-center gap-2"><Clock className="h-3 w-3"/> Created</span>
                  <span className="text-neutral-300">{new Date(selectedDoc.createdAt).toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-500 flex items-center gap-2"><Hash className="h-3 w-3"/> Hash</span>
                  <span className="font-mono text-neutral-300 truncate w-32 text-right" title={selectedDoc.hash}>{selectedDoc.hash}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-500">Collection</span>
                  <Badge variant="outline">{selectedDoc.collection}</Badge>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Select a document
          </div>
        )}
      </div>

      <Modal isOpen={isInsertModalOpen} onClose={() => setInsertModalOpen(false)} title="Insert Document">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-neutral-400">Collection</label>
            <Input value={newDocCollection} onChange={e => setNewDocCollection(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-400">JSON Content</label>
            <TextArea 
              rows={10} 
              value={newDocContent} 
              onChange={e => setNewDocContent(e.target.value)} 
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setInsertModalOpen(false)}>Cancel</Button>
            <Button onClick={handleInsert}>Insert</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};