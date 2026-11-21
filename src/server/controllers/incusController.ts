import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  deleteBackupFromCloud,
  downloadBackupFromCloud,
  getCloudConfig,
  isCloudConfigured,
  uploadBackupToCloud,
} from '../cloudStorage.js';
import { db, getDataDir, recordAuditLog } from '../db.js';
import {
  getUserQuotaSummary,
  INCUS_OS_TEMPLATES,
  isValidDomain,
  isValidPort,
  isValidSnapshotName,
  resolveConfinedPath,
  sanitizeDisplayName,
  slugifyContainerName,
  type UserRole,
} from '../security.js';
import { sendDiscordAlert } from '../webhook.js';
import { dispatchNodeCommand, getNodeById } from './nodeController.js';

const execFileAsync = promisify(execFile);

export interface VmInstanceRow {
  id: number;
  name: string;
  instance_name: string;
  type: 'container' | 'vm';
  os_template: string;
  vcpu: number;
  ram_mb: number;
  disk_gb: number;
  status: string;
  is_suspended: number;
  owner_id: number | null;
  owner_username?: string;
  node_id?: number;
  node_name?: string;
  node_location?: string;
  ip_address: string | null;
  created_at: string;
}

export interface PortAllocationRow {
  id: number;
  resource_type: string;
  resource_id: number;
  host_port: number;
  target_port: number;
  protocol: 'tcp' | 'udp';
  device_name: string;
  created_at: string;
}

export interface ReverseProxyRow {
  id: number;
  instance_id: number;
  domain: string;
  target_port: number;
  ssl_enabled: number;
  engine: 'caddy' | 'nginx';
  created_at: string;
}

export async function isIncusReady(): Promise<boolean> {
  try {
    await execFileAsync('incus', ['version'], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

export async function syncIncusInstances(viewer?: {
  id: number;
  role: UserRole;
}): Promise<VmInstanceRow[]> {
  let rows: VmInstanceRow[];

  if (!viewer || viewer.role === 'owner' || viewer.role === 'admin') {
    rows = db
      .prepare(
        `SELECT vi.*, u.username AS owner_username,
                n.name AS node_name, n.location AS node_location
         FROM vm_instances vi
         LEFT JOIN users u ON u.id = vi.owner_id
         LEFT JOIN nodes n ON n.id = vi.node_id
         ORDER BY vi.created_at DESC`
      )
      .all() as VmInstanceRow[];
  } else {
    rows = db
      .prepare(
        `SELECT vi.*, u.username AS owner_username,
                n.name AS node_name, n.location AS node_location
         FROM vm_instances vi
         LEFT JOIN users u ON u.id = vi.owner_id
         LEFT JOIN nodes n ON n.id = vi.node_id
         WHERE vi.owner_id = ?
         ORDER BY vi.created_at DESC`
      )
      .all(viewer.id) as VmInstanceRow[];
  }

  const incusUp = await isIncusReady();
  if (!incusUp) return rows;

  try {
    const { stdout } = await execFileAsync('incus', ['list', '--format=json'], { timeout: 4000 });
    const list = JSON.parse(stdout) as Array<{
      name: string;
      status: string;
      state?: {
        network?: Record<string, { addresses?: Array<{ family: string; address: string; scope: string }> }>;
      };
    }>;

    const byName = new Map(list.map((item) => [item.name, item]));
    for (const row of rows) {
      if (row.node_id && row.node_id !== 1) continue;
      const live = byName.get(row.instance_name);
      if (!live) continue;

      const status = live.status.toLowerCase() === 'running' ? 'running' : 'stopped';
      let ipAddr: string | null = row.ip_address;

      if (live.state?.network) {
        for (const [iface, netInfo] of Object.entries(live.state.network)) {
          if (iface === 'lo') continue;
          const v4 = netInfo.addresses?.find((a) => a.family === 'inet' && a.scope === 'global');
          if (v4) {
            ipAddr = v4.address;
            break;
          }
        }
      }

      if (status !== row.status || ipAddr !== row.ip_address) {
        db.prepare('UPDATE vm_instances SET status = ?, ip_address = ? WHERE id = ?').run(
          status,
          ipAddr,
          row.id
        );
        row.status = status;
        row.ip_address = ipAddr;
      }
    }
  } catch {
    // Ignore transient incus list failures
  }

  return rows;
}

function setRootPasswordInInstance(instanceName: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('incus', ['exec', instanceName, '--', 'chpasswd'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `chpasswd exited with code ${code}`));
    });
    child.stdin.write(`root:${password}\n`);
    child.stdin.end();
  });
}

