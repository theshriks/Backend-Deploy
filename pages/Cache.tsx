import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Input, Modal, Badge } from '../components/ui';
import { Trash2, Search, RefreshCw, Plus } from 'lucide-react';

export const Cache: React.FC = () => {
  const { cacheItems, setCacheKey, deleteCacheKey } = useStore();
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newTTL, setNewTTL] = useState('3600');

  const filteredItems = cacheItems.filter(item => item.key.toLowerCase().includes(search.toLowerCase()));

  const handleSet = () => {
    setCacheKey(newKey, newValue, parseInt(newTTL));
    setIsModalOpen(false);
    setNewKey('');
    setNewValue('');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-neutral-500" />
            <Input 
              placeholder="Search keys..." 
              className="pl-8" 
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button variant="ghost" size="sm">
            <RefreshCw className="h-4 w-4 text-neutral-500" />
          </Button>
        </div>
        <Button onClick={() => setIsModalOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Set Key
        </Button>
      </div>

      <div className="rounded-md border border-neutral-800 bg-surface overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase text-neutral-500 border-b border-neutral-800">
            <tr>
              <th className="px-4 py-3 font-medium">Key</th>
              <th className="px-4 py-3 font-medium">Value</th>
              <th className="px-4 py-3 font-medium">TTL (s)</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {filteredItems.map((item) => (
              <tr key={item.key} className="hover:bg-neutral-800/30 group">
                <td className="px-4 py-3 font-mono text-neutral-300 font-medium">{item.key}</td>
                <td className="px-4 py-3 text-neutral-400 font-mono truncate max-w-xs">{item.value}</td>
                <td className="px-4 py-3 text-neutral-400">{item.ttl}</td>
                <td className="px-4 py-3">
                  <Badge variant={item.status === 'ACTIVE' ? 'success' : 'outline'}>{item.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <button 
                    onClick={() => deleteCacheKey(item.key)}
                    className="text-neutral-600 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredItems.length === 0 && (
          <div className="p-8 text-center text-neutral-500 text-sm">No keys found</div>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Set Cache Key">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-neutral-400">Key</label>
            <Input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="session:123" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-400">Value</label>
            <Input value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Raw string or JSON" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-400">TTL (Seconds)</label>
            <Input type="number" value={newTTL} onChange={e => setNewTTL(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSet}>Set Key</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};