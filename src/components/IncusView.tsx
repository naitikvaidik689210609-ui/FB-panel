import {
  Archive,
  Camera,
  Clock,
  CloudUpload,
  Copy,
  Download,
  Globe,
  HardDrive,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Server,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { apiDownloadFile, apiFetch, formatBytes } from '../lib/api';
import type {
  AuthUser,
  IncusBackupItem,
  IncusScheduleItem,
  ManagedUser,
  NodeItem,
  PortAllocation,
  ReverseProxyItem,
  VmInstance,
} from '../types';
import { type MetricPoint, ResourceChart } from './ResourceChart';
import { TerminalView } from './TerminalView';

interface IncusViewProps {
  currentUser: AuthUser;
  instances: VmInstance[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRefresh: () => Promise<void>;
  socket: Socket | null;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  openCreateSignal: number;
}

const OS_OPTIONS = [
  { id: 'ubuntu-24.04', label: 'Ubuntu 24.04 LTS' },
  { id: 'ubuntu-22.04', label: 'Ubuntu 22.04 LTS' },
  { id: 'debian-12', label: 'Debian 12 (Bookworm)' },
  { id: 'alpine-3.20', label: 'Alpine Linux 3.20' },
];

export function IncusView({
  currentUser,
  instances,
  selectedId,
  onSelect,
  onRefresh,
  socket,
  onNotify,
  openCreateSignal,
}: IncusViewProps) {
  const [activeTab, setActiveTab] = useState<
    'shell' | 'graph' | 'ports' | 'proxies' | 'snapshots' | 'specs'
  >('shell');
  const [showCreate, setShowCreate] = useState(false);
  const [showReinstall, setShowReinstall] = useState(false);
  const [allUsers, setAllUsers] = useState<ManagedUser[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);

  // Create form
  const [name, setName] = useState('');
  const [type, setType] = useState<'container' | 'vm'>('container');
  const [osTemplate, setOsTemplate] = useState('ubuntu-24.04');
  const [vcpu, setVcpu] = useState(2);
  const [ramMb, setRamMb] = useState(2048);
  const [diskGb, setDiskGb] = useState(20);
  const [nodeId, setNodeId] = useState<number>(1);
  const [rootPassword, setRootPassword] = useState('');
  const [assignOwnerId, setAssignOwnerId] = useState<number>(currentUser.id);
  const [creating, setCreating] = useState(false);

  // Reinstall OS form
  const [reinstallOs, setReinstallOs] = useState('ubuntu-24.04');
  const [reinstallPass, setReinstallPass] = useState('');
  const [reinstalling, setReinstalling] = useState(false);

  // Shell & Live Resource Chart
  const termWriteRef = useRef<((chunk: string) => void) | null>(null);
  const termClearRef = useRef<(() => void) | null>(null);
  const [metricPoints, setMetricPoints] = useState<MetricPoint[]>([]);
  const [metricLive, setMetricLive] = useState(false);

  // Ports state
  const [ports, setPorts] = useState<PortAllocation[]>([]);
  const [hostPort, setHostPort] = useState(8080);
  const [targetPort, setTargetPort] = useState(80);
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp');

  // Reverse Proxy state
  const [proxies, setProxies] = useState<ReverseProxyItem[]>([]);
  const [proxyDomain, setProxyDomain] = useState('');
  const [proxyTargetPort, setProxyTargetPort] = useState(80);
  const [proxyEngine, setProxyEngine] = useState<'caddy' | 'nginx'>('caddy');
  const [proxySsl, setProxySsl] = useState(true);

  // Snapshots, Local Archives & Automated Schedules state
  const [incusBackups, setIncusBackups] = useState<IncusBackupItem[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [incusSchedules, setIncusSchedules] = useState<IncusScheduleItem[]>([]);
  const [snapName, setSnapName] = useState('');
  const [creatingKind, setCreatingKind] = useState<'snapshot' | 'archive' | null>(null);
  const [uploadingBackupId, setUploadingBackupId] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<IncusBackupItem | null>(null);
  const [restoreSafetySnap, setRestoreSafetySnap] = useState(true);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [schedName, setSchedName] = useState('');
  const [schedCron, setSchedCron] = useState('0 3 * * *');
  const [schedAction, setSchedAction] = useState<'snapshot' | 'local_backup'>('snapshot');
  const [schedRetention, setSchedRetention] = useState(7);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Admin limits state
  const [adminOwnerId, setAdminOwnerId] = useState<number>(currentUser.id);
  const [adminVcpu, setAdminVcpu] = useState<number>(2);
  const [adminRam, setAdminRam] = useState<number>(2048);
  const [adminDisk, setAdminDisk] = useState<number>(20);

  const isStaff = currentUser.role === 'owner' || currentUser.role === 'admin';
  const selected = instances.find((i) => i.id === selectedId) || instances[0] || null;

  useEffect(() => {
    apiFetch<{ nodes: NodeItem[] }>('/api/nodes')
      .then((res) => {
        setNodes(res.nodes);
        if (res.nodes.length > 0 && !res.nodes.some((n) => n.id === nodeId)) {
          setNodeId(res.nodes[0].id);
        }
      })
      .catch(() => {});
    if (isStaff) {
      apiFetch<{ users: ManagedUser[] }>('/api/users')
        .then((res) => setAllUsers(res.users))
        .catch(() => {});
    }
  }, [isStaff]);

  useEffect(() => {
    if (openCreateSignal > 0) setShowCreate(true);
  }, [openCreateSignal]);

  useEffect(() => {
    if (!selectedId && instances.length > 0) {
      onSelect(instances[0].id);
    }
  }, [instances, selectedId, onSelect]);

  useEffect(() => {
    setConfirmDelete(false);
    setMetricPoints([]);
    if (selected) {
      setReinstallOs(selected.os_template);
      setAdminOwnerId(selected.owner_id || currentUser.id);
      setAdminVcpu(selected.vcpu);
      setAdminRam(selected.ram_mb);
      setAdminDisk(selected.disk_gb);
    }
  }, [selected?.id]);

  // Poll live resource metrics for Chart.js 10m window
  useEffect(() => {
    if (!selected) return;
    let active = true;

    const poll = () => {
      apiFetch<{ cpuPercent: number; ramUsedMb: number; ramLimitMb: number; live: boolean }>(
        `/api/incus/instances/${selected.id}/metrics`
      )
        .then((m) => {
          if (!active) return;
          setMetricLive(m.live);
          const nowLabel = new Date().toLocaleTimeString([], {
            minute: '2-digit',
            second: '2-digit',
          });
          setMetricPoints((prev) => [
            ...prev.slice(-299),
            { label: nowLabel, cpuPercent: m.cpuPercent, ramUsedMb: m.ramUsedMb },
          ]);
        })
        .catch(() => {});
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!socket || !selected || activeTab !== 'shell') return;
    const handleShellData = (chunk: string) => termWriteRef.current?.(chunk);
    socket.on('incus:shell:data', handleShellData);
    termClearRef.current?.();
    socket.emit('incus:shell:start', { instanceId: selected.id });
    return () => {
      socket.off('incus:shell:data', handleShellData);
    };
  }, [socket, selected?.id, activeTab]);

  const loadPorts = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await apiFetch<{ ports: PortAllocation[] }>(
        `/api/incus/instances/${selected.id}/ports`
      );
      setPorts(res.ports);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load port rules', 'error');
    }
  }, [selected?.id, onNotify]);

  const loadProxies = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await apiFetch<{ proxies: ReverseProxyItem[] }>(
        `/api/incus/instances/${selected.id}/proxies`
      );
      setProxies(res.proxies);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load reverse proxies', 'error');
    }
  }, [selected?.id, onNotify]);

  const loadSnapshotsAndBackups = useCallback(async () => {
    if (!selected) return;
    setBackupsLoading(true);
    try {
      const [bRes, sRes] = await Promise.all([
        apiFetch<{ backups: IncusBackupItem[] }>(`/api/incus/instances/${selected.id}/backups`),
        apiFetch<{ schedules: IncusScheduleItem[] }>(`/api/incus/instances/${selected.id}/schedules`),
      ]);
      setIncusBackups(bRes.backups);
      setIncusSchedules(sRes.schedules);
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Failed to load snapshots & backups',
        'error'
      );
    } finally {
      setBackupsLoading(false);
    }
  }, [selected?.id, onNotify]);

  useEffect(() => {
    if (!selected) return;
    if (activeTab === 'ports') void loadPorts();
    if (activeTab === 'proxies') void loadProxies();
    if (activeTab === 'snapshots') void loadSnapshotsAndBackups();
  }, [activeTab, selected?.id, loadPorts, loadProxies, loadSnapshotsAndBackups]);

  async function handleCreateInstance(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await apiFetch<{
        instance: VmInstance;
        incusProvisioned: boolean;
        note?: string;
      }>('/api/incus/instances', {
        method: 'POST',
        body: JSON.stringify({
          name,
          type,
          osTemplate,
          vcpu: Number(vcpu),
          ramMb: Number(ramMb),
          diskGb: Number(diskGb),
          nodeId: Number(nodeId || 1),
          rootPassword,
          ownerId: isStaff ? assignOwnerId : currentUser.id,
        }),
      });
      setShowCreate(false);
      setName('');
      setRootPassword('');
      await onRefresh();
      onSelect(res.instance.id);
      onNotify(res.note || `Instance '${res.instance.name}' launched.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to launch instance', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handlePower(action: 'start' | 'stop' | 'restart' | 'delete') {
    if (!selected) return;
    try {
      const res = await apiFetch<{ status: string; deleted?: boolean }>(
        `/api/incus/instances/${selected.id}/power`,
        {
          method: 'POST',
          body: JSON.stringify({ action }),
        }
      );
      await onRefresh();
      if (res.deleted) {
        onSelect(null);
        onNotify(`Instance '${selected.name}' deleted.`);
      } else {
        onNotify(`Instance action '${action}' completed.`);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `Failed to ${action} instance`, 'error');
    }
  }

  async function handleReinstallOs(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setReinstalling(true);
    try {
      const res = await apiFetch<{ instance: VmInstance; note?: string }>(
        `/api/incus/instances/${selected.id}/reinstall`,
        {
          method: 'POST',
          body: JSON.stringify({ osTemplate: reinstallOs, rootPassword: reinstallPass }),
        }
      );
      setShowReinstall(false);
      setReinstallPass('');
      await onRefresh();
      onNotify(
        res.note || `Reinstalled '${selected.name}' with ${reinstallOs} (IP & port rules kept).`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'OS reinstall failed', 'error');
    } finally {
      setReinstalling(false);
    }
  }

  async function handleAddPort(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/ports`, {
        method: 'POST',
        body: JSON.stringify({
          hostPort: Number(hostPort),
          targetPort: Number(targetPort),
          protocol,
        }),
      });
      await loadPorts();
      onNotify(`Added NAT proxy ${hostPort}/${protocol} -> ${targetPort}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to add NAT port', 'error');
    }
  }

  async function handleRemovePort(allocId: number) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/ports/${allocId}`, {
        method: 'DELETE',
      });
      await loadPorts();
      onNotify('Port forwarding rule removed.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to remove rule', 'error');
    }
  }

  async function handleCreateProxy(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    try {
      const res = await apiFetch<{
        proxy: ReverseProxyItem & { appliedOnHost: boolean };
      }>(`/api/incus/instances/${selected.id}/proxies`, {
        method: 'POST',
        body: JSON.stringify({
          domain: proxyDomain,
          targetPort: Number(proxyTargetPort),
          sslEnabled: proxySsl,
          engine: proxyEngine,
        }),
      });
      setProxyDomain('');
      await loadProxies();
      onNotify(
        res.proxy.appliedOnHost
          ? `Reverse proxy applied & reloaded for ${res.proxy.domain}`
          : `Saved ${proxyEngine.toUpperCase()} config for ${res.proxy.domain}`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create proxy route', 'error');
    }
  }

  async function handleDeleteProxy(proxyId: number) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/proxies/${proxyId}`, {
        method: 'DELETE',
      });
      await loadProxies();
      onNotify('Reverse proxy route deleted.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete route', 'error');
    }
  }

  async function handleCreateIncusBackup(kind: 'snapshot' | 'archive') {
    if (!selected) return;
    setCreatingKind(kind);
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/backups`, {
        method: 'POST',
        body: JSON.stringify({
          name: snapName.trim() || undefined,
          kind,
        }),
      });
      setSnapName('');
      await loadSnapshotsAndBackups();
      onNotify(
        kind === 'archive'
          ? 'Local .tar.gz VM/LXC archive exported.'
          : 'Point-in-time Incus snapshot created.'
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Snapshot / backup creation failed',
        'error'
      );
    } finally {
      setCreatingKind(null);
    }
  }

  async function handleConfirmIncusRestore() {
    if (!selected || !restoreTarget) return;
    setRestoringBackup(true);
    try {
      await apiFetch(
        `/api/incus/instances/${selected.id}/backups/${restoreTarget.id}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ createPreRestore: restoreSafetySnap }),
        }
      );
      onNotify(`Restored '${selected.name}' to '${restoreTarget.name}'.`);
      setRestoreTarget(null);
      await Promise.all([loadSnapshotsAndBackups(), onRefresh()]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Restore failed', 'error');
    } finally {
      setRestoringBackup(false);
    }
  }

  async function handleUploadIncusBackupToCloud(backupId: number) {
    if (!selected) return;
    setUploadingBackupId(backupId);
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/backups/${backupId}/cloud`, {
        method: 'POST',
      });
      await loadSnapshotsAndBackups();
      onNotify('Archive offloaded to configured cloud storage.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cloud upload failed', 'error');
    } finally {
      setUploadingBackupId(null);
    }
  }

  async function handleDeleteIncusBackup(backupId: number) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/backups/${backupId}`, {
        method: 'DELETE',
      });
      await loadSnapshotsAndBackups();
      onNotify('Restore point deleted.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleCreateIncusSchedule(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: schedName.trim(),
          cronExpr: schedCron.trim(),
          action: schedAction,
          retentionCount: Number(schedRetention),
        }),
      });
      setSchedName('');
      await loadSnapshotsAndBackups();
      onNotify('Automated snapshot/backup schedule created.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create schedule', 'error');
    }
  }

  async function handleToggleIncusSchedule(s: IncusScheduleItem) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await loadSnapshotsAndBackups();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Toggle failed', 'error');
    }
  }

  async function handleDeleteIncusSchedule(scheduleId: number) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/schedules/${scheduleId}`, {
        method: 'DELETE',
      });
      await loadSnapshotsAndBackups();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleAdminUpdate(updates: { isSuspended?: boolean; applyLimits?: boolean }) {
    if (!selected) return;
    try {
      await apiFetch(`/api/incus/instances/${selected.id}/admin`, {
        method: 'PUT',
        body: JSON.stringify({
          ...(updates.applyLimits
            ? {
                ownerId: adminOwnerId,
                vcpu: adminVcpu,
                ramMb: adminRam,
                diskGb: adminDisk,
              }
            : {}),
          ...(updates.isSuspended !== undefined ? { isSuspended: updates.isSuspended } : {}),
        }),
      });
      await onRefresh();
      onNotify('Instance administrative configuration updated.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update instance', 'error');
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Instance List */}
      <div className="cyber-glass rounded-xl p-4 lg:col-span-3">
        <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
          <h2 className="text-sm font-semibold text-white">Incus Instances</h2>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="cyber-glow-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Launch
          </button>
        </div>

        {instances.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-xs text-slate-400">No VMs or LXC containers.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {instances.map((inst) => {
              const active = selected?.id === inst.id;
              return (
                <button
                  key={inst.id}
                  type="button"
                  onClick={() => onSelect(inst.id)}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'border-violet-500/50 bg-violet-600/20 text-white'
                      : 'border-transparent text-slate-300 hover:border-violet-500/20 hover:bg-violet-500/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{inst.name}</span>
                    <span
                      className={`text-xs font-semibold shrink-0 ${
                        inst.is_suspended
                          ? 'text-red-400'
                          : inst.status === 'running'
                          ? 'text-emerald-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {inst.is_suspended
                        ? 'Suspended'
                        : inst.status === 'running'
                        ? 'Running'
                        : 'Stopped'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span className="uppercase">{inst.type}</span>
                    <span aria-hidden="true">·</span>
                    <span>{inst.os_template}</span>
                    {inst.node_name && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate text-cyan-300">{inst.node_name}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Instance Workspace */}
      <div className="lg:col-span-9">
        {!selected ? (
          <div className="cyber-glass flex min-h-[420px] flex-col items-center justify-center rounded-xl p-8 text-center">
            <h3 className="text-lg font-semibold text-white">Launch an LXC Container or KVM VM</h3>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              Provision isolated Ubuntu, Debian, or Alpine Linux workloads via Incus with web shell
              access, reverse proxy routing, NAT port forwarding, and 1-click snapshots.
            </p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="cyber-glow-btn mt-5 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            >
              <Plus className="h-4 w-4" />
              Launch Cloud Instance
            </button>
          </div>
        ) : (
          <div className="cyber-glass rounded-xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-violet-500/15 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white">{selected.name}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="uppercase">{selected.type}</span>
                  <span aria-hidden="true">·</span>
                  <span>{selected.os_template}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{selected.vcpu} vCPU</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{selected.ram_mb} MB RAM</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{selected.disk_gb} GB Disk</span>
                  {selected.ip_address && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-violet-300">{selected.ip_address}</span>
                    </>
                  )}
                  {selected.node_name && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-cyan-300">{selected.node_name}</span>
                    </>
                  )}
                  {selected.owner_username && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Owner: {selected.owner_username}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePower('start')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 whitespace-nowrap shrink-0"
                >
                  <Play className="h-3.5 w-3.5" />
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => void handlePower('restart')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/35 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 whitespace-nowrap shrink-0"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Restart
                </button>
                <button
                  type="button"
                  onClick={() => void handlePower('stop')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap shrink-0"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </button>
                <button
                  type="button"
                  onClick={() => setShowReinstall(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reinstall OS
                </button>
              </div>
            </div>

            <div className="my-4 flex flex-wrap items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
              {(
                [
                  ['shell', 'Web Shell'],
                  ['graph', 'Resource Graph'],
                  ['ports', 'NAT Ports'],
                  ['proxies', 'Reverse Proxy'],
                  ['snapshots', 'Snapshots & Backups'],
                  ['specs', 'Specs & Admin'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === tabKey
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* TAB 1: WEB SHELL */}
            {activeTab === 'shell' && (
              <div className="space-y-2">
                <TerminalView
                  interactive={true}
                  onData={(data) => socket?.emit('incus:shell:input', data)}
                  onReady={(write, clear) => {
                    termWriteRef.current = write;
                    termClearRef.current = clear;
                  }}
                />
                <p className="text-xs text-slate-400">
                  Interactive root session attached via{' '}
                  <code className="text-violet-300">incus exec {selected.instance_name}</code>.
                </p>
              </div>
            )}

            {/* TAB 2: LIVE RESOURCE GRAPH */}
            {activeTab === 'graph' && (
              <ResourceChart
                title={`${selected.name} CPU & Memory History (10m)`}
                points={metricPoints}
                ramLimitMb={selected.ram_mb}
                live={metricLive}
              />
            )}

            {/* TAB 3: NAT PORT FORWARDING */}
            {activeTab === 'ports' && (
              <div className="space-y-5">
                <form
                  onSubmit={handleAddPort}
                  className="grid grid-cols-1 gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4 sm:grid-cols-4"
                >
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Host Port (1024-65535)</label>
                    <input
                      type="number"
                      required
                      min={1024}
                      max={65535}
                      value={hostPort}
                      onChange={(e) => setHostPort(Number(e.target.value))}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Instance Target Port</label>
                    <input
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={targetPort}
                      onChange={(e) => setTargetPort(Number(e.target.value))}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Protocol</label>
                    <select
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value as 'tcp' | 'udp')}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 text-sm text-white"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      className="cyber-glow-btn w-full rounded-lg px-4 py-2 text-xs font-semibold text-white"
                    >
                      Add NAT Proxy Rule
                    </button>
                  </div>
                </form>

                {ports.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">
                    No NAT port forwarding rules configured on this instance.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                          <th className="pb-2.5 font-medium">Device Name</th>
                          <th className="pb-2.5 font-medium">Protocol</th>
                          <th className="pb-2.5 font-medium text-right">Host Port</th>
                          <th className="pb-2.5 font-medium text-right">Instance Port</th>
                          <th className="pb-2.5 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-500/10">
                        {ports.map((p) => (
                          <tr key={p.id}>
                            <td className="py-2.5 font-mono text-xs text-slate-200">{p.device_name}</td>
                            <td className="py-2.5 uppercase text-xs text-violet-300">{p.protocol}</td>
                            <td className="py-2.5 text-right font-mono text-xs text-white tabular-nums">
                              {p.host_port}
                            </td>
                            <td className="py-2.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                              {p.target_port}
                            </td>
                            <td className="py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => void handleRemovePort(p.id)}
                                className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: REVERSE PROXY / SUBDOMAIN ROUTER */}
            {activeTab === 'proxies' && (
              <div className="space-y-5">
                <form
                  onSubmit={handleCreateProxy}
                  className="grid grid-cols-1 gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4 sm:grid-cols-12"
                >
                  <div className="sm:col-span-4">
                    <label className="mb-1 block text-xs text-slate-400">Domain / Subdomain</label>
                    <input
                      type="text"
                      required
                      value={proxyDomain}
                      onChange={(e) => setProxyDomain(e.target.value)}
                      placeholder="app.example.com"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs text-slate-400">VM Port</label>
                    <input
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={proxyTargetPort}
                      onChange={(e) => setProxyTargetPort(Number(e.target.value))}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs text-slate-400">Engine</label>
                    <select
                      value={proxyEngine}
                      onChange={(e) => setProxyEngine(e.target.value as 'caddy' | 'nginx')}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="caddy">Caddy (Auto SSL)</option>
                      <option value="nginx">Nginx</option>
                    </select>
                  </div>
                  <div className="flex items-end sm:col-span-2">
                    <label className="flex items-center gap-2 pb-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        checked={proxySsl}
                        onChange={(e) => setProxySsl(e.target.checked)}
                        className="accent-violet-600"
                      />
                      Auto HTTPS
                    </label>
                  </div>
                  <div className="flex items-end sm:col-span-2">
                    <button
                      type="submit"
                      className="cyber-glow-btn w-full rounded-lg px-3 py-2 text-xs font-semibold text-white"
                    >
                      Route Domain
                    </button>
                  </div>
                </form>

                {proxies.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">
                    No subdomain reverse proxy routes configured yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {proxies.map((px) => (
                      <div
                        key={px.id}
                        className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 text-sm">
                            <Globe className="h-4 w-4 text-violet-400" />
                            <span className="font-mono font-semibold text-white">{px.domain}</span>
                            <span className="text-xs text-slate-400">
                              → {selected.ip_address || '127.0.0.1'}:{px.target_port} ·{' '}
                              {px.engine.toUpperCase()} {px.ssl_enabled ? '· SSL' : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard.writeText(px.configPreview);
                                onNotify('Copied proxy config to clipboard.');
                              }}
                              className="inline-flex items-center gap-1 rounded border border-violet-500/30 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-600/20"
                            >
                              <Copy className="h-3 w-3" />
                              Copy Config
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteProxy(px.id)}
                              className="rounded p-1 text-slate-400 hover:text-red-300"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <pre className="overflow-x-auto rounded bg-[#070510] p-3 font-mono text-xs text-slate-300">
                          {px.configPreview}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 5: SNAPSHOTS, LOCAL ARCHIVES & AUTOMATED SCHEDULES */}
            {activeTab === 'snapshots' && (
              <div className="space-y-6">
                {/* 1-Click Capture Bar */}
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <input
                    type="text"
                    value={snapName}
                    onChange={(e) => setSnapName(e.target.value)}
                    placeholder="Checkpoint label (optional, e.g. pre-upgrade-01)"
                    className="flex-1 min-w-[200px] rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={creatingKind !== null}
                    onClick={() => void handleCreateIncusBackup('snapshot')}
                    className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {creatingKind === 'snapshot' ? 'Snapshotting...' : 'Take Snapshot'}
                  </button>
                  <button
                    type="button"
                    disabled={creatingKind !== null}
                    onClick={() => void handleCreateIncusBackup('archive')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-4 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {creatingKind === 'archive' ? 'Exporting...' : 'Export Local Backup (.tar.gz)'}
                  </button>
                </div>

                {/* Point-in-Time Restore Points Table */}
                <div>
                  <h4 className="mb-2.5 text-sm font-semibold text-white">
                    Point-in-Time Restore Points
                  </h4>
                  {backupsLoading ? (
                    <div className="space-y-2 py-4">
                      {Array.from({ length: 3 }).map((_, idx) => (
                        <div key={idx} className="h-10 animate-pulse rounded bg-violet-950/35" />
                      ))}
                    </div>
                  ) : incusBackups.length === 0 ? (
                    <div className="rounded-lg border border-violet-500/15 bg-[#090714]/40 py-8 text-center text-sm text-slate-400">
                      No snapshots or local archives saved yet for {selected.instance_name}.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                            <th className="pb-2.5 font-medium">Checkpoint</th>
                            <th className="pb-2.5 font-medium">Format</th>
                            <th className="pb-2.5 font-medium">Storage</th>
                            <th className="pb-2.5 font-medium">Trigger</th>
                            <th className="pb-2.5 font-medium text-right">Size</th>
                            <th className="pb-2.5 font-medium">Created</th>
                            <th className="pb-2.5 font-medium text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-violet-500/10">
                          {incusBackups.map((item) => {
                            const hasCloud = Boolean(item.cloud_provider && item.cloud_provider !== 'local');
                            const onDisk = item.exists_on_disk !== false;
                            const canAccess =
                              item.backup_kind === 'snapshot' ? true : onDisk || hasCloud;

                            return (
                              <tr key={item.id}>
                                <td className="py-2.5 pr-3 font-mono text-xs text-white">
                                  {item.name}
                                </td>
                                <td className="py-2.5 pr-3 text-xs text-slate-300">
                                  {item.backup_kind === 'archive'
                                    ? 'Tarball (.tar.gz)'
                                    : 'CoW Snapshot'}
                                </td>
                                <td className="py-2.5 pr-3 font-mono text-xs uppercase">
                                  {hasCloud ? (
                                    <span className="text-cyan-300">
                                      {onDisk
                                        ? `Local + ${item.cloud_provider}`
                                        : `Cloud (${item.cloud_provider})`}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400">Local</span>
                                  )}
                                </td>
                                <td className="py-2.5 pr-3 text-xs capitalize text-slate-400">
                                  {item.backup_type.replace('_', ' ')}
                                </td>
                                <td className="py-2.5 pr-3 text-right font-mono text-xs text-slate-300 tabular-nums">
                                  {item.size_bytes > 0 ? formatBytes(item.size_bytes) : '--'}
                                </td>
                                <td className="py-2.5 pr-3 font-mono text-xs text-slate-400 tabular-nums">
                                  {new Date(item.created_at).toLocaleString()}
                                </td>
                                <td className="py-2.5 text-right">
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      disabled={!canAccess}
                                      onClick={() => {
                                        setRestoreSafetySnap(true);
                                        setRestoreTarget(item);
                                      }}
                                      className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-600/20 disabled:opacity-40 whitespace-nowrap shrink-0"
                                    >
                                      <RotateCcw className="h-3 w-3" />
                                      Restore
                                    </button>
                                    {item.backup_kind === 'archive' && onDisk && !hasCloud && (
                                      <button
                                        type="button"
                                        disabled={uploadingBackupId === item.id}
                                        onClick={() => void handleUploadIncusBackupToCloud(item.id)}
                                        title="Offload to Cloud Storage"
                                        className="rounded border border-cyan-500/30 p-1 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                                      >
                                        <CloudUpload className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    {item.backup_kind === 'archive' && canAccess && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void apiDownloadFile(
                                            `/api/incus/instances/${selected.id}/backups/${item.id}/download`,
                                            item.archive_filename || `${item.name}.tar.gz`
                                          )
                                        }
                                        title="Download .tar.gz"
                                        className="rounded border border-violet-500/25 p-1 text-slate-300 hover:bg-violet-600/20 hover:text-white"
                                      >
                                        <Download className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteIncusBackup(item.id)}
                                      className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Automated Snapshot & Local Backup Schedules */}
                <div className="space-y-3 border-t border-violet-500/15 pt-5">
                  <h4 className="text-sm font-semibold text-white">
                    Automated Snapshot &amp; Backup Schedules
                  </h4>
                  <form
                    onSubmit={handleCreateIncusSchedule}
                    className="space-y-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4"
                  >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-3">
                        <label className="mb-1 block text-xs text-slate-400">Schedule Name</label>
                        <input
                          type="text"
                          required
                          value={schedName}
                          onChange={(e) => setSchedName(e.target.value)}
                          placeholder="Nightly VM Snapshot"
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 text-xs text-white"
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <label className="mb-1 block text-xs text-slate-400">Cron Expression</label>
                        <input
                          type="text"
                          required
                          value={schedCron}
                          onChange={(e) => setSchedCron(e.target.value)}
                          placeholder="0 3 * * *"
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-xs text-slate-400">Action</label>
                        <select
                          value={schedAction}
                          onChange={(e) =>
                            setSchedAction(e.target.value as 'snapshot' | 'local_backup')
                          }
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="snapshot">CoW Snapshot</option>
                          <option value="local_backup">Local .tar.gz</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-xs text-slate-400">Keep Last</label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={schedRetention}
                          onChange={(e) => setSchedRetention(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                        />
                      </div>
                      <div className="flex items-end sm:col-span-2">
                        <button
                          type="submit"
                          className="cyber-glow-btn inline-flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white"
                        >
                          <Clock className="h-3.5 w-3.5" />
                          Add Rule
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-400">Presets:</span>
                      {[
                        ['Hourly', '0 * * * *'],
                        ['Every 6h', '0 */6 * * *'],
                        ['Daily 03:00', '0 3 * * *'],
                        ['Weekly Sun', '0 4 * * 0'],
                      ].map(([lbl, expr]) => (
                        <button
                          key={expr}
                          type="button"
                          onClick={() => setSchedCron(expr)}
                          className={`rounded border px-2 py-0.5 font-mono text-xs ${
                            schedCron === expr
                              ? 'border-violet-400 bg-violet-600/25 text-white'
                              : 'border-violet-500/25 text-slate-300'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </form>

                  {incusSchedules.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                            <th className="pb-2 font-medium">Rule</th>
                            <th className="pb-2 font-medium">Cron</th>
                            <th className="pb-2 font-medium">Mode</th>
                            <th className="pb-2 font-medium text-right">Retention</th>
                            <th className="pb-2 font-medium">Last Run</th>
                            <th className="pb-2 font-medium text-right">Controls</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-violet-500/10">
                          {incusSchedules.map((s) => (
                            <tr key={s.id}>
                              <td className="py-2 text-xs font-medium text-white">{s.name}</td>
                              <td className="py-2 font-mono text-xs text-violet-300">
                                {s.cron_expr}
                              </td>
                              <td className="py-2 text-xs text-slate-300">
                                {s.action === 'local_backup' ? 'Local .tar.gz' : 'CoW Snapshot'}
                              </td>
                              <td className="py-2 text-right font-mono text-xs text-slate-300 tabular-nums">
                                {s.retention_count}
                              </td>
                              <td className="py-2 font-mono text-xs text-slate-400">
                                {s.last_run_at
                                  ? new Date(s.last_run_at).toLocaleString()
                                  : 'Never'}
                              </td>
                              <td className="py-2 text-right">
                                <div className="inline-flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleToggleIncusSchedule(s)}
                                    className={`rounded px-2.5 py-1 text-xs font-medium ${
                                      s.enabled
                                        ? 'bg-emerald-500/15 text-emerald-300'
                                        : 'bg-slate-800 text-slate-400'
                                    }`}
                                  >
                                    {s.enabled ? 'Enabled' : 'Paused'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteIncusSchedule(s.id)}
                                    className="rounded p-1 text-slate-400 hover:text-red-300"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 6: SPECS, ADMIN CONTROLS & DELETE */}
            {activeTab === 'specs' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <Server className="h-3.5 w-3.5 text-violet-400" />
                      Incus Instance ID
                    </div>
                    <p className="mt-1 font-mono text-sm text-white">{selected.instance_name}</p>
                  </div>
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <HardDrive className="h-3.5 w-3.5 text-violet-400" />
                      Root Storage Quota
                    </div>
                    <p className="mt-1 font-mono text-sm text-white tabular-nums">
                      {selected.disk_gb} GB
                    </p>
                  </div>
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <Globe className="h-3.5 w-3.5 text-violet-400" />
                      Allocated IPv4
                    </div>
                    <p className="mt-1 font-mono text-sm text-white">
                      {selected.ip_address || 'Pending DHCP'}
                    </p>
                  </div>
                </div>

                {isStaff && (
                  <div className="rounded-lg border border-violet-500/25 bg-[#090714]/60 p-4 space-y-4">
                    <h4 className="text-sm font-semibold text-white">
                      Admin Ownership & Resource Limits
                    </h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">Assigned Owner</label>
                        <select
                          value={adminOwnerId}
                          onChange={(e) => setAdminOwnerId(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white"
                        >
                          {allUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username} ({u.role})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">vCPU</label>
                        <input
                          type="number"
                          min={1}
                          value={adminVcpu}
                          onChange={(e) => setAdminVcpu(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">RAM (MB)</label>
                        <input
                          type="number"
                          min={256}
                          value={adminRam}
                          onChange={(e) => setAdminRam(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">Disk (GB)</label>
                        <input
                          type="number"
                          min={5}
                          value={adminDisk}
                          onChange={(e) => setAdminDisk(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => void handleAdminUpdate({ applyLimits: true })}
                        className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white"
                      >
                        Apply Owner & Limits
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void handleAdminUpdate({ isSuspended: !selected.is_suspended })
                        }
                        className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-200"
                      >
                        {selected.is_suspended ? 'Unsuspend Instance' : 'Suspend Instance'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                  <div>
                    <h4 className="text-sm font-semibold text-red-200">Delete Instance</h4>
                    <p className="text-xs text-red-300/80">
                      Force deletes the Incus container/VM, root disk, snapshots, and NAT rules.
                    </p>
                  </div>
                  {!confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg border border-red-500/40 bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/30"
                    >
                      Delete Instance
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handlePower('delete')}
                        className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
                      >
                        Confirm Force Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* REINSTALL OS MODAL */}
      {showReinstall && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-lg font-semibold text-white">Reinstall OS · {selected.name}</h3>
              <button
                type="button"
                onClick={() => setShowReinstall(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-xs text-amber-200">
              Warning: This wipes the root filesystem and installs a fresh OS template while keeping
              your assigned IPv4 and NAT port forward rules intact.
            </p>
            <form onSubmit={handleReinstallOs} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-slate-300">New OS Template</label>
                <select
                  value={reinstallOs}
                  onChange={(e) => setReinstallOs(e.target.value)}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-sm text-white"
                >
                  {OS_OPTIONS.map((os) => (
                    <option key={os.id} value={os.id}>
                      {os.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-300">New Root Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={reinstallPass}
                  onChange={(e) => setReinstallPass(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowReinstall(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={reinstalling}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {reinstalling ? 'Reinstalling...' : 'Wipe & Reinstall OS'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LAUNCH INSTANCE MODAL */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-lg rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-lg font-semibold text-white">Launch Incus Instance</h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateInstance} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">Instance Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Proxy Node EU"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              {nodes.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Target VPS Node
                  </label>
                  <select
                    value={nodeId}
                    onChange={(e) => setNodeId(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white"
                  >
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.location}) — {n.status === 'online' ? 'Online' : 'Offline'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isStaff && allUsers.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Assign to User
                  </label>
                  <select
                    value={assignOwnerId}
                    onChange={(e) => setAssignOwnerId(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white"
                  >
                    {allUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Virtualization</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as 'container' | 'vm')}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    <option value="container">LXC System Container</option>
                    <option value="vm">KVM Virtual Machine (--vm)</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">OS Template</label>
                  <select
                    value={osTemplate}
                    onChange={(e) => setOsTemplate(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    {OS_OPTIONS.map((os) => (
                      <option key={os.id} value={os.id}>
                        {os.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">vCPU Cores</label>
                  <input
                    type="number"
                    required
                    min={1}
                    max={32}
                    value={vcpu}
                    onChange={(e) => setVcpu(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">RAM (MB)</label>
                  <input
                    type="number"
                    required
                    min={256}
                    max={131072}
                    step={256}
                    value={ramMb}
                    onChange={(e) => setRamMb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Disk (GB)</label>
                  <input
                    type="number"
                    required
                    min={5}
                    max={2000}
                    value={diskGb}
                    onChange={(e) => setDiskGb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Root Password (configured via chpasswd)
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={rootPassword}
                  onChange={(e) => setRootPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-violet-600/15"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {creating ? 'Provisioning...' : 'Launch Instance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* POINT-IN-TIME RESTORE MODAL */}
      {restoreTarget && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-semibold text-white">Restore Instance Point-in-Time</h3>
              </div>
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-300">
              <p>
                Restoring <strong className="text-white">{selected.name}</strong> from{' '}
                <span className="font-mono text-violet-300">{restoreTarget.name}</span> (
                {restoreTarget.backup_kind === 'archive' ? 'Local Tarball' : 'CoW Snapshot'}) will
                revert the root filesystem to that exact state.
              </p>
              <label className="flex items-center gap-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/70 p-3 text-slate-200">
                <input
                  type="checkbox"
                  checked={restoreSafetySnap}
                  onChange={(e) => setRestoreSafetySnap(e.target.checked)}
                  className="h-4 w-4 accent-violet-600"
                />
                <span>Create automatic safety snapshot before restoring</span>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3 border-t border-violet-500/15 pt-4">
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoringBackup}
                onClick={() => void handleConfirmIncusRestore()}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {restoringBackup ? 'Restoring...' : 'Confirm Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