export async function createIncusInstance(params: {
  name: string;
  type: 'container' | 'vm';
  osTemplate: string;
  vcpu: number;
  ramMb: number;
  diskGb: number;
  rootPassword: string;
  ownerId: number;
  nodeId?: number;
  enforceQuota: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ instance: VmInstanceRow; incusProvisioned: boolean; note?: string }> {
  const displayName = sanitizeDisplayName(params.name);
  if (!displayName || displayName.length < 2) {
    throw new Error('Instance name must be at least 2 characters.');
  }

  if (params.type !== 'container' && params.type !== 'vm') {
    throw new Error('Instance type must be container or vm.');
  }

  const template = INCUS_OS_TEMPLATES[params.osTemplate];
  if (!template) {
    throw new Error('Unsupported OS template.');
  }

  const vcpu = Number(params.vcpu);
  if (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > 32) {
    throw new Error('vCPU count must be between 1 and 32.');
  }

  const ramMb = Number(params.ramMb);
  if (!Number.isInteger(ramMb) || ramMb < 256 || ramMb > 131072) {
    throw new Error('RAM must be between 256 MB and 131072 MB.');
  }

  const diskGb = Number(params.diskGb);
  if (!Number.isInteger(diskGb) || diskGb < 5 || diskGb > 2000) {
    throw new Error('Disk size must be between 5 GB and 2000 GB.');
  }

  if (!params.rootPassword || params.rootPassword.length < 6) {
    throw new Error('Root password must be at least 6 characters.');
  }

  if (params.enforceQuota) {
    const quota = getUserQuotaSummary(params.ownerId);
    if (quota.used.vmInstances + 1 > quota.limits.maxVmInstances) {
      throw new Error(
        `Quota exceeded: Maximum LXC/VM instances (${quota.limits.maxVmInstances}) reached.`
      );
    }
    if (quota.used.ramMb + ramMb > quota.limits.maxRamMb) {
      throw new Error(
        `Quota exceeded: Requested ${ramMb} MB RAM exceeds remaining budget (${Math.max(
          0,
          quota.limits.maxRamMb - quota.used.ramMb
        )} MB free).`
      );
    }
    if (quota.used.cpuPercent + vcpu * 100 > quota.limits.maxCpuPercent) {
      throw new Error(
        `Quota exceeded: Requested ${vcpu} vCPU (${vcpu * 100}%) exceeds CPU budget.`
      );
    }
    if (quota.used.diskGb + diskGb > quota.limits.maxDiskGb) {
      throw new Error(
        `Quota exceeded: Requested ${diskGb} GB disk exceeds remaining storage budget.`
      );
    }
  }

  const targetNodeId = params.nodeId ? Number(params.nodeId) : 1;
  const targetNode = getNodeById(targetNodeId);
  if (!targetNode) {
    throw new Error('Selected target VPS node does not exist.');
  }

  const instanceName = slugifyContainerName(displayName, params.type === 'vm' ? 'vm' : 'lxc');
  let status = 'stopped';
  let incusProvisioned = false;
  let note: string | undefined;

  if (targetNode.is_local === 0) {
    const remoteRes = await dispatchNodeCommand<{ status?: string }>(
      targetNode.id,
      'incus:create',
      {
        image: template.image,
        instanceName,
        type: params.type,
        vcpu,
        ramMb,
        diskGb,
      },
      120000
    );
    status = remoteRes.status || 'running';
    incusProvisioned = true;
  } else {
    const incusUp = await isIncusReady();
    if (incusUp) {
      const args = [
        'launch',
        template.image,
        instanceName,
        ...(params.type === 'vm' ? ['--vm'] : []),
        '-c',
        `limits.cpu=${vcpu}`,
        '-c',
        `limits.memory=${ramMb}MB`,
        '-d',
        `root,size=${diskGb}GB`,
      ];

      await execFileAsync('incus', args, { timeout: 120000 });

      try {
        await setRootPasswordInInstance(instanceName, params.rootPassword);
      } catch {
        // Agent may still be booting for VMs
      }

      status = 'running';
      incusProvisioned = true;
    } else {
      note =
        'Instance specification registered in SQLite. Install and initialize Incus on Ubuntu/Debian VPS using install.sh to launch live LXC/KVM instances.';
    }
  }

  const result = db
    .prepare(
      `INSERT INTO vm_instances
       (name, instance_name, type, os_template, vcpu, ram_mb, disk_gb, status, owner_id, node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      displayName,
      instanceName,
      params.type,
      params.osTemplate,
      vcpu,
      ramMb,
      diskGb,
      status,
      params.ownerId,
      targetNode.id
    );

  const instance = db
    .prepare(
      `SELECT vi.*, u.username AS owner_username,
              n.name AS node_name, n.location AS node_location
       FROM vm_instances vi
       LEFT JOIN users u ON u.id = vi.owner_id
       LEFT JOIN nodes n ON n.id = vi.node_id
       WHERE vi.id = ?`
    )
    .get(Number(result.lastInsertRowid)) as VmInstanceRow;

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.create',
    target: instanceName,
    details: `${params.type.toUpperCase()} (${template.label}, ${vcpu} vCPU, ${ramMb}MB, ${diskGb}GB, node=${targetNode.name})`,
    ipAddress: params.ipAddress,
  });

  if (status === 'running') {
    void sendDiscordAlert({
      event: 'start',
      title: `Incus ${params.type.toUpperCase()} Launched: ${displayName}`,
      description: `Instance \`${instanceName}\` (${template.label}) is running on node **${targetNode.name}**.`,
    });
  }

  return { instance, incusProvisioned, note };
}

