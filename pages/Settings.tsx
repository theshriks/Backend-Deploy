import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Input, Card, CardHeader, CardTitle, CardContent, Badge } from '../components/ui';
import { Copy, RefreshCw, Trash2, Shield, Key, Settings as SettingsIcon, Check } from 'lucide-react';

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className="text-neutral-500 hover:text-white transition-colors" title="Copy">
      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
    </button>
  );
};

export const Settings: React.FC = () => {
  const { currentProject, environment } = useStore();
  const [activeTab, setActiveTab] = useState<'general' | 'keys' | 'billing'>('general');

  // Mock API Keys
  const [keys, setKeys] = useState([
    { id: 'pk_live_1', name: 'Production - Web', prefix: 'pk_live_83b...', created: '2023-10-01', lastUsed: 'Just now' },
    { id: 'sk_live_1', name: 'Production - Backend', prefix: 'sk_live_99a...', created: '2023-10-01', lastUsed: '5 mins ago' },
    { id: 'sk_test_1', name: 'CI/CD Pipeline', prefix: 'sk_test_77c...', created: '2023-11-15', lastUsed: '2 days ago' },
  ]);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-medium text-white">Project Settings</h2>
        <p className="text-sm text-neutral-500">Manage configuration, keys, and billing for {currentProject}.</p>
      </div>

      <div className="flex gap-2 border-b border-neutral-800">
        <button
          onClick={() => setActiveTab('general')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === 'general' ? 'border-white text-white' : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
        >
          <SettingsIcon className="h-4 w-4" /> General
        </button>
        <button
          onClick={() => setActiveTab('keys')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === 'keys' ? 'border-white text-white' : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
        >
          <Key className="h-4 w-4" /> API Keys
        </button>
        <button
          onClick={() => setActiveTab('billing')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === 'billing' ? 'border-white text-white' : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
        >
          <Shield className="h-4 w-4" /> Security
        </button>
      </div>

      {activeTab === 'general' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Project Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-neutral-400">Project Name</label>
                <div className="flex gap-2">
                  <Input defaultValue={currentProject} />
                  <Button variant="secondary">Save</Button>
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-neutral-400">Project ID</label>
                <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2">
                  <span className="font-mono text-sm text-neutral-300">p_83921048_shrik_v1</span>
                  <CopyButton text="p_83921048_shrik_v1" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-neutral-400">Environment</label>
                  <div>
                    <Badge variant="outline" className={environment === 'prod' ? 'text-red-400 border-red-900/50 bg-red-950/20' : 'text-green-400'}>
                      {environment.toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-neutral-400">Region</label>
                  <div className="text-sm text-neutral-300 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-500"></span>
                    US East (N. Virginia)
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="rounded-lg border border-red-900/30 bg-red-950/5 p-6">
            <h3 className="text-sm font-medium text-red-500 mb-2">Danger Zone</h3>
            <p className="text-sm text-neutral-500 mb-4">
              Deleting this project will permanently remove all documents, streams, and storage files. This action cannot be undone.
            </p>
            <div className="flex justify-end">
              <Button variant="danger">Delete Project</Button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'keys' && (
        <div className="space-y-6">
          <div className="flex justify-end">
             <Button>
                <RefreshCw className="mr-2 h-4 w-4" /> Create New Key
             </Button>
          </div>
          <div className="rounded-md border border-neutral-800 bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-xs uppercase text-neutral-500 border-b border-neutral-800">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Key Prefix</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Last Used</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {keys.map(key => (
                  <tr key={key.id} className="hover:bg-neutral-800/30">
                    <td className="px-4 py-3 text-neutral-300 font-medium">{key.name}</td>
                    <td className="px-4 py-3 font-mono text-neutral-500">{key.prefix}</td>
                    <td className="px-4 py-3 text-neutral-400">{key.created}</td>
                    <td className="px-4 py-3 text-neutral-400">{key.lastUsed}</td>
                    <td className="px-4 py-3 text-right">
                       <button className="text-neutral-500 hover:text-red-500 p-1">
                          <Trash2 className="h-4 w-4" />
                       </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'billing' && (
          <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-neutral-800 rounded-lg">
              <Shield className="h-12 w-12 text-neutral-600 mb-4" />
              <h3 className="text-lg font-medium text-white">SSO & Compliance</h3>
              <p className="text-neutral-500 max-w-sm mt-2">Upgrade to the Enterprise plan to enable SAML SSO, Audit Logs retention, and VPC Peering.</p>
              <Button className="mt-6" variant="secondary">Contact Sales</Button>
          </div>
      )}
    </div>
  );
};