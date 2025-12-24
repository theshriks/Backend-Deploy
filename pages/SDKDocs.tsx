import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Button } from '../components/ui';
import { Terminal, Copy, ExternalLink, Book, Code, Check } from 'lucide-react';

const LANGUAGES = [
  { 
    id: 'node', 
    label: 'Node.js', 
    install: 'npm install @shrik/sdk', 
    snippet: `import { Shrik } from '@shrik/sdk';

const client = new Shrik({
  apiKey: process.env.SHRIK_API_KEY,
  region: 'us-east-1'
});

// Insert a document
await client.collection('events').insert({
  user_id: 'user_123',
  action: 'login',
  metadata: { device: 'mobile' }
});` 
  },
  { 
    id: 'python', 
    label: 'Python', 
    install: 'pip install shrikdb', 
    snippet: `from shrikdb import Shrik
import os

client = Shrik(
    api_key=os.getenv('SHRIK_API_KEY'),
    region='us-east-1'
)

# Insert a document
client.collection('events').insert({
    'user_id': 'user_123',
    'action': 'login',
    'metadata': { 'device': 'mobile' }
})` 
  },
  { 
    id: 'go', 
    label: 'Go', 
    install: 'go get github.com/shrik/sdk-go', 
    snippet: `package main

import (
    "context"
    "os"
    "github.com/shrik/sdk-go"
)

func main() {
    client := shrik.NewClient(os.Getenv("SHRIK_API_KEY"))

    // Insert a document
    client.Collection("events").Insert(context.Background(), map[string]interface{}{
        "user_id": "user_123",
        "action":  "login",
    })
}` 
  },
  { 
    id: 'rust', 
    label: 'Rust', 
    install: 'cargo add shrikdb', 
    snippet: `use shrikdb::Client;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new(std::env::var("SHRIK_API_KEY")?);

    client.collection("events").insert(json!({
        "user_id": "user_123",
        "action": "login"
    })).await?;

    Ok(())
}` 
  }
];

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className="text-neutral-500 hover:text-white transition-colors">
      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
    </button>
  );
};

export const SDKDocs: React.FC = () => {
  const [activeLang, setActiveLang] = useState(LANGUAGES[0]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-lg font-medium text-white">Developer Resources</h2>
        <p className="text-sm text-neutral-500">Integrate ShrikDB into your application in minutes.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Language Selection */}
          <div className="flex border-b border-neutral-800">
            {LANGUAGES.map(lang => (
              <button
                key={lang.id}
                onClick={() => setActiveLang(lang)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  activeLang.id === lang.id
                    ? 'border-white text-white'
                    : 'border-transparent text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>

          {/* Installation */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-neutral-500 tracking-wider">Installation</h3>
            <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 p-4 font-mono text-sm text-neutral-300">
              <div className="flex items-center gap-3">
                <span className="text-neutral-600">$</span>
                {activeLang.install}
              </div>
              <CopyButton text={activeLang.install} />
            </div>
          </div>

          {/* Code Snippet */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-neutral-500 tracking-wider">Quick Start</h3>
            <div className="relative rounded-md border border-neutral-800 bg-neutral-950 p-4 font-mono text-sm">
              <div className="absolute right-4 top-4">
                <CopyButton text={activeLang.snippet} />
              </div>
              <pre className="overflow-x-auto">
                <code className="text-neutral-300">{activeLang.snippet}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Sidebar Resources */}
        <div className="space-y-4">
          <Card className="hover:border-neutral-700 transition-colors cursor-pointer">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Book className="h-4 w-4 text-neutral-400" /> API Reference
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500 mb-4">Complete HTTP API specification and endpoint documentation.</p>
              <div className="flex items-center text-xs font-medium text-blue-400">
                View Docs <ExternalLink className="ml-1 h-3 w-3" />
              </div>
            </CardContent>
          </Card>

          <Card className="hover:border-neutral-700 transition-colors cursor-pointer">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Code className="h-4 w-4 text-neutral-400" /> CLI Tool
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500 mb-4">Manage streams and collections directly from your terminal.</p>
              <div className="flex items-center text-xs font-medium text-blue-400">
                Download CLI <ExternalLink className="ml-1 h-3 w-3" />
              </div>
            </CardContent>
          </Card>

          <Card className="hover:border-neutral-700 transition-colors cursor-pointer">
             <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-neutral-400" /> Architecture
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-500 mb-4">Deep dive into ShrikDB's distributed log and storage engine.</p>
               <div className="flex items-center text-xs font-medium text-blue-400">
                Read Guide <ExternalLink className="ml-1 h-3 w-3" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};