export async function controlIncusInstance(params: {
  id: number;
  action: 'start' | 'stop' | 'restart' | 'delete';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ status: string; deleted?: boolean }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  if (inst.node_id && inst.node_id !== 1) {
    if (params.action === 'delete') {
      await dispatchNodeCommand(inst.node_id, 'incus:power', {
        instanceName: inst.instance_name,
        action: 'delete',
      }).catch(() => {});

      const vmBackupDir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
      if (fs.existsSync(vmBackupDir)) {
        fs.rmSync(vmBackupDir, { recursive: true, force: true });
      }
      db.transaction(() => {
        db.prepare(`DELETE FROM port_allocations WHERE resource_type = 'incus' AND resource_id = ?`).run(
          inst.id
        );
        db.prepare('DELETE FROM vm_instances WHERE id = ?').run(inst.id);
      })();

      recordAuditLog({
        userId: params.userId,
        username: params.username,
        action: 'incus.delete',
        target: inst.instance_name,
        details: `Deleted remote instance '${inst.name}' (node#${inst.node_id})`,
        ipAddress: params.ipAddress,
      });
      return { status: 'deleted', deleted: true };
    }

    const remoteRes = await dispatchNodeCommand<{ status?: string }>(inst.node_id, 'incus:power', {
      instanceName: inst.instance_name,
      action: params.action,
    });
    const nextStatus = remoteRes.status || (params.action === 'stop' ? 'stopped' : 'running');
    db.prepare('UPDATE vm_instances SET status = ? WHERE id = ?').run(nextStatus, inst.id);

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: `incus.${params.action}`,
      target: inst.instance_name,
      details: `Remote action on node#${inst.node_id}: ${params.action}`,
      ipAddress: params.ipAddress,
    });

    void sendDiscordAlert({
      event: params.action === 'stop' ? 'stop' : 'start',
      title: `Remote Instance ${params.action.toUpperCase()}: ${inst.name}`,
      description: `Instance \`${inst.instance_name}\` (${params.action}) by ${params.username}.`,
    });
    return { status: nextStatus };
  }

  const incusUp = await isIncusReady();

  if (params.action === 'delete') {
    if (incusUp) {
      try {
        await execFileAsync('incus', ['delete', inst.instance_name, '--force'], { timeout: 20000 });
      } catch {
        // Instance may already be gone
      }
    }
    const vmBackupDir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
    if (fs.existsSync(vmBackupDir)) {
      fs.rmSync(vmBackupDir, { recursive: true, force: true });
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM port_allocations WHERE resource_type = 'incus' AND resource_id = ?`).run(
        inst.id
      );
      db.prepare('DELETE FROM vm_instances WHERE id = ?').run(inst.id);
    })();

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: 'incus.delete',
      target: inst.instance_name,
      details: `Deleted instance '${inst.name}'`,
      ipAddress: params.ipAddress,
    });

    return { status: 'deleted', deleted: true };
  }

  if (!incusUp) {
    throw new Error(
      'Incus CLI/daemon is unavailable on this host. Deploy on an Ubuntu/Debian VPS using install.sh to control live LXC/KVM instances.'
    );
  }

  if (params.action === 'start') {
    await execFileAsync('incus', ['start', inst.instance_name], { timeout: 20000 });
  } else if (params.action === 'stop') {
    await execFileAsync('incus', ['stop', inst.instance_name], { timeout: 20000 });
  } else if (params.action === 'restart') {
    await execFileAsync('incus', ['restart', inst.instance_name], { timeout: 30000 });
  }

  const nextStatus = params.action === 'stop' ? 'stopped' : 'running';
  db.prepare('UPDATE vm_instances SET status = ? WHERE id = ?').run(nextStatus, inst.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: `incus.${params.action}`,
    target: inst.instance_name,
    details: `Instance action: ${params.action}`,
    ipAddress: params.ipAddress,
  });

  void sendDiscordAlert({
    event: params.action === 'stop' ? 'stop' : 'start',
    title: `Incus Instance ${params.action.toUpperCase()}: ${inst.name}`,
    description: `Instance \`${inst.instance_name}\` action '${params.action}' executed by ${params.username}.`,
  });

  return { status: nextStatus };
}

