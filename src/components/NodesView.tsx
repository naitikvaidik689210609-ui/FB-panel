import {
  Check,
  Copy,
  Globe,
  HardDrive,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { apiFetch } from '../lib/api';
import type { AuthUser, NodeItem } from '../types';

interface NodesViewProps {
  currentUser: AuthUser;
  socket: Socket | null;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function NodesView({ currentUser, socket, onNotify }: NodesViewProps) {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  // Add Remote Node form state
  const [name, setName] = useState('');
  const [location, setLocation] = useState('DE · Falkenstein');
  const [fqdn, setFqdn] = useState('');
  const [daemonPort, setDaemonPort] = useState(8443);
  const [creating, setCreating] = useState(false);

  // Install Command Modal (for newly created node or rotated token)
  const [tokenReveal, setTokenReveal] = useState<{
    nodeName: string;
    rawToken: string;
  } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedTok, setCopiedTok] = useState(false);

  const isStaff = currentUser.role === 'owner' || currentUser.role === 'admin';

  const loadNodes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ nodes: NodeItem[] }>('/api/nodes');
      setNodes(res.nodes);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load VPS nodes', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  useEffect(() => {
    if (!socket) return;
    const handleNodesUpdate = (updated: NodeItem[]) => {
      if (Array.isArray(updated)) {
        setNodes(updated);
      }
    };
    socket.on('nodes:update', handleNodesUpdate);
    return () => {
      socket.off('nodes:update', handleNodesUpdate);
    };
  }, [socket]);

  async function handleAddNode(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await apiFetch<{ node: NodeItem; rawToken: string }>('/api/nodes', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim(),
          fqdn: fqdn.trim(),
          daemonPort: Number(daemonPort),
        }),
      });
      setShowAddModal(false);
      setName('');
      setFqdn('');
      setTokenReveal({ nodeName: res.node.name, rawToken: res.rawToken });
      setCopiedCmd(false);
      setCopiedTok(false);
      onNotify(`Registered remote VPS node '${res.node.name}'.`);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create remote node', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleRotateToken(node: NodeItem) {
    try {
      const res = await apiFetch<{ rawToken: string; tokenPrefix: string }>(
        `/api/nodes/${node.id}/token`,
        { method: 'POST' }
      );
      setTokenReveal({ nodeName: node.name, rawToken: res.rawToken });
      setCopiedCmd(false);
      setCopiedTok(false);
      onNotify(`Rotated agent token for '${node.name}'.`);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to rotate node token', 'error');
    }
  }

  async function handleDeleteNode(node: NodeItem) {
    try {
      await apiFetch(`/api/nodes/${node.id}`, { method: 'DELETE' });
      onNotify(`Removed node '${node.name}'.`);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete node', 'error');
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://panel.local';
  const buildInstallCommand = (rawToken: string) =>
    `bash <(curl -sSL ${origin}/api/nodes/install-script) --token ${rawToken} --panel ${origin}`;

  const onlineCount = nodes.filter((n) => n.status === 'online').length;
  const totalWorkloads = nodes.reduce((acc, n) => acc + (n.workload_count || 0), 0);

  return (
    <div className="space-y-6">
      {/* Cluster Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Connected VPS Nodes</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
            {onlineCount} / {nodes.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">Online control-plane &amp; remote daemons</p>
        </div>

        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Provisioned Workloads</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
            {totalWorkloads}
          </p>
          <p className="mt-1 text-xs text-slate-400">Minecraft containers &amp; Incus VMs</p>
        </div>

        <div className="cyber-glass flex items-center justify-between rounded-xl p-4">
          <div>
            <p className="text-xs text-slate-400">Multi-Node Mesh</p>
            <p className="mt-1 text-sm font-semibold text-white">Ubuntu / Debian Agent</p>
            <p className="mt-0.5 text-xs text-slate-400">Socket.IO encrypted control channel</p>
          </div>
          {isStaff && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Node
            </button>
          )}
        </div>
      </div>

      {/* Node Cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="cyber-glass h-48 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {nodes.map((node) => {
            const isOnline = node.status === 'online';
            return (
              <div key={node.id} className="cyber-glass rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-violet-500/15 pb-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                        isOnline
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-600/40 bg-slate-800/40 text-slate-400'
                      }`}
                    >
                      <Server className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-base font-semibold text-white">{node.name}</h3>
                        {node.is_local === 1 && (
                          <span className="text-[11px] font-medium text-violet-300">
                            · Control Plane
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1">
                          <Globe className="h-3 w-3 text-violet-400" />
                          {node.location}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-slate-300">
                          {node.fqdn}:{node.daemon_port}
                        </span>
                      </div>
                    </div>
                  </div>

                  <span
                    className={`text-xs font-semibold ${
                      isOnline ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {isOnline ? 'Online' : 'Offline'}
                  </span>
                </div>

                {/* Live CPU / RAM / Disk Telemetry Meters */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-400">CPU</span>
                      <span className="font-mono text-white tabular-nums">
                        {Number(node.cpu_percent || 0).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                      <div
                        className="h-full bg-violet-500 transition-all"
                        style={{ width: `${Math.min(100, Math.max(0, node.cpu_percent || 0))}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-400">RAM</span>
                      <span className="font-mono text-white tabular-nums">
                        {Number(node.ram_percent || 0).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                      <div
                        className="h-full bg-cyan-500 transition-all"
                        style={{ width: `${Math.min(100, Math.max(0, node.ram_percent || 0))}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-400">Disk</span>
                      <span className="font-mono text-white tabular-nums">
                        {Number(node.disk_percent || 0).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.min(100, Math.max(0, node.disk_percent || 0))}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-violet-500/15 pt-3 text-xs">
                  <div className="flex flex-wrap items-center gap-3 text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5 text-violet-400" />
                      <strong className="font-mono text-white tabular-nums">
                        {node.workload_count}
                      </strong>{' '}
                      assigned ·{' '}
                      <strong className="font-mono text-white tabular-nums">
                        {node.active_servers}
                      </strong>{' '}
                      running
                    </span>
                    <span className="font-mono text-slate-500">
                      Seen:{' '}
                      {node.last_seen_at
                        ? new Date(node.last_seen_at).toLocaleTimeString()
                        : 'Never'}
                    </span>
                  </div>

                  {isStaff && node.is_local === 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRotateToken(node)}
                        className="inline-flex items-center gap-1 rounded-lg border border-violet-500/35 bg-violet-600/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30 whitespace-nowrap shrink-0"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Agent Command / Rotate Token
                      </button>
                      <button
                        type="button"
                        disabled={node.workload_count > 0}
                        title={
                          node.workload_count > 0
                            ? 'Remove or migrate workloads on this node first'
                            : 'Delete remote node'
                        }
                        onClick={() => void handleDeleteNode(node)}
                        className="rounded p-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ADD REMOTE NODE MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-base font-semibold text-white">Connect Remote VPS Node</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAddNode} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-slate-300">Node Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="EU Game Node #2"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-300">Location / Region</label>
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="DE · Falkenstein"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-300">FQDN or IPv4</label>
                  <input
                    type="text"
                    required
                    value={fqdn}
                    onChange={(e) => setFqdn(e.target.value)}
                    placeholder="node2.example.com"
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Daemon Port</label>
                  <input
                    type="number"
                    required
                    min={1024}
                    max={65535}
                    value={daemonPort}
                    onChange={(e) => setDaemonPort(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {creating ? 'Generating Token...' : 'Register Node'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 1-CLICK NODE AGENT INSTALL COMMAND MODAL */}
      {tokenReveal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-2xl rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2.5">
                <Terminal className="h-5 w-5 text-violet-400" />
                <div>
                  <h3 className="text-base font-semibold text-white">
                    1-Click Node Agent Setup · {tokenReveal.nodeName}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Run this command on your secondary Ubuntu/Debian VPS as root
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTokenReveal(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>One-Line Installer Command</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(buildInstallCommand(tokenReveal.rawToken));
                    setCopiedCmd(true);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/20"
                >
                  {copiedCmd ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedCmd ? 'Copied Command' : 'Copy Command'}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-violet-500/25 bg-[#070510] p-3.5 font-mono text-xs text-emerald-300">
                {buildInstallCommand(tokenReveal.rawToken)}
              </pre>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-amber-400" />
                  Secret Node Token (displayed once)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(tokenReveal.rawToken);
                    setCopiedTok(true);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/20"
                >
                  {copiedTok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedTok ? 'Copied Token' : 'Copy Token'}
                </button>
              </div>
              <code className="block truncate rounded-lg border border-violet-500/20 bg-[#090714] px-3 py-2 font-mono text-xs text-violet-200">
                {tokenReveal.rawToken}
              </code>
            </div>

            <div className="flex justify-end border-t border-violet-500/15 pt-3">
              <button
                type="button"
                onClick={() => setTokenReveal(null)}
                className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
