import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Input, Modal, Badge } from '../components/ui';
import { Plus, Bell, Play } from 'lucide-react';

export const Alerts: React.FC = () => {
  const { alertRules, createAlert } = useStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // Form state
  const [source, setSource] = useState('system-logs');
  const [field, setField] = useState('level');
  const [value, setValue] = useState('error');
  const [action, setAction] = useState('email:devops@shrik.io');

  const handleCreate = () => {
    createAlert({ source, conditionField: field, conditionValue: value, action });
    setIsModalOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-white">Alert Rules</h2>
        <Button onClick={() => setIsModalOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Alert Rule
        </Button>
      </div>

      <div className="grid gap-4">
        {alertRules.map(rule => (
          <div key={rule.id} className="flex items-center justify-between rounded-lg border border-neutral-800 bg-surface p-4">
            <div className="flex items-start gap-4">
              <div className="mt-1 rounded-full bg-neutral-900 p-2 text-neutral-400">
                <Bell className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-white">If <span className="font-mono text-blue-400">{rule.conditionField}</span> == <span className="font-mono text-orange-400">"{rule.conditionValue}"</span></h3>
                  <Badge variant={rule.active ? 'success' : 'outline'}>{rule.active ? 'Active' : 'Paused'}</Badge>
                </div>
                <p className="mt-1 text-sm text-neutral-500">
                  Source: <span className="text-neutral-300">{rule.source}</span> • Action: <span className="text-neutral-300">{rule.action}</span>
                </p>
              </div>
            </div>
            <div>
              <Button variant="secondary" size="sm" onClick={() => alert("Test triggered: Mock notification sent.")}>
                <Play className="mr-2 h-3 w-3" /> Test
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Create Alert Rule">
        <div className="space-y-4">
           <div>
            <label className="mb-1 block text-sm text-neutral-400">Source Stream/Collection</label>
            <Input value={source} onChange={e => setSource(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
                <label className="mb-1 block text-sm text-neutral-400">Field</label>
                <Input value={field} onChange={e => setField(e.target.value)} />
            </div>
            <div>
                <label className="mb-1 block text-sm text-neutral-400">Value (Exact Match)</label>
                <Input value={value} onChange={e => setValue(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-400">Action (Webhook / Email)</label>
            <Input value={action} onChange={e => setAction(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create Rule</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};