export async function reinstallIncusInstance(params: {
  id: number;
  osTemplate: string;
  rootPassword: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ instance: VmInstanceRow; incusProvisioned: boolean; note?: string }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const template = INCUS_OS_TEMPLATES[params.osTemplate];
  if (!template) throw new Error('Unsupported OS template.');

  if (!params.rootPassword || params.rootPassword.length < 6) {
    throw new Error('Root password must be at least 6 characters.');
  }

  const incusUp = await isIncusReady();
  const savedPorts = listPortAllocations('incus', inst.id);
  let incusProvisioned = false;
  let note: string | undefined;

  if (incusUp) {
    try {
      await execFileAsync('incus', ['delete', inst.instance_name, '--force'], { timeout: 30000 });
    } catch {
      // Ignore if container already absent
    }

    const args = [
      'launch',
      template.image,
      inst.instance_name,
      ...(inst.type === 'vm' ? ['--vm'] : []),
      '-c',
      `limits.cpu=${inst.vcpu}`,
      '-c',
      `limits.memory=${inst.ram_mb}MB`,
      '-d',
      `root,size=${inst.disk_gb}GB`,
    ];

    if (inst.ip_address) {
      args.push('-d', `eth0,ipv4.address=${inst.ip_address}`);
    }

    await execFileAsync('incus', args, { timeout: 120000 });

    try {
      await setRootPasswordInInstance(inst.instance_name, params.rootPassword);
    } catch {
      // Ignore transient VM agent startup
    }

    // Re-attach preserved NAT port forwards
    for (const rule of savedPorts) {
      await execFileAsync(
        'incus',
        [
          'config',
          'device',
          'add',
          inst.instance_name,
          rule.device_name,
          'proxy',
          `listen=${rule.protocol}:0.0.0.0:${rule.host_port}`,
          `connect=${rule.protocol}:127.0.0.1:${rule.target_port}`,
        ],
        { timeout: 10000 }
      );
    }

    db.prepare(`UPDATE vm_instances SET os_template = ?, status = 'running' WHERE id = ?`).run(
      params.osTemplate,
      inst.id
    );
    incusProvisioned = true;
  } else {
    db.prepare(`UPDATE vm_instances SET os_template = ? WHERE id = ?`).run(
      params.osTemplate,
      inst.id
    );
    note =
      'OS template updated and port forward rules preserved in SQLite. Connect Incus on Ubuntu/Debian VPS to execute live container wipe & relaunch.';
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.reinstall_os',
    target: inst.instance_name,
    details: `Reinstalled OS template to ${template.label} (kept ${savedPorts.length} port rules)`,
    ipAddress: params.ipAddress,
  });

  const updated = db
    .prepare(
      `SELECT vi.*, u.username AS owner_username
       FROM vm_instances vi
       LEFT JOIN users u ON u.id = vi.owner_id
       WHERE vi.id = ?`
    )
    .get(inst.id) as VmInstanceRow;

  return { instance: updated, incusProvisioned, note };
}

export async function listInstanceSnapshots(
  id: number
): Promise<Array<{ name: string; created_at: string; stateful: boolean }>> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) return [];

  const { stdout } = await execFileAsync('incus', ['snapshot', 'list', inst.instance_name, '--format=json'], {
    timeout: 5000,
  });
  const parsed = JSON.parse(stdout) as Array<{ name: string; created_at: string; stateful?: boolean }>;
  return parsed.map((s) => ({
    name: s.name,
    created_at: s.created_at,
    stateful: Boolean(s.stateful),
  }));
}

