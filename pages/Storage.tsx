import React from 'react';
import { useStore } from '../store';
import { Button, Badge } from '../components/ui';
import { Upload, File, Copy, Image as ImageIcon } from 'lucide-react';

export const Storage: React.FC = () => {
  const { files, uploadFile } = useStore();

  const handleUpload = () => {
    // Mock upload
    const names = ['data_export.csv', 'avatar_hires.jpg', 'log_dump_2023.txt'];
    const types = ['text/csv', 'image/jpeg', 'text/plain'];
    const idx = Math.floor(Math.random() * 3);
    uploadFile(names[idx], Math.floor(Math.random() * 5000000), types[idx]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-white">Files</h2>
        <Button onClick={handleUpload}>
          <Upload className="mr-2 h-4 w-4" /> Upload File
        </Button>
      </div>

      <div className="rounded-md border border-neutral-800 bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase text-neutral-500 border-b border-neutral-800">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Content Hash (CID)</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Uploaded</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {files.map((file) => (
              <tr key={file.id} className="hover:bg-neutral-800/30">
                <td className="px-4 py-3 flex items-center gap-3 text-neutral-300">
                  {file.type.startsWith('image/') ? <ImageIcon className="h-4 w-4 text-neutral-500" /> : <File className="h-4 w-4 text-neutral-500" />}
                  {file.name}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-neutral-500 bg-neutral-900 px-1 py-0.5 rounded border border-neutral-800">{file.hash.substring(0, 16)}...</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-neutral-400">{(file.size / 1024).toFixed(2)} KB</td>
                <td className="px-4 py-3 text-neutral-400">{new Date(file.uploadedAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => alert(`Copied hash: ${file.hash}`)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};