export async function createInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Snapshot name must contain only letters, numbers, hyphens, or underscores.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'create', inst.instance_name, params.snapshotName], {
    timeout: 20000,
  });

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_create',
    target: inst.instance_name,
    details: `Created snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export interface IncusBackupRow {
  id: number;
  instance_id: number;
  name: string;
  backup_kind: 'snapshot' | 'archive';
  archive_filename: string | null;
  size_bytes: number;
  backup_type: 'manual' | 'scheduled' | 'pre_restore';
  cloud_provider?: string;
  cloud_key?: string;
  created_by: string;
  created_at: string;
  exists_on_disk?: boolean;
}

function getVmBackupsDir(instanceName: string): string {
  const dir = path.join(getDataDir(), 'vm-backups', instanceName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createIncusBackupOrSnapshot(params: {
  instanceId: number;
  name?: string;
  kind: 'snapshot' | 'archive';
  backupType?: 'manual' | 'scheduled' | 'pre_restore';
  createdBy: string;
  userId?: number | null;
  ipAddress?: string;
  retentionCount?: number;
}): Promise<IncusBackupRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  const backupType = params.backupType || 'manual';
  const rawName = (params.name || '').trim();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const safeName = rawName
    ? rawName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)
    : `${backupType === 'scheduled' ? 'auto' : backupType === 'pre_restore' ? 'pre' : 'snap'}-${stamp}`;

  if (!isValidSnapshotName(safeName)) {
    throw new Error('Snapshot/backup name must contain only letters, numbers, hyphens, or underscores.');
  }

  let archiveFilename: string | null = null;
  let sizeBytes = 0;
  let cloudProvider = 'local';
  let cloudKey = '';

  if (params.kind === 'snapshot') {
    await execFileAsync('incus', ['snapshot', 'create', inst.instance_name, safeName], {
      timeout: 30000,
    });
  } else {
    const dir = getVmBackupsDir(inst.instance_name);
    archiveFilename = `${safeName}-${Date.now()}.tar.gz`;
    const destTarGz = resolveConfinedPath(dir, archiveFilename);
    await execFileAsync('incus', ['export', inst.instance_name, destTarGz], {
      timeout: 300000,
    });
    sizeBytes = fs.statSync(destTarGz).size;

    const cloudCfg = getCloudConfig();
    if (isCloudConfigured(cloudCfg) && cloudCfg.autoUpload) {
      try {
        const uploaded = await uploadBackupToCloud(
          destTarGz,
          `incus/${inst.instance_name}/${archiveFilename}`
        );
        cloudProvider = uploaded.provider;
        cloudKey = uploaded.key;
      } catch {
        // Keep local archive even if cloud offload fails temporarily
      }
    }
  }

  const res = db
    .prepare(
      `INSERT INTO incus_backups
       (instance_id, name, backup_kind, archive_filename, size_bytes, backup_type, created_by, cloud_provider, cloud_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      inst.id,
      safeName,
      params.kind,
      archiveFilename,
      sizeBytes,
      backupType,
      params.createdBy,
      cloudProvider,
      cloudKey
    );

  if (backupType === 'scheduled' && params.retentionCount && params.retentionCount > 0) {
    const oldRows = db
      .prepare(
        `SELECT id, name, backup_kind, archive_filename, cloud_provider, cloud_key FROM incus_backups
         WHERE instance_id = ? AND backup_type = 'scheduled' AND backup_kind = ?
         ORDER BY id DESC LIMIT -1 OFFSET ?`
      )
      .all(inst.id, params.kind, params.retentionCount) as Array<{
      id: number;
      name: string;
      backup_kind: 'snapshot' | 'archive';
      archive_filename: string | null;
      cloud_provider?: string;
      cloud_key?: string;
    }>;

    for (const old of oldRows) {
      if (old.backup_kind === 'snapshot') {
        await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, old.name], {
          timeout: 15000,
        }).catch(() => {});
      } else if (old.archive_filename) {
        try {
          const p = resolveConfinedPath(getVmBackupsDir(inst.instance_name), old.archive_filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // ignore
        }
        if (old.cloud_key) {
          await deleteBackupFromCloud(old.cloud_provider || 'none', old.cloud_key);
        }
      }
      db.prepare('DELETE FROM incus_backups WHERE id = ?').run(old.id);
    }
  }

  recordAuditLog({
    userId: params.userId ?? null,
    username: params.createdBy,
    action:
      backupType === 'scheduled'
        ? 'incus.scheduled_backup'
        : params.kind === 'snapshot'
        ? 'incus.snapshot_create'
        : 'incus.archive_create',
    target: inst.instance_name,
    details: `Created ${backupType} ${params.kind} '${safeName}'${
      cloudProvider !== 'local' ? ` (cloud=${cloudProvider})` : ''
    }`,
    ipAddress: params.ipAddress || '127.0.0.1',
  });

  const created = db
    .prepare('SELECT * FROM incus_backups WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as IncusBackupRow;

  return { ...created, exists_on_disk: true };
}

export async function listIncusBackupsAndSnapshots(instanceId: number): Promise<IncusBackupRow[]> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (incusUp) {
    try {
      const { stdout } = await execFileAsync(
        'incus',
        ['snapshot', 'list', inst.instance_name, '--format=json'],
        { timeout: 5000 }
      );
      const liveSnaps = JSON.parse(stdout) as Array<{ name: string; created_at: string }>;
      const existingSnapNames = new Set(
        (
          db
            .prepare(
              `SELECT name FROM incus_backups WHERE instance_id = ? AND backup_kind = 'snapshot'`
            )
            .all(inst.id) as Array<{ name: string }>
        ).map((r) => r.name)
      );

      for (const s of liveSnaps) {
        if (!existingSnapNames.has(s.name)) {
          db.prepare(
            `INSERT INTO incus_backups (instance_id, name, backup_kind, size_bytes, backup_type, created_by, created_at)
             VALUES (?, ?, 'snapshot', 0, 'manual', 'incus', ?)`
          ).run(inst.id, s.name, s.created_at || new Date().toISOString());
        }
      }
    } catch {
      // Ignore transient snapshot list error
    }
  }

  const rows = db
    .prepare('SELECT * FROM incus_backups WHERE instance_id = ? ORDER BY id DESC')
    .all(inst.id) as IncusBackupRow[];

  const dir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
  return rows.map((r) => {
    let existsOnDisk = true;
    if (r.backup_kind === 'archive' && r.archive_filename) {
      try {
        existsOnDisk = fs.existsSync(resolveConfinedPath(dir, r.archive_filename));
      } catch {
        existsOnDisk = false;
      }
    }
    return { ...r, exists_on_disk: existsOnDisk };
  });
}

export async function restoreIncusBackup(params: {
  instanceId: number;
  backupId: number;
  createPreRestore?: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ restored: boolean; preRestoreSnapshot?: IncusBackupRow }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare('SELECT * FROM incus_backups WHERE id = ? AND instance_id = ?')
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row) throw new Error('Snapshot or backup point not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  let preRestoreSnapshot: IncusBackupRow | undefined;
  if (params.createPreRestore !== false && row.backup_kind === 'snapshot') {
    try {
      preRestoreSnapshot = await createIncusBackupOrSnapshot({
        instanceId: inst.id,
        name: `pre-restore-${Date.now().toString(36)}`,
        kind: 'snapshot',
        backupType: 'pre_restore',
        createdBy: params.username,
        userId: params.userId,
        ipAddress: params.ipAddress,
      });
    } catch {
      // Proceed even if safety snapshot failed
    }
  }

  if (row.backup_kind === 'snapshot') {
    await execFileAsync('incus', ['snapshot', 'restore', inst.instance_name, row.name], {
      timeout: 30000,
    });
  } else {
    if (!row.archive_filename) {
      throw new Error('Archive filename missing.');
    }
    const tarPath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
    if (!fs.existsSync(tarPath)) {
      if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
        await downloadBackupFromCloud(row.cloud_provider, row.cloud_key, tarPath);
      } else {
        throw new Error('Backup archive file is missing on disk.');
      }
    }

    const savedPorts = listPortAllocations('incus', inst.id);
    await execFileAsync('incus', ['delete', inst.instance_name, '--force'], {
      timeout: 30000,
    }).catch(() => {});

    await execFileAsync('incus', ['import', tarPath, inst.instance_name], {
      timeout: 300000,
    });

    for (const rule of savedPorts) {
      await execFileAsync(
        'incus',
        [
          'config',
          'device',
          'add',
          inst.instance_name,
          rule.device_name,
          'proxy',
          `listen=${rule.protocol}:0.0.0.0:${rule.host_port}`,
          `connect=${rule.protocol}:127.0.0.1:${rule.target_port}`,
        ],
        { timeout: 10000 }
      ).catch(() => {});
    }

    await execFileAsync('incus', ['start', inst.instance_name], { timeout: 20000 }).catch(() => {});
    db.prepare(`UPDATE vm_instances SET status = 'running' WHERE id = ?`).run(inst.id);
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: row.backup_kind === 'snapshot' ? 'incus.snapshot_restore' : 'incus.archive_restore',
    target: inst.instance_name,
    details: `Restored point-in-time ${row.backup_kind} '${row.name}'`,
    ipAddress: params.ipAddress,
  });

  return { restored: true, preRestoreSnapshot };
}

export async function uploadIncusBackupToCloud(params: {
  instanceId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<IncusBackupRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare(
      `SELECT * FROM incus_backups WHERE id = ? AND instance_id = ? AND backup_kind = 'archive'`
    )
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row || !row.archive_filename) {
    throw new Error('Only downloadable .tar.gz VM/LXC archives can be uploaded to cloud storage.');
  }

  const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Local archive file must exist on disk to upload to cloud.');
  }

  const uploaded = await uploadBackupToCloud(
    filePath,
    `incus/${inst.instance_name}/${row.archive_filename}`
  );
  db.prepare('UPDATE incus_backups SET cloud_provider = ?, cloud_key = ? WHERE id = ?').run(
    uploaded.provider,
    uploaded.key,
    row.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.archive_cloud_upload',
    target: inst.instance_name,
    details: `Offloaded VM archive '${row.archive_filename}' to ${uploaded.provider.toUpperCase()}`,
    ipAddress: params.ipAddress,
  });

  const updated = db.prepare('SELECT * FROM incus_backups WHERE id = ?').get(row.id) as IncusBackupRow;
  return { ...updated, exists_on_disk: true };
}

export async function deleteIncusBackup(params: {
  instanceId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare('SELECT * FROM incus_backups WHERE id = ? AND instance_id = ?')
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row) throw new Error('Backup or snapshot not found.');

  if (row.backup_kind === 'snapshot') {
    const incusUp = await isIncusReady();
    if (!incusUp) {
      throw new Error('Incus daemon is unavailable on this host.');
    }
    await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, row.name], {
      timeout: 15000,
    }).catch(() => {});
  } else if (row.archive_filename) {
    const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
      await deleteBackupFromCloud(row.cloud_provider, row.cloud_key);
    }
  }

  db.prepare('DELETE FROM incus_backups WHERE id = ?').run(row.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: row.backup_kind === 'snapshot' ? 'incus.snapshot_delete' : 'incus.archive_delete',
    target: inst.instance_name,
    details: `Deleted ${row.backup_kind} '${row.name}'`,
    ipAddress: params.ipAddress,
  });
}

export async function getIncusBackupArchivePath(
  instanceId: number,
  backupId: number
): Promise<{
  filePath: string;
  filename: string;
}> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare(
      `SELECT * FROM incus_backups WHERE id = ? AND instance_id = ? AND backup_kind = 'archive'`
    )
    .get(backupId, inst.id) as IncusBackupRow | undefined;
  if (!row || !row.archive_filename) {
    throw new Error('Backup archive not found.');
  }

  const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
  if (!fs.existsSync(filePath)) {
    if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
      await downloadBackupFromCloud(row.cloud_provider, row.cloud_key, filePath);
    } else {
      throw new Error('Backup archive file is missing on disk.');
    }
  }
  return { filePath, filename: row.archive_filename };
}

export async function restoreInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Invalid snapshot name.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'restore', inst.instance_name, params.snapshotName], {
    timeout: 20000,
  });

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_restore',
    target: inst.instance_name,
    details: `Restored snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export async function deleteInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Invalid snapshot name.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, params.snapshotName], {
    timeout: 15000,
  });

  db.prepare(
    `DELETE FROM incus_backups WHERE instance_id = ? AND name = ? AND backup_kind = 'snapshot'`
  ).run(inst.id, params.snapshotName);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_delete',
    target: inst.instance_name,
    details: `Deleted snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export function listPortAllocations(resourceType: 'minecraft' | 'incus', resourceId: number): PortAllocationRow[] {
  return db
    .prepare(
      `SELECT * FROM port_allocations WHERE resource_type = ? AND resource_id = ? ORDER BY host_port ASC`
    )
    .all(resourceType, resourceId) as PortAllocationRow[];
}

export async function addIncusPortForward(params: {
  id: number;
  hostPort: number;
  targetPort: number;
  protocol: 'tcp' | 'udp';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<PortAllocationRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  if (!isValidPort(params.hostPort)) {
    throw new Error('Host port must be between 1024 and 65535.');
  }
  const targetPort = Number(params.targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Target port must be between 1 and 65535.');
  }
  if (params.protocol !== 'tcp' && params.protocol !== 'udp') {
    throw new Error('Protocol must be tcp or udp.');
  }

  const conflict = db
    .prepare('SELECT id FROM port_allocations WHERE host_port = ? AND protocol = ?')
    .get(params.hostPort, params.protocol);
  if (conflict) {
    throw new Error(`Port ${params.hostPort}/${params.protocol} is already allocated.`);
  }

  const deviceName = `proxy-${params.protocol}-${params.hostPort}`;
  const incusUp = await isIncusReady();

  if (incusUp) {
    await execFileAsync(
      'incus',
      [
        'config',
        'device',
        'add',
        inst.instance_name,
        deviceName,
        'proxy',
        `listen=${params.protocol}:0.0.0.0:${params.hostPort}`,
        `connect=${params.protocol}:127.0.0.1:${targetPort}`,
      ],
      { timeout: 10000 }
    );
  }

  const res = db
    .prepare(
      `INSERT INTO port_allocations (resource_type, resource_id, host_port, target_port, protocol, device_name)
       VALUES ('incus', ?, ?, ?, ?, ?)`
    )
    .run(inst.id, params.hostPort, targetPort, params.protocol, deviceName);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.port_add',
    target: inst.instance_name,
    details: `NAT ${params.hostPort}/${params.protocol} -> ${targetPort}`,
    ipAddress: params.ipAddress,
  });

  return db
    .prepare('SELECT * FROM port_allocations WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as PortAllocationRow;
}

export async function removeIncusPortForward(params: {
  id: number;
  allocationId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const alloc = db
    .prepare(
      `SELECT * FROM port_allocations WHERE id = ? AND resource_type = 'incus' AND resource_id = ?`
    )
    .get(params.allocationId, inst.id) as PortAllocationRow | undefined;
  if (!alloc) throw new Error('Port rule not found.');

  const incusUp = await isIncusReady();
  if (incusUp) {
    try {
      await execFileAsync(
        'incus',
        ['config', 'device', 'remove', inst.instance_name, alloc.device_name],
        { timeout: 10000 }
      );
    } catch {
      // Device may already be removed
    }
  }

  db.prepare('DELETE FROM port_allocations WHERE id = ?').run(alloc.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.port_remove',
    target: inst.instance_name,
    details: `Removed NAT ${alloc.host_port}/${alloc.protocol}`,
    ipAddress: params.ipAddress,
  });
}

export function buildReverseProxyConfig(
  proxy: { domain: string; target_port: number; ssl_enabled: number; engine: 'caddy' | 'nginx' },
  internalIp: string
): string {
  const upstream = `${internalIp}:${proxy.target_port}`;
  if (proxy.engine === 'caddy') {
    return [
      `${proxy.ssl_enabled ? proxy.domain : `http://${proxy.domain}`} {`,
      `  reverse_proxy ${upstream}`,
      `  encode zstd gzip`,
      `}`,
    ].join('\n');
  }
  return [
    `server {`,
    `  listen ${proxy.ssl_enabled ? '443 ssl http2' : '80'};`,
    `  server_name ${proxy.domain};`,
    ...(proxy.ssl_enabled
      ? [
          `  ssl_certificate /etc/letsencrypt/live/${proxy.domain}/fullchain.pem;`,
          `  ssl_certificate_key /etc/letsencrypt/live/${proxy.domain}/privkey.pem;`,
        ]
      : []),
    `  location / {`,
    `    proxy_pass http://${upstream};`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Real-IP $remote_addr;`,
    `    proxy_set_header X-Forwarded-Proto $scheme;`,
    `  }`,
    `}`,
  ].join('\n');
}

export function listReverseProxies(instanceId: number): Array<ReverseProxyRow & { configPreview: string }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  const rows = db
    .prepare('SELECT * FROM reverse_proxies WHERE instance_id = ? ORDER BY id DESC')
    .all(instanceId) as ReverseProxyRow[];
  const ip = inst?.ip_address || '127.0.0.1';
  return rows.map((r) => ({
    ...r,
    configPreview: buildReverseProxyConfig(r, ip),
  }));
}

export async function createReverseProxy(params: {
  instanceId: number;
  domain: string;
  targetPort: number;
  sslEnabled: boolean;
  engine: 'caddy' | 'nginx';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<ReverseProxyRow & { configPreview: string; appliedOnHost: boolean }> {
  if (!isValidDomain(params.domain)) {
    throw new Error('Invalid domain or subdomain format.');
  }
  const targetPort = Number(params.targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Target port must be between 1 and 65535.');
  }
  if (params.engine !== 'caddy' && params.engine !== 'nginx') {
    throw new Error('Proxy engine must be caddy or nginx.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const cleanDomain = params.domain.trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM reverse_proxies WHERE domain = ?').get(cleanDomain);
  if (exists) {
    throw new Error(`Domain '${cleanDomain}' is already routed.`);
  }

  const res = db
    .prepare(
      `INSERT INTO reverse_proxies (instance_id, domain, target_port, ssl_enabled, engine)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(inst.id, cleanDomain, targetPort, params.sslEnabled ? 1 : 0, params.engine);

  const created = db
    .prepare('SELECT * FROM reverse_proxies WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as ReverseProxyRow;

  const configPreview = buildReverseProxyConfig(created, inst.ip_address || '127.0.0.1');
  let appliedOnHost = false;

  try {
    const dir = params.engine === 'caddy' ? '/etc/caddy/conf.d' : '/etc/nginx/conf.d';
    if (fs.existsSync(dir)) {
      fs.writeFileSync(path.join(dir, `fbbahi-${cleanDomain}.conf`), configPreview + '\n', 'utf8');
      if (params.engine === 'caddy') {
        await execFileAsync('systemctl', ['reload', 'caddy'], { timeout: 5000 }).catch(() => {});
      } else {
        await execFileAsync('systemctl', ['reload', 'nginx'], { timeout: 5000 }).catch(() => {});
      }
      appliedOnHost = true;
    }
  } catch {
    appliedOnHost = false;
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.proxy_create',
    target: inst.instance_name,
    details: `${params.engine.toUpperCase()} route ${cleanDomain} -> :${targetPort}`,
    ipAddress: params.ipAddress,
  });

  return { ...created, configPreview, appliedOnHost };
}

export function deleteReverseProxy(params: {
  instanceId: number;
  proxyId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): void {
  const row = db
    .prepare('SELECT * FROM reverse_proxies WHERE id = ? AND instance_id = ?')
    .get(params.proxyId, params.instanceId) as ReverseProxyRow | undefined;
  if (!row) throw new Error('Reverse proxy rule not found.');

  const dir = row.engine === 'caddy' ? '/etc/caddy/conf.d' : '/etc/nginx/conf.d';
  const filePath = path.join(dir, `fbbahi-${row.domain}.conf`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore host file errors
  }

  db.prepare('DELETE FROM reverse_proxies WHERE id = ?').run(row.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.proxy_delete',
    target: `instance#${params.instanceId}`,
    details: `Removed domain route ${row.domain}`,
    ipAddress: params.ipAddress,
  });
}

export async function getIncusInstanceMetrics(id: number): Promise<{
  cpuPercent: number;
  ramUsedMb: number;
  ramLimitMb: number;
  live: boolean;
}> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp || inst.status !== 'running') {
    return {
      cpuPercent: 0,
      ramUsedMb: 0,
      ramLimitMb: inst.ram_mb,
      live: false,
    };
  }

  try {
    const { stdout } = await execFileAsync('incus', ['list', inst.instance_name, '--format=json'], {
      timeout: 3000,
    });
    const parsed = JSON.parse(stdout) as Array<{
      state?: {
        memory?: { usage?: number };
        cpu?: { usage?: number };
      };
    }>;
    const item = parsed[0];
    const ramUsedMb = Math.round((item?.state?.memory?.usage || 0) / (1024 * 1024));
    return {
      cpuPercent: 0,
      ramUsedMb,
      ramLimitMb: inst.ram_mb,
      live: true,
    };
  } catch {
    return {
      cpuPercent: 0,
      ramUsedMb: 0,
      ramLimitMb: inst.ram_mb,
      live: false,
    };
  }